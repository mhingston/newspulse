import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Store } from "../src/db/store";
import { DigestStore } from "../src/db/digest-store";
import { runRetention } from "../src/db/retention-store";
import { retentionPolicy, DAY_MS } from "../src/retention";
import { boundedTermDiff, developmentChanges } from "../src/dev-changes";
import { parseFeed } from "../src/adapters/rss";
import { createApp } from "../src/http";
import { migrationsBefore } from "./fixtures";

/**
 * Issue #26 contracts for the append-only development change evidence.
 * Everything here is deterministic: recorded fixture feeds, fixed clocks, no
 * providers and no real email.
 */

const dirs: string[] = [];
function temp() {
  const dir = mkdtempSync(join(tmpdir(), "newspulse-dev-changes-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/** Two weeks of recorded fixture coverage; "last week" ends at week2. */
const DAY_MIDNIGHT = Date.UTC(2026, 10, 9); // week 1 Monday
const week1 = DAY_MIDNIGHT;
const week2 = DAY_MIDNIGHT + 7 * DAY_MS;
const asOf = week2 + 60_000;

const ATLAS_BODY =
  "The Atlas 2 robotics platform ships with a 98.2 composite benchmark result, " +
  "a reproducible evaluation harness, released weights and licensing details " +
  "published in the announcement post.";

const ATLAS_RETRACTION =
  "Acme retracts the Atlas 2 composite benchmark claim in a published " +
  "correction notice; the earlier figures were wrong, the released weights " +
  "remain available, and a corrected number is pending a fresh evaluation.";

const feed = (
  entries: {
    title: string;
    guid: string;
    link?: string;
    text?: string;
    pubDate?: string;
  }[],
) =>
  `<?xml version="1.0"?><rss version="2.0"><channel><title>Feed</title>${entries
    .map(
      (entry) =>
        `<item><guid>${entry.guid}</guid><title>${entry.title}</title>${
          entry.link ? `<link>${entry.link}</link>` : ""
        }${entry.text ? `<description><![CDATA[${entry.text}]]></description>` : ""}${
          entry.pubDate ? `<pubDate>${entry.pubDate}</pubDate>` : ""
        }</item>`,
    )
    .join("")}</channel></rss>`;

const iso = (ms: number) => new Date(ms).toUTCString();

function poll(
  store: Store,
  source: { id: string; url: string },
  xml: string,
  now: number,
) {
  store.enqueueDue(now, true);
  let job = store.claim(now);
  while (job && job.source_id !== source.id) {
    store.complete(job, { items: [] }, now);
    job = store.claim(now);
  }
  store.complete(job!, { items: parseFeed(xml, source.url) }, now + 1);
}

function settle(store: Store, now: number) {
  for (;;) {
    const extract = store.claimProcessing("extract", now);
    if (!extract) break;
    store.completeProcessing(
      extract,
      "extracted",
      now,
      JSON.stringify({
        status: "extracted",
        text: `payload ${extract.item_id}`,
      }),
    );
  }
  const stages = [
    ["group", "grouped"],
    ["analyse", "unavailable"],
    ["score", "scored"],
  ] as const;
  for (const [stage, outcome] of stages) {
    const job = store.claimProcessing(stage, now);
    if (job) store.completeProcessing(job, outcome, now);
  }
}

function events(store: Store, itemId: string) {
  return store.sqlite
    .query<
      {
        id: number;
        item_id: string;
        group_id: string | null;
        kind: string;
        reported_at: number | null;
        event_at: number | null;
        observed_at: number;
        evidence: string;
      },
      [string]
    >("SELECT * FROM story_change_events WHERE item_id=? ORDER BY id")
    .all(itemId)
    .map((row) => ({ ...row, evidence: JSON.parse(row.evidence) as unknown }));
}

describe("append-only change evidence", () => {
  test("new coverage records separated clocks; unchanged re-polls record nothing", () => {
    const store = new Store(join(temp(), "a.sqlite"));
    try {
      const source = store.addSource("https://techwire.example/feed.xml");
      poll(
        store,
        source,
        feed([
          {
            guid: "atlas-2",
            title: "Acme releases Atlas 2 robotics model",
            link: "https://techwire.example/atlas-2",
            text: ATLAS_BODY,
            pubDate: iso(week1),
          },
          {
            guid: "reminder",
            title: "Atlas robot reminder syndicated",
            text: "",
          },
        ]),
        week1,
      );
      const atlas = store.search("benchmark")[0]!.id;
      expect(store.search("reminder").length).toBe(1);
      expect(events(store, atlas)).toHaveLength(1);
      const first = events(store, atlas)[0]!;
      expect(first.kind).toBe("new_coverage");
      expect(first.reported_at).toBe(week1);
      expect(first.event_at).toBeNull();
      expect(first.observed_at).toBeGreaterThan(week1 - 1);
      // The empty-body observation is still cited, with detail unavailable.
      expect(first.evidence).toEqual({
        version: "development-change-v1",
        reason: "new_coverage",
      });

      // A week-two correction reaches the same item: same source, same identity.
      poll(
        store,
        source,
        feed([
          {
            guid: "atlas-2",
            title: "Acme releases Atlas 2 robotics model",
            link: "https://techwire.example/atlas-2",
            text: ATLAS_RETRACTION,
            pubDate: iso(week1),
          },
          {
            guid: "reminder",
            title: "Atlas robot reminder syndicated",
            text: "",
          },
        ]),
        week2,
      );
      const rows = events(store, atlas);
      // The identical unchanged re-poll recorded nothing.
      expect(rows.filter((row) => row.kind === "new_coverage")).toHaveLength(1);
      const correction = rows.filter((row) => row.kind === "content_change");
      expect(correction).toHaveLength(1);
      expect(correction[0]!.observed_at).toBeGreaterThanOrEqual(week2);
      expect(correction[0]!.reported_at).toBe(week1);
      expect(correction[0]!.evidence).toMatchObject({
        titleChanged: false,
        bodyChanged: true,
      });
      const diff = (correction[0]!.evidence as { addedTerms: string[] })
        .addedTerms;
      expect(diff).toContain("retracts");
      // Append-only: nothing is rewritten or deleted. Two events belong to
      // the atlas item (new coverage, then the correction); the unchanged
      // reminder re-poll recorded one new-coverage row in week one and
      // nothing after.
      expect(
        store.sqlite
          .query<{ n: number }, []>(
            "SELECT count(*) n FROM story_change_events",
          )
          .get()!.n,
      ).toBe(3);
      expect(
        events(store, atlas).map((row) => `${row.observed_at}:${row.kind}`),
      ).toEqual([`${week1 + 1}:new_coverage`, `${week2 + 1}:content_change`]);
      // A correction candidate with no declared report date stays unknown:
      // it must never be re-dated from ingestion or observation times.
      expect(boundedTermDiff("alpha beta", "beta gamma delta")).toEqual({
        addedTerms: ["delta", "gamma"],
        removedTerms: ["alpha"],
      });
    } finally {
      store.close();
    }
  });

  test("the development read returns events with citations, uncertainty and expired-detail markers", () => {
    const store = new Store(join(temp(), "b.sqlite"));
    try {
      const source = store.addSource("https://techwire.example/feed.xml");
      poll(
        store,
        source,
        feed([
          {
            guid: "atlas-2",
            title: "Acme releases Atlas 2 robotics model",
            link: "https://techwire.example/atlas-2",
            text: ATLAS_BODY,
            pubDate: iso(week1),
          },
        ]),
        week1,
      );
      store.stories.reconcile(week1);
      const atlas = store.search("benchmark")[0]!.id;
      const groupId = store.stories.forItem(atlas).current!.group_id;

      poll(
        store,
        source,
        feed([
          {
            guid: "atlas-2",
            title: "Acme releases Atlas 2 robotics model",
            link: "https://techwire.example/atlas-2",
            text: ATLAS_RETRACTION,
            pubDate: iso(week1),
          },
          {
            // A second outlet re-publishes the retraction verbatim:
            // identical syndicated text joins the development as new
            // coverage of an unchanged story, not a claimed update.
            guid: "wire-copy",
            title: "Independent report on the new model",
            link: "https://wire.example/atlas-ship",
            text: ATLAS_RETRACTION,
            pubDate: iso(week2),
          },
        ]),
        week2,
      );
      store.stories.reconcile(week2);

      const before = developmentChanges(store, {
        groupId,
        since: week2,
        until: asOf,
      });
      expect(before).not.toBeNull();
      const changes = before!;
      expect(changes.groupId).toBe(groupId);
      expect([...changes.events.map((event) => event.kind)].sort()).toEqual([
        "content_change",
        "new_coverage",
      ]);
      expect(changes.coverage.truncated).toBe(false);
      expect(changes.contentKind).toBe(
        "deterministic_change_evidence_with_untrusted_source_citations",
      );
      expect(changes.uncertainty.factualCertainty).toBeNull();
      expect(changes.uncertainty.modelCompared).toBe(false);
      // The retracted claim is the recorded update; the wire copy is
      // additional coverage of an unchanged story, not a claimed update.
      expect(changes.coverage.membersWithoutChangeEvidence.length).toBe(1);
      const correction = changes.events.find(
        (event) => event.kind === "content_change",
      )!;
      // Events without membership context at record time still resolve to
      // the item's development at read time.
      expect(correction.development?.groupId).toBe(groupId);
      expect(correction.development?.current).toBe(true);
      expect(correction.reportedAt).toBe(week1);
      const extra = changes.events.find(
        (event) => event.kind === "new_coverage",
      )!;
      expect(extra.reportedAt).toBe(week2);
      expect(extra.detailAvailable).toBe(true);
      const citations = changes.coverage.currentMembers;
      expect(citations.length).toBe(2);

      // Settle the changed item's extraction/group/score work, then expire
      // its content: the recorded change evidence keeps its citations and
      // reports that detail is unavailable.
      settle(store, week2 + 2 * DAY_MS);
      const report = runRetention(
        store.sqlite,
        { ...retentionPolicy({}), feedTextDays: 1 },
        week2 + 3 * DAY_MS,
        { dryRun: false, limit: 100 },
      );
      expect(report.purged.feed_text).toBeGreaterThan(0);
      const after = developmentChanges(store, { groupId, since: week2 });
      const afterCorrection = after!.events.find(
        (event) => event.kind === "content_change",
      )!;
      expect(afterCorrection.detailAvailable).toBe(false);
      expect(afterCorrection.detailUnavailableReason).toBe(
        "content_expired_retention_citation_retained",
      );
      expect(afterCorrection.item.title).toContain("Atlas");
      expect(afterCorrection.item.url).toBe("https://techwire.example/atlas-2");
      // The event and its evidence survive verbatim after the purge.
      expect(afterCorrection.evidence).toEqual(correction.evidence);
    } finally {
      store.close();
    }
  });

  test("grouping corrections append evidence, keep the audit trail and never rewrite frozen editions", () => {
    const store = new Store(join(temp(), "c.sqlite"));
    try {
      const source = store.addSource("https://techwire.example/feed.xml");
      poll(
        store,
        source,
        feed([
          {
            guid: "atlas-2",
            title: "Acme releases Atlas 2 robotics model",
            link: "https://techwire.example/atlas-2",
            text: ATLAS_BODY,
            pubDate: iso(week1),
          },
          {
            guid: "twin",
            title: "Atlas 2 robotics model launched by Acme",
            link: "https://wire.example/atlas-2",
            text: ATLAS_BODY,
            pubDate: iso(week1),
          },
        ]),
        week1,
      );
      store.stories.reconcile(week1);
      const atlas = store.search("benchmark")[0]!.id;
      const groupId = store.stories.forItem(atlas).current!.group_id;
      expect(store.stories.group(groupId)!.members).toHaveLength(2);

      // Freeze an edition that cites this development, before any correction.
      const digest = new DigestStore(store.sqlite).freeze(
        {
          date: "2026-11-10",
          timezone: "Europe/London",
          subject: "Briefing",
          html: "<p>Atlas 2</p>",
          text: "Atlas 2",
          decisionSnapshot: { edition: 1 },
          items: [
            {
              itemId: atlas,
              groupId,
              scoreId: null,
              snapshot: { title: "snap" },
            },
          ],
        },
        week1,
      );
      const frozenBefore = store.sqlite
        .query<
          { html: string; fingerprint: string; snapshot: string },
          [string]
        >(
          "SELECT d.html,d.fingerprint,di.snapshot FROM digests d JOIN digest_items di ON di.digest_id=d.id WHERE d.id=?",
        )
        .get(digest.id)!;

      // A later observation diverges: the twin leaves the development.
      poll(
        store,
        source,
        feed([
          {
            guid: "atlas-2",
            title: "Acme releases Atlas 2 robotics model",
            link: "https://techwire.example/atlas-2",
            text: ATLAS_BODY,
            pubDate: iso(week1),
          },
          {
            guid: "twin",
            title: "Quarterly earnings summary reshapes budget",
            link: "https://wire.example/atlas-2",
            text: "The quarterly earnings summary reshapes the departmental budget in the coming fiscal year.",
            pubDate: iso(week2),
          },
        ]),
        week2,
      );
      store.stories.reconcile(week2);

      const twin = store.sqlite
        .query<{ item_id: string }, []>(
          "SELECT item_id FROM item_sources WHERE native_id='twin'",
        )
        .get()!.item_id;
      const twinHistory = store.stories.forItem(twin).history;
      expect(twinHistory).toHaveLength(2);
      // histories read newest first: the superseded membership is ended and
      // the new one is live.
      expect(twinHistory[0]!.ended_at).toBeNull();
      expect(twinHistory[1]!.ended_at).not.toBeNull();
      expect(twinHistory[1]!.group_id).toBe(groupId);
      // The correction ended a membership and left the audit trail intact.
      const corrections = events(store, twin).filter(
        (row) => row.kind === "grouping_corrected",
      );
      expect(corrections).toHaveLength(1);
      expect(corrections[0]!.group_id).toBe(groupId);
      expect(corrections[0]!.evidence).toMatchObject({
        reason: "membership_corrected",
      });
      // The correction names where the item moved (a distinct development).
      expect(
        (corrections[0]!.evidence as { movedToGroupId: string }).movedToGroupId,
      ).not.toBeNull();
      expect(
        (corrections[0]!.evidence as { movedToGroupId: string }).movedToGroupId,
      ).not.toBe(groupId);
      // The original atlas item never gained a correction event: only the
      // item whose membership changed is corrected.
      expect(
        events(store, atlas).filter((row) => row.kind === "grouping_corrected"),
      ).toHaveLength(0);

      // Frozen editions are immutable: bytes and fingerprints are unchanged.
      const frozenAfter = store.sqlite
        .query<
          { html: string; fingerprint: string; snapshot: string },
          [string]
        >("SELECT html,fingerprint FROM digests WHERE id=?")
        .get(digest.id)!;
      expect(frozenAfter.html).toBe(frozenBefore.html);
      expect(frozenAfter.fingerprint).toBe(frozenBefore.fingerprint);
      expect(
        store.sqlite
          .query<{ snapshot: string }, [string]>(
            "SELECT snapshot FROM digest_items WHERE digest_id=?",
          )
          .get(digest.id)!.snapshot,
      ).toBe(frozenBefore.snapshot);
      void digest;
    } finally {
      store.close();
    }
  });
});

describe("change evidence plumbing", () => {
  test("an item identity merge repoints its change evidence", () => {
    const store = new Store(join(temp(), "d.sqlite"));
    try {
      const first = store.addSource("https://a.example/feed.xml");
      poll(
        store,
        first,
        feed([
          {
            guid: "x1",
            title: "Acme releases Atlas 2 robotics model",
            link: "https://cdn.example/atlas-2?utm_source=rss",
            text: ATLAS_BODY,
            pubDate: iso(week1),
          },
        ]),
        week1,
      );
      const atlas = store.search("atlas")[0]!.id;
      expect(events(store, atlas)).toHaveLength(1);
      // A second feed re-publishes the same canonical URL without tracking
      // parameters: both map to one canonical item with two references.
      const second = store.addSource("https://b.example/feed.xml");
      poll(
        store,
        second,
        feed([
          {
            guid: "y9",
            title: "Acme releases Atlas 2 robotics model",
            link: "https://cdn.example/atlas-2",
            text: ATLAS_BODY,
            pubDate: iso(week2),
          },
        ]),
        week2,
      );
      const merged = store.search("atlas");
      expect(merged).toHaveLength(1);
      const mergedId = merged[0]!.id;
      expect(store.getItem(mergedId)!.references.length).toBe(2);
      // Recorded events follow the surviving item.
      expect(events(store, mergedId)).toHaveLength(2);
      void atlas;
    } finally {
      store.close();
    }
  });

  test("a prior-version database migrates without losing recorded items", () => {
    const dir = temp();
    const prior = migrationsBefore(dir, 53);
    const dbPath = join(dir, "prior.sqlite");
    const raw = new Database(dbPath);
    migrate(drizzle(raw), { migrationsFolder: prior });
    raw
      .query(
        "INSERT INTO sources(id,kind,url,title,enabled,poll_seconds) VALUES('src-prior','rss','https://old.example/feed','Old',1,1800)",
      )
      .run();
    raw
      .query(
        "INSERT INTO items(id,identity,url,title,published_at,ingested_at,status) VALUES('item-old','url:https://old.example/a','https://old.example/a','Acme releases Atlas 2 robotics model',?,?,'ingested')",
      )
      .run(week1, week1);
    raw
      .query(
        "INSERT INTO item_sources(item_id,source_id,native_id,url) VALUES('item-old','src-prior','old-1','https://old.example/a')",
      )
      .run();
    raw
      .query(
        "INSERT INTO content(item_id,text) VALUES('item-old','legacy retained body text for the atlas item')",
      )
      .run();
    raw
      .query(
        "INSERT INTO content_versions(item_id,source_id,native_id,title,text,url,observed_at) VALUES('item-old','src-prior','old-1','Acme releases Atlas 2 robotics model','legacy retained body text for the atlas item','https://old.example/a',?)",
      )
      .run(week1);
    raw.close();

    // Opening the current store applies the checked-in migration and keeps
    // historical references intact while new evidence records normally.
    const store2 = new Store(dbPath);
    try {
      expect(
        store2.sqlite
          .query<{ n: number }, []>(
            "SELECT count(*) n FROM sqlite_master WHERE type='table' AND name='story_change_events'",
          )
          .get()!.n,
      ).toBe(1);
      const item = store2.getItem("item-old")!;
      expect(item.title).toContain("Atlas");
      store2.sqlite
        .query(
          "UPDATE story_memberships SET ended_at=ended_at WHERE item_id='item-old'",
        )
        .run();
      expect(developmentChanges(store2, { itemId: "item-old" })).not.toBeNull();
      // Fresh observations still record separated clocks after migration.
      const source = { id: "src-prior", url: "https://old.example/feed" };
      poll(
        store2,
        source,
        feed([
          {
            guid: "old-1",
            title: "Acme releases Atlas 2 robotics model",
            link: "https://old.example/a",
            text: "Acme retracts the Atlas 2 claim in a new correction posted today with a full explanation.",
            pubDate: iso(week2),
          },
        ]),
        week2,
      );
      expect(events(store2, "item-old").map((row) => row.kind)).toEqual([
        "content_change",
      ]);
      expect(
        developmentChanges(store2, { itemId: "item-old" })!.events[0]!
          .reportedAt,
      ).toBe(week2);
    } finally {
      store2.close();
    }
  });
});

describe("MCP surface", () => {
  const token = "dev-changes-test-token-at-least-24-chars";
  test("get_development_changes returns evidence suitable for explanation", async () => {
    const store = new Store(":memory:");
    try {
      const source = store.addSource("https://techwire.example/feed.xml");
      poll(
        store,
        source,
        feed([
          {
            guid: "atlas-2",
            title: "Acme releases Atlas 2 robotics model",
            link: "https://techwire.example/atlas-2",
            text: ATLAS_BODY,
            pubDate: iso(week1),
          },
        ]),
        week1,
      );
      store.stories.reconcile(week1);
      const atlas = store.search("atlas")[0]!.id;
      const groupId = store.stories.forItem(atlas).current!.group_id;

      const app = createApp(store, {
        token,
        allowedHosts: ["127.0.0.1"],
        allowedOrigins: [],
        mcp: {},
      });
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: app.fetch,
      });
      const client = new Client({ name: "dev-changes-test", version: "1" });
      try {
        await client.connect(
          new StreamableHTTPClientTransport(new URL("mcp", server.url), {
            requestInit: { headers: { authorization: `Bearer ${token}` } },
          }),
        );
        const result = await client.callTool({
          name: "get_development_changes",
          arguments: { group_id: groupId },
        });
        expect(result.isError).toBeUndefined();
        const payload = JSON.parse(
          (result.content as { text: string }[])[0]!.text,
        );
        expect(payload.groupId).toBe(groupId);
        expect(payload.coverage.currentMembers.length).toBe(1);
        expect(payload.uncertainty.factualCertainty).toBeNull();
        expect(payload.contentKind).toBe(
          "deterministic_change_evidence_with_untrusted_source_citations",
        );
        const missing = await client.callTool({
          name: "get_development_changes",
          arguments: {},
        });
        expect(missing.isError).toBe(true);
      } finally {
        await client.close();
        server.stop(true);
      }
    } finally {
      store.close();
    }
  });
});
