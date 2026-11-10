import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/db/store";
import { DigestStore } from "../src/db/digest-store";
import { DeliveryStore } from "../src/db/delivery-store";
import { ProfileStore } from "../src/profiles";
import { ProcessingWorker } from "../src/worker";
import { scoringHandler } from "../src/scoring-service";
import { draftDigest } from "../src/digest-service";
import {
  deliveryHistory,
  relatedDeliveryHistory,
} from "../src/db/delivery-history";
import { scoreItem, type ScoringInput } from "../src/scoring";

const oldText =
  "robotics baseline research measurement established original finding";
const newText =
  oldText + " " + Array.from({ length: 30 }, (_, i) => `newterm${i}`).join(" ");
const update = {
  ruleVersion: "observed-update-v1" as const,
  sourceId: "source",
  nativeId: "native",
  previousVersionId: 1,
  currentVersionId: 2,
  newTerms: [],
  observedAt: 3000,
};

function fixture(
  snapshot: unknown = {
    scoreSnapshot: {
      id: "score",
      result: { total: 42 },
      provenance: { input: { title: "Old robotics", text: oldText } },
    },
    citations: [
      {
        sourceId: "frozen-source",
        nativeId: "frozen-native",
        url: "https://old.example/story",
      },
    ],
  },
  dbPath = ":memory:",
) {
  const store = new Store(dbPath);
  const deliveries = new DeliveryStore(store.sqlite);
  const freeze = () =>
    new DigestStore(store.sqlite).freeze(
      {
        date: "2026-01-01",
        timezone: "Europe/London",
        subject: "News",
        html: "News",
        text: "News",
        decisionSnapshot: {},
        items: [
          { itemId: "item", groupId: "group", scoreId: "score", snapshot },
        ],
      },
      1000,
    );
  const delivery = deliveries.prepare(
    "2026-01-01",
    "reader@example.test",
    "sender@example.test",
    freeze,
    1000,
  )!;
  const read = (
    title = "Breakthrough robotics",
    text = newText,
    change = update,
  ) => deliveryHistory(store.sqlite, "item", "group", title, text, change);
  return { store, deliveries, delivery, read };
}

test("only accepted frozen evidence affects history, and ambiguous outcomes remain unknown until reconciled", () => {
  const f = fixture();
  try {
    expect(f.read().input).toBeNull();
    const claim = f.deliveries.claim(1000)!;
    expect(f.deliveries.beginSend(claim, 1000)).toBe(true);
    expect(f.read().evidence).toMatchObject({
      state: "unknown",
      reason: "ambiguous_delivery",
    });
    expect(f.deliveries.fail(claim, "ambiguous", 1001)).toBe(true);
    expect(f.read().input).toBeNull();
    f.deliveries.reconcile(f.delivery.id, "accepted", "provider", 2000);
    const result = f.read();
    expect(result.input).toMatchObject({
      sameDevelopment: true,
      meaningfulUpdate: true,
    });
    expect(result.evidence).toMatchObject({
      state: "accepted",
      editionId: f.delivery.digest_id,
      scoreId: "score",
      providerId: "provider",
    });
    expect(f.read("Old robotics", oldText).input?.meaningfulUpdate).toBe(false);
    expect(
      f.read("Breakthrough robotics", newText, { ...update, observedAt: 1000 })
        .input?.meaningfulUpdate,
    ).toBe(false);
    const baseline = {
      itemId: "item",
      title: "robotics",
      text: newText,
      publishedAt: 0,
      now: 4000,
      interests: [],
      analysis: null,
      history: result.input,
      observedUpdateAt: 3000,
    } satisfies ScoringInput;
    expect(
      scoreItem({
        ...baseline,
        history: { sameDevelopment: true, meaningfulUpdate: false },
      }).components.novelty,
    ).toBe(20);
  } finally {
    f.store.close();
  }
});

test("failed deliveries are not accepted and legacy snapshots cannot fabricate an update", () => {
  const f = fixture({ title: "legacy" });
  try {
    const claim = f.deliveries.claim(1000)!;
    f.deliveries.beginSend(claim, 1000);
    f.deliveries.fail(claim, "rejected", 1001);
    expect(f.read().input).toBeNull();
    f.deliveries.reconcile(f.delivery.id, "accepted", "provider", 2000);
    expect(f.read().input).toEqual({
      sameDevelopment: true,
      meaningfulUpdate: false,
      snapshotUnavailable: true,
    });
  } finally {
    f.store.close();
  }
});

test("distinct related developments compare against accepted frozen history without suppressing them", () => {
  const directory = mkdtempSync(join(tmpdir(), "newspulse-related-history-"));
  const longFrozenText = `${oldText} ${Array.from({ length: 2000 }, () => "historicmaterial").join(" ")}`;
  const f = fixture(
    {
      scoreSnapshot: {
        id: "score",
        result: { total: 42 },
        provenance: {
          input: { title: "Breakthrough robotics", text: longFrozenText },
        },
      },
      citations: Array.from({ length: 12 }, (_, index) => ({
        sourceId:
          index === 0 ? `source-${"s".repeat(140)}` : `frozen-source-${index}`,
        nativeId:
          index === 0 ? `native-${"n".repeat(270)}` : `frozen-native-${index}`,
        url:
          index === 0
            ? `https://old.example/${"u".repeat(270)}`
            : `https://old.example/story/${index}`,
      })),
    },
    join(directory, "state.sqlite"),
  );
  try {
    f.store.sqlite
      .query(
        "INSERT INTO items(id,identity,title,ingested_at,published_at) VALUES('new','new-identity','Breakthrough robotics update',4000,3500)",
      )
      .run();
    f.store.sqlite
      .query(
        "INSERT INTO story_groups(id,first_seen) VALUES('group',1000),('new-group',3000)",
      )
      .run();
    f.store.sqlite
      .query(
        "INSERT INTO story_memberships(group_id,item_id,evidence,rule_version,started_at) VALUES('new-group','new','{}','v1',3000)",
      )
      .run();
    f.store.sqlite
      .query(
        "INSERT INTO story_relations(older_group_id,newer_group_id,reason,evidence,rule_version,started_at) VALUES('group','new-group','later_related_development','{\"sharedTerms\":[\"robotics\",\"breakthrough\"]}','specific-development-v1',3000)",
      )
      .run();
    const source = f.store.addSource("https://example.com/feed");
    f.store.sqlite
      .query(
        "INSERT INTO content_versions(item_id,source_id,native_id,title,text,observed_at) VALUES('new',?,'entry','Breakthrough robotics update',?,3500)",
      )
      .run(source.id, newText);
    const claim = f.deliveries.claim(1000)!;
    f.deliveries.beginSend(claim, 1000);
    f.deliveries.sent(claim, "provider", 2000);
    const compared = relatedDeliveryHistory(
      f.store.sqlite,
      "new",
      "new-group",
      "Breakthrough robotics update",
      newText,
      3500,
      4000,
    );
    expect(compared?.input).toBeNull();
    expect(compared?.evidence).toMatchObject({
      comparisonVersion: "related-delivery-v1",
      state: "possible_follow_up",
      editionId: f.delivery.digest_id,
      groupId: "group",
      relationship: { olderGroupId: "group", newerGroupId: "new-group" },
      scoreSnapshotReference: { id: "score", total: 42, eligible: null },
      suppress: false,
    });
    const references = (
      compared?.evidence as {
        frozenSourceReferences: {
          count: number;
          truncated: boolean;
          items: {
            sourceId: string | null;
            nativeId: string | null;
            url: string | null;
            truncatedFields: string[];
          }[];
        };
      }
    ).frozenSourceReferences;
    expect(references).toMatchObject({ count: 12, truncated: true });
    expect(references.items[0]).toEqual({
      sourceId: null,
      nativeId: null,
      url: null,
      truncatedFields: ["sourceId", "nativeId", "url"],
    });
    expect(JSON.stringify(compared?.evidence).length).toBeLessThan(8_000);
    expect(JSON.stringify(compared?.evidence)).not.toContain(
      "historicmaterial",
    );
    f.store.close();
    f.store = new Store(join(directory, "state.sqlite"));
    expect(
      relatedDeliveryHistory(
        f.store.sqlite,
        "new",
        "new-group",
        "Breakthrough robotics update",
        newText,
        3500,
        4000,
      )?.evidence,
    ).toMatchObject({
      state: "possible_follow_up",
      editionId: f.delivery.digest_id,
    });

    f.store.sqlite
      .query(
        "UPDATE story_relations SET evidence=? WHERE newer_group_id='new-group'",
      )
      .run(JSON.stringify({ sharedTerms: ["differentbrand", "9"] }));
    expect(
      relatedDeliveryHistory(
        f.store.sqlite,
        "new",
        "new-group",
        "Breakthrough robotics update",
        newText,
        3500,
        4000,
      )?.evidence,
    ).toMatchObject({
      state: "unknown",
      reason: "relationship_content_conflict",
    });
    f.store.sqlite
      .query(
        "UPDATE story_relations SET evidence=? WHERE newer_group_id='new-group'",
      )
      .run(JSON.stringify({ sharedTerms: ["robotics", "breakthrough"] }));

    f.store.sqlite
      .query("UPDATE deliveries SET status='ambiguous' WHERE digest_id=?")
      .run(f.delivery.digest_id);
    expect(
      relatedDeliveryHistory(
        f.store.sqlite,
        "new",
        "new-group",
        "Breakthrough robotics update",
        newText,
        3500,
        4000,
      )?.evidence,
    ).toMatchObject({ state: "unknown", reason: "ambiguous_delivery" });
    f.store.sqlite
      .query("UPDATE deliveries SET status='sent' WHERE digest_id=?")
      .run(f.delivery.digest_id);
    f.store.sqlite
      .query(
        "UPDATE story_relations SET evidence=? WHERE newer_group_id='new-group'",
      )
      .run(JSON.stringify({ sharedTerms: ["robotics"] }));
    expect(
      relatedDeliveryHistory(
        f.store.sqlite,
        "new",
        "new-group",
        "Breakthrough robotics update",
        newText,
        3500,
        4000,
      )?.evidence,
    ).toMatchObject({ state: "unknown", reason: "weak_relationship_evidence" });
    f.store.sqlite
      .query(
        "UPDATE story_relations SET evidence=? WHERE newer_group_id='new-group'",
      )
      .run(JSON.stringify({ sharedTerms: ["robotics", "breakthrough"] }));
    expect(
      relatedDeliveryHistory(
        f.store.sqlite,
        "new",
        "new-group",
        "Breakthrough robotics update",
        newText,
        1500,
        4000,
      )?.evidence,
    ).toMatchObject({
      state: "unknown",
      reason: "stale_or_uncertain_observation",
    });
    f.store.sqlite
      .query(
        "UPDATE content_versions SET text='different current text' WHERE item_id='new'",
      )
      .run();
    expect(
      relatedDeliveryHistory(
        f.store.sqlite,
        "new",
        "new-group",
        "Breakthrough robotics update",
        newText,
        3500,
        4000,
      )?.evidence,
    ).toMatchObject({
      state: "unknown",
      reason: "stale_or_uncertain_observation",
    });
    f.store.sqlite
      .query("UPDATE content_versions SET text=? WHERE item_id='new'")
      .run(newText);
    f.store.sqlite
      .query(
        "UPDATE story_relations SET ended_at=3999 WHERE newer_group_id='new-group'",
      )
      .run();
    f.store.sqlite
      .query("UPDATE story_memberships SET ended_at=3999 WHERE item_id='new'")
      .run();
    expect(
      relatedDeliveryHistory(
        f.store.sqlite,
        "new",
        "new-group",
        "Breakthrough robotics update",
        newText,
        3500,
        4000,
      )?.evidence,
    ).toMatchObject({
      state: "unknown",
      reason: "relationship_or_membership_ended_after_regrouping",
    });
    f.store.sqlite
      .query(
        "UPDATE story_relations SET ended_at=NULL WHERE newer_group_id='new-group'",
      )
      .run();
    f.store.sqlite
      .query("UPDATE story_memberships SET ended_at=NULL WHERE item_id='new'")
      .run();
    f.store.sqlite
      .query("UPDATE content_versions SET backfilled=1 WHERE item_id='new'")
      .run();
    f.store.sqlite
      .query(
        "INSERT INTO content_versions(item_id,source_id,native_id,title,text,observed_at,backfilled) VALUES('new',?,'later-live-entry','Breakthrough robotics update',?,3600,0)",
      )
      .run(source.id, newText);
    expect(
      relatedDeliveryHistory(
        f.store.sqlite,
        "new",
        "new-group",
        "Breakthrough robotics update",
        newText,
        3500,
        4000,
      )?.evidence,
    ).toMatchObject({
      state: "unknown",
      reason: "earliest_observation_was_backfilled",
    });
  } finally {
    f.store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("score provenance preserves direct ambiguous history instead of replacing it with cross-group evidence", () => {
  const store = new Store(":memory:");
  try {
    const now = 4000;
    const source = store.addSource("https://example.com/feed");
    store.sqlite
      .query(
        "INSERT INTO items(id,identity,title,ingested_at,published_at) VALUES('older','older-id','Old robotics development',1000,900),('candidate','candidate-id','New robotics development',3500,3400)",
      )
      .run();
    store.sqlite
      .query(
        "INSERT INTO content(item_id,text,format) VALUES('older',?,'feed-text'),('candidate',?,'feed-text')",
      )
      .run(oldText, newText);
    store.sqlite
      .query(
        "INSERT INTO content_versions(item_id,source_id,native_id,title,text,observed_at) VALUES('candidate',?,'candidate-native','New robotics development',?,3500)",
      )
      .run(source.id, newText);
    store.sqlite
      .query(
        "INSERT INTO story_groups(id,first_seen) VALUES('older-group',900),('candidate-group',3400)",
      )
      .run();
    store.sqlite
      .query(
        "INSERT INTO story_memberships(group_id,item_id,evidence,rule_version,started_at) VALUES('older-group','older','{}','v1',900),('candidate-group','candidate','{}','v1',3400)",
      )
      .run();
    store.sqlite
      .query(
        "INSERT INTO story_relations(older_group_id,newer_group_id,reason,evidence,rule_version,started_at) VALUES('older-group','candidate-group','later_related_development','{\"sharedTerms\":[\"robotics\",\"development\"]}','specific-development-v1',3400)",
      )
      .run();
    const digests = new DigestStore(store.sqlite);
    const deliveries = new DeliveryStore(store.sqlite);
    const freeze = (
      date: string,
      itemId: string,
      groupId: string,
      text: string,
    ) =>
      digests.freeze(
        {
          date,
          timezone: "Europe/London",
          subject: "News",
          html: "News",
          text: "News",
          decisionSnapshot: {},
          items: [
            {
              itemId,
              groupId,
              scoreId: "score",
              snapshot: {
                scoreSnapshot: {
                  id: "score",
                  provenance: {
                    input: { title: `${itemId} robotics development`, text },
                  },
                },
                citations: [{ sourceId: `frozen-${itemId}` }],
              },
            },
          ],
        },
        date === "2026-01-01" ? 1000 : 3000,
      );
    const accepted = deliveries.prepare(
      "2026-01-01",
      "reader@example.test",
      "sender@example.test",
      () => freeze("2026-01-01", "older", "older-group", oldText),
      1000,
    )!;
    const acceptedClaim = deliveries.claim(1000)!;
    deliveries.beginSend(acceptedClaim, 1000);
    deliveries.sent(acceptedClaim, "accepted-provider", 2000);
    store.sqlite
      .query(
        "INSERT INTO processing_jobs(id,item_id,stage,generation,status,outcome,available_at,created_at,result) VALUES('candidate-extract','candidate','extract',1,'done','extracted',3500,3500,?)",
      )
      .run(JSON.stringify({ status: "extracted", text: newText }));
    store.sqlite
      .query(
        "INSERT INTO processing_jobs(id,item_id,stage,generation,status,available_at,created_at) VALUES('candidate-score','candidate','score',1,'pending',3500,3500)",
      )
      .run();
    const scoreJob = store.claimProcessing("score", now)!;
    const relatedSnapshot = store.scoringSnapshot(scoreJob, now)!;
    expect(relatedSnapshot.provenance.history).toMatchObject({
      state: "unknown",
      relatedComparison: {
        state: "possible_follow_up",
        editionId: accepted.digest_id,
        frozenSourceReferences: {
          items: [{ sourceId: "frozen-older" }],
        },
      },
    });
    const ambiguous = deliveries.prepare(
      "2026-01-02",
      "reader@example.test",
      "sender@example.test",
      () => freeze("2026-01-02", "candidate", "candidate-group", newText),
      3000,
    )!;
    const ambiguousClaim = deliveries.claim(3000)!;
    deliveries.beginSend(ambiguousClaim, 3000);
    deliveries.fail(ambiguousClaim, "ambiguous", 3001);
    const snapshot = store.scoringSnapshot(scoreJob, now)!;
    expect(snapshot.provenance.history).toMatchObject({
      state: "unknown",
      reason: "ambiguous_delivery",
    });
    expect(snapshot.provenance.history).not.toHaveProperty("relatedComparison");
    expect(
      store.completeScore(
        scoreJob,
        {
          inputHash: snapshot.inputHash,
          criteriaVersion: "deterministic-v2",
          provenance: snapshot.provenance,
          result: scoreItem(snapshot.input),
          capturedAt: now,
        },
        now + 1,
      ),
    ).toBe(true);
    expect(accepted.digest_id).not.toBe(ambiguous.digest_id);
  } finally {
    store.close();
  }
});

test("canonical member redirects keep an edition match when its group ID changes", () => {
  const f = fixture({
    scoreSnapshot: {
      id: "score",
      result: { total: 42 },
      provenance: {
        input: { title: "Breakthrough robotics", text: oldText },
      },
    },
    citations: [
      { sourceId: "frozen-source", nativeId: "frozen-native", url: null },
    ],
  });
  try {
    f.store.sqlite
      .query(
        "INSERT INTO items(id,identity,title,ingested_at,published_at) VALUES('item','old-canonical-identity','Breakthrough robotics',1000,900),('canonical-old','canonical-old-identity','Breakthrough robotics',1000,900),('new','new-canonical-identity','Breakthrough robotics update',3500,3400)",
      )
      .run();
    f.store.sqlite
      .query(
        "INSERT INTO item_redirects(old_id,item_id) VALUES('item','canonical-old')",
      )
      .run();
    f.store.sqlite
      .query(
        "INSERT INTO story_groups(id,first_seen) VALUES('replacement-group',900),('new-group',3400)",
      )
      .run();
    f.store.sqlite
      .query(
        "INSERT INTO story_memberships(group_id,item_id,evidence,rule_version,started_at) VALUES('replacement-group','canonical-old','{}','v1',900),('new-group','new','{}','v1',3400)",
      )
      .run();
    f.store.sqlite
      .query(
        "INSERT INTO story_relations(older_group_id,newer_group_id,reason,evidence,rule_version,started_at) VALUES('replacement-group','new-group','later_related_development','{\"sharedTerms\":[\"robotics\",\"breakthrough\"]}','specific-development-v1',3400)",
      )
      .run();
    const source = f.store.addSource("https://example.com/feed");
    f.store.sqlite
      .query(
        "INSERT INTO content_versions(item_id,source_id,native_id,title,text,observed_at) VALUES('new',?,'new-entry','Breakthrough robotics update',?,3500)",
      )
      .run(source.id, newText);
    const claim = f.deliveries.claim(1000)!;
    f.deliveries.beginSend(claim, 1000);
    f.deliveries.sent(claim, "provider", 2000);
    const result = relatedDeliveryHistory(
      f.store.sqlite,
      "new",
      "new-group",
      "Breakthrough robotics update",
      newText,
      3500,
      4000,
    );
    expect(result?.evidence).toMatchObject({
      frozenSourceReferences: {
        items: [
          {
            sourceId: "frozen-source",
            nativeId: "frozen-native",
          },
        ],
      },
    });
    expect(result?.evidence).toMatchObject({
      state: "possible_follow_up",
      groupId: "replacement-group",
      frozenGroupId: "group",
      itemId: "item",
    });
  } finally {
    f.store.close();
  }
});

test("membership history lookup is indexed and bounded to 101 rows", () => {
  const store = new Store(":memory:");
  try {
    store.sqlite
      .query(
        "INSERT INTO items(id,identity,title,ingested_at) VALUES('many-memberships','many-memberships','robotics',1)",
      )
      .run();
    const insertGroup = store.sqlite.query(
      "INSERT INTO story_groups(id,first_seen) VALUES(?,1)",
    );
    const insertMembership = store.sqlite.query(
      "INSERT INTO story_memberships(group_id,item_id,evidence,rule_version,started_at,ended_at) VALUES(?,?,'{}','v1',1,2)",
    );
    store.sqlite.transaction(() => {
      for (let index = 0; index < 101; index++) {
        const groupId = `history-${index}`;
        insertGroup.run(groupId);
        insertMembership.run(groupId, "many-memberships");
      }
    })();
    store.sqlite.exec(
      "INSERT INTO digests(id,edition_date,timezone,subject,html,plain_text,decisions,fingerprint,frozen_at,sealed) VALUES('plan-digest','2026-01-01','UTC','s','','','','f',1,0);" +
        "INSERT INTO digest_items(digest_id,position,item_id,group_id,snapshot) VALUES('plan-digest',0,'many-memberships','history-0','{}'),('plan-digest',1,'other-item','history-0','{}');" +
        "UPDATE digests SET sealed=1 WHERE id='plan-digest';",
    );
    const plan = store.sqlite
      .query<{ detail: string }, [string]>(
        "EXPLAIN QUERY PLAN SELECT count(*) AS count FROM (SELECT 1 FROM story_memberships WHERE item_id=? LIMIT 101)",
      )
      .all("many-memberships")
      .map((row) => row.detail)
      .join(" ");
    expect(plan).toContain("story_members_by_item");
    const groupPlan = store.sqlite
      .query<{ detail: string }, [string]>(
        "EXPLAIN QUERY PLAN SELECT digest_id,position FROM digest_items WHERE group_id=?",
      )
      .all("history-0")
      .map((row) => row.detail)
      .join(" ");
    const itemPlan = store.sqlite
      .query<{ detail: string }, [string]>(
        "EXPLAIN QUERY PLAN SELECT digest_id,position FROM digest_items WHERE item_id=?",
      )
      .all("many-memberships")
      .map((row) => row.detail)
      .join(" ");
    expect(groupPlan).toContain("digest_item_by_group");
    expect(itemPlan).toContain("digest_item_by_item");
    expect(
      relatedDeliveryHistory(
        store.sqlite,
        "many-memberships",
        null,
        "robotics",
        "robotics research",
        null,
        10,
      )?.evidence,
    ).toMatchObject({
      state: "unknown",
      reason: "membership_history_limit",
    });
  } finally {
    store.close();
  }
});

test("high fanout from a related group returns unknown before expanding beyond the work limit", () => {
  const store = new Store(":memory:");
  try {
    store.sqlite.exec(
      "INSERT INTO items(id,identity,title,ingested_at) VALUES('candidate','candidate','robotics',1),('older-anchor','older-anchor','robotics',1);" +
        "INSERT INTO story_groups(id,first_seen) VALUES('newer',1),('older',1);" +
        "INSERT INTO story_memberships(group_id,item_id,evidence,rule_version,started_at) VALUES('newer','candidate','{}','v1',1),('older','older-anchor','{}','v1',1);" +
        "INSERT INTO story_relations(older_group_id,newer_group_id,reason,evidence,rule_version,started_at) VALUES('older','newer','later_related_development','{}','v1',1);",
    );
    const addItem = store.sqlite.query(
      "INSERT INTO items(id,identity,title,ingested_at) VALUES(?,?,?,1)",
    );
    const addMember = store.sqlite.query(
      "INSERT INTO story_memberships(group_id,item_id,evidence,rule_version,started_at) VALUES('older',?,'{}','v1',1)",
    );
    store.sqlite.transaction(() => {
      for (let index = 0; index < 1001; index++) {
        const itemId = `older-${index}`;
        addItem.run(itemId, itemId, "robotics");
        addMember.run(itemId);
      }
    })();
    expect(
      relatedDeliveryHistory(
        store.sqlite,
        "candidate",
        "newer",
        "robotics update",
        "robotics follow up",
        2,
        3,
      )?.evidence,
    ).toMatchObject({
      state: "unknown",
      reason: "related_member_limit",
    });
  } finally {
    store.close();
  }
});

test("redirect aliases with high frozen fanout are counted before historical lookup", () => {
  const store = new Store(":memory:");
  try {
    store.sqlite.exec(
      "INSERT INTO items(id,identity,title,ingested_at) VALUES('candidate','candidate','robotics',1),('canonical','canonical','robotics',1);" +
        "INSERT INTO story_groups(id,first_seen) VALUES('newer','1'),('older',1);" +
        "INSERT INTO story_memberships(group_id,item_id,evidence,rule_version,started_at) VALUES('newer','candidate','{}','v1',1),('older','canonical','{}','v1',1);" +
        "INSERT INTO story_relations(older_group_id,newer_group_id,reason,evidence,rule_version,started_at) VALUES('older','newer','later_related_development','{}','v1',1);" +
        "INSERT INTO digests(id,edition_date,timezone,subject,html,plain_text,decisions,fingerprint,frozen_at,sealed) VALUES('redirect-digest','2026-01-01','UTC','s','','','','f',1,0);",
    );
    const insertItem = store.sqlite.query(
      "INSERT INTO items(id,identity,title,ingested_at) VALUES(?,?,?,1)",
    );
    const insertRedirect = store.sqlite.query(
      "INSERT INTO item_redirects(old_id,item_id) VALUES(?,'canonical')",
    );
    const insert = store.sqlite.query(
      "INSERT INTO digest_items(digest_id,position,item_id,snapshot) VALUES('redirect-digest',?,?, '{}')",
    );
    store.sqlite.transaction(() => {
      for (let position = 0; position < 1001; position++) {
        const alias = `alias-${position}`;
        insertItem.run(alias, alias, "robotics");
        insertRedirect.run(alias);
        insert.run(position, alias);
      }
    })();
    store.sqlite.exec("UPDATE digests SET sealed=1 WHERE id='redirect-digest'");
    expect(
      relatedDeliveryHistory(
        store.sqlite,
        "candidate",
        "newer",
        "robotics update",
        "robotics follow up",
        2,
        3,
      )?.evidence,
    ).toMatchObject({
      state: "unknown",
      reason: "frozen_snapshot_match_limit",
    });
  } finally {
    store.close();
  }
});

test("grouping, scoring and curation retain cross-group history through restart and fence relation-only races", async () => {
  const directory = mkdtempSync(join(tmpdir(), "newspulse-related-e2e-"));
  const dbPath = join(directory, "state.sqlite");
  let store = new Store(dbPath);
  try {
    const day = 86_400_000;
    const candidateAt = Date.now() - 60 * 60 * 1000;
    const acceptedAt = candidateAt - 9 * day;
    const localDate = (time: number) => {
      const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: "Europe/London",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).formatToParts(time);
      const part = (type: string) =>
        parts.find((entry) => entry.type === type)!.value;
      return `${part("year")}-${part("month")}-${part("day")}`;
    };
    const olderText =
      "Acme Atlas robotics launch announced with initial field results and supporting measurements.";
    const newerText =
      "Acme Atlas robotics recall follows field reports after nine days of testing and further reliability measurements.";
    new ProfileStore(store.sqlite).import([
      {
        kind: "interest",
        id: "robotics",
        version: 1,
        description: "Robotics",
        entities: [],
        keywords: ["robotics"],
        priority: 3,
        positive: [],
        negative: [],
        queries: [],
        lifetime: "persistent",
        feedbackRefs: [],
      },
    ]);
    const source = store.addSource("https://example.com/feed");
    store.enqueueDue(acceptedAt, true);
    store.complete(
      store.claim(acceptedAt)!,
      {
        items: [
          {
            nativeId: "old-event",
            title: "Acme Atlas 2 robotics model launches",
            text: olderText,
            publishedAt: acceptedAt - day,
          },
        ],
      },
      acceptedAt,
    );
    const olderId = store.search("robotics")[0]!.id;
    const extraction = store.claimProcessing("extract", acceptedAt)!;
    store.completeProcessing(extraction, "unavailable", acceptedAt + 1);
    store.stories.reconcile(acceptedAt + 2);
    const worker = new ProcessingWorker(store, {
      score: scoringHandler(store),
    });
    await worker.drain("score");
    const older = store.getItem(olderId)!;
    const olderScore = store.scoreHistory(olderId)[0]!;
    const olderGroupId = older.story.current!.group_id;
    const digestStore = new DigestStore(store.sqlite);
    const oldDigest = () =>
      digestStore.freeze(
        {
          date: localDate(acceptedAt),
          timezone: "Europe/London",
          subject: "News",
          html: "News",
          text: "News",
          decisionSnapshot: {},
          items: [
            {
              itemId: olderId,
              groupId: olderGroupId,
              scoreId: olderScore.id,
              snapshot: {
                title: older.title,
                citations: [
                  {
                    sourceId: source.id,
                    nativeId: "old-event",
                    url: "https://example.com/old-event",
                  },
                ],
                scoreSnapshot: {
                  id: olderScore.id,
                  result: olderScore.result,
                  provenance: olderScore.provenance,
                },
              },
            },
          ],
        },
        acceptedAt,
      );
    const deliveries = new DeliveryStore(store.sqlite);
    deliveries.prepare(
      localDate(acceptedAt),
      "reader@example.test",
      "sender@example.test",
      oldDigest,
      acceptedAt,
    );
    const deliveryClaim = deliveries.claim(acceptedAt)!;
    deliveries.beginSend(deliveryClaim, acceptedAt);
    deliveries.sent(deliveryClaim, "accepted-provider", acceptedAt + 1);

    store.enqueueDue(candidateAt, true);
    store.complete(
      store.claim(candidateAt)!,
      {
        items: [
          {
            nativeId: "new-event",
            title: "Acme Atlas 2 robotics model recalled",
            text: newerText,
            publishedAt: candidateAt,
          },
        ],
      },
      candidateAt,
    );
    const candidateId = store
      .search("robotics")
      .find((item) => item.id !== olderId)!.id;
    const candidateExtraction = store.claimProcessing("extract", candidateAt)!;
    store.completeProcessing(
      candidateExtraction,
      "unavailable",
      candidateAt + 1,
    );
    const grouping = store.stories.reconcile(candidateAt + 2);
    expect(grouping.groups).toBe(2);
    expect(
      store.sqlite
        .query("SELECT 1 FROM story_relations WHERE ended_at IS NULL")
        .get(),
    ).not.toBeNull();
    await worker.drain("score");

    store.close();
    store = new Store(dbPath);
    const currentTime = Date.now();
    const date = localDate(currentTime);
    const options = {
      date,
      timezone: "Europe/London",
      now: currentTime,
      minScore: 50,
      maxItems: 10,
      maxPerInterest: 4,
    };
    const afterRestart = draftDigest(store, options);
    expect(afterRestart.status).toBe("ready");
    expect(afterRestart.selected.map((item) => item.itemId)).toContain(
      candidateId,
    );
    expect(
      afterRestart.selected.find((item) => item.itemId === candidateId),
    ).toMatchObject({
      scoreSnapshot: {
        provenance: {
          history: {
            relatedComparison: { state: "possible_follow_up" },
          },
        },
      },
    });

    const scoreId = store.sqlite
      .query<{ id: string }, [string]>(
        "SELECT id FROM processing_jobs WHERE item_id=? AND stage='score' ORDER BY generation DESC LIMIT 1",
      )
      .get(candidateId)!.id;
    store.sqlite
      .query(
        "UPDATE processing_jobs SET status='pending',outcome=NULL WHERE id=?",
      )
      .run(scoreId);
    const raceAt = Date.now();
    const liveClaim = store.claimProcessing("score", raceAt)!;
    const liveSnapshot = store.scoringSnapshot(liveClaim, raceAt)!;
    expect(draftDigest(store, { ...options, now: raceAt }).status).toBe(
      "processing",
    );
    store.sqlite
      .query("UPDATE story_relations SET evidence='{}' WHERE ended_at IS NULL")
      .run();
    store.sqlite
      .query("UPDATE story_grouping_state SET fingerprint='dirty' WHERE id=1")
      .run();
    store.stories.reconcile(raceAt + 1);
    expect(
      store.completeScore(
        liveClaim,
        {
          inputHash: liveSnapshot.inputHash,
          criteriaVersion: "deterministic-v2",
          provenance: liveSnapshot.provenance,
          result: scoreItem(liveSnapshot.input),
          capturedAt: raceAt,
        },
        raceAt + 2,
      ),
    ).toBe(false);
    expect(draftDigest(store, { ...options, now: raceAt + 2 }).status).toBe(
      "processing",
    );
    const restartedWorker = new ProcessingWorker(store, {
      score: scoringHandler(store),
    });
    await restartedWorker.drain("score");
    const refreshedDraft = draftDigest(store, {
      ...options,
      now: Date.now(),
    });
    expect(refreshedDraft.status).toBe("ready");
    expect(refreshedDraft.selected.map((item) => item.itemId)).toContain(
      candidateId,
    );
    expect(
      refreshedDraft.selected.find((item) => item.itemId === candidateId),
    ).toMatchObject({
      scoreSnapshot: {
        provenance: {
          history: {
            relatedComparison: { state: "possible_follow_up" },
          },
        },
      },
    });
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("duplicate group coverage is matched conservatively; oversized history stays unknown", () => {
  const f = fixture();
  try {
    const claim = f.deliveries.claim(1000)!;
    f.deliveries.beginSend(claim, 1000);
    f.deliveries.sent(claim, "provider", 2000);
    f.store.sqlite
      .query(
        "INSERT INTO items(id,identity,title,ingested_at) VALUES('item','identity','Story',1000)",
      )
      .run();
    f.store.sqlite
      .query("INSERT INTO story_groups(id,first_seen) VALUES('group',1000)")
      .run();
    f.store.sqlite
      .query(
        "INSERT INTO story_memberships(group_id,item_id,evidence,rule_version,started_at) VALUES('group','item','{}','v1',1000)",
      )
      .run();
    const duplicate = deliveryHistory(
      f.store.sqlite,
      "other-item",
      "group",
      "Breakthrough robotics",
      newText,
      update,
    );
    expect(duplicate.input).toMatchObject({
      sameDevelopment: true,
      meaningfulUpdate: false,
    });
    const source = f.store.addSource("https://example.com/feed");
    f.store.sqlite
      .query(
        "INSERT INTO items(id,identity,title,ingested_at,published_at) VALUES('other-item','other-identity','Breakthrough robotics',3000,2500)",
      )
      .run();
    f.store.sqlite
      .query(
        "INSERT INTO story_memberships(group_id,item_id,evidence,rule_version,started_at) VALUES('group','other-item','{}','v1',3000)",
      )
      .run();
    f.store.sqlite
      .query(
        "INSERT INTO content_versions(item_id,source_id,native_id,title,text,observed_at) VALUES(?,?,?,?,?,?)",
      )
      .run(
        "other-item",
        source.id,
        "native",
        "Breakthrough robotics",
        newText,
        3000,
      );
    const followup = deliveryHistory(
      f.store.sqlite,
      "other-item",
      "group",
      "Breakthrough robotics",
      newText,
      null,
      4000,
    );
    expect(followup.input?.meaningfulUpdate).toBe(true);
    f.store.sqlite
      .query(
        "UPDATE content_versions SET text='feed snippet' WHERE item_id='other-item'",
      )
      .run();
    f.store.sqlite
      .query(
        "INSERT INTO processing_jobs(id,item_id,stage,generation,status,outcome,origin_source_id,available_at,created_at,result) VALUES('extract-followup','other-item','extract',1,'done','extracted',?,3000,3000,?)",
      )
      .run(source.id, JSON.stringify({ status: "extracted", text: newText }));
    expect(
      deliveryHistory(
        f.store.sqlite,
        "other-item",
        "group",
        "Breakthrough robotics",
        newText,
        null,
        4000,
        1,
      ).input?.meaningfulUpdate,
    ).toBe(true);
    expect(
      deliveryHistory(
        f.store.sqlite,
        "other-item",
        "group",
        "Breakthrough robotics",
        newText,
        null,
        4000,
        2,
      ).input?.meaningfulUpdate,
    ).toBe(false);
    f.store.sqlite
      .query("UPDATE content_versions SET text=? WHERE item_id='other-item'")
      .run(newText);

    f.store.sqlite
      .query("UPDATE items SET published_at=1000 WHERE id='other-item'")
      .run();
    expect(
      deliveryHistory(
        f.store.sqlite,
        "other-item",
        "group",
        "Breakthrough robotics",
        newText,
        null,
        4000,
      ).input?.meaningfulUpdate,
    ).toBe(false);
    f.store.sqlite
      .query("UPDATE items SET published_at=2500 WHERE id='other-item'")
      .run();
    expect(
      deliveryHistory(
        f.store.sqlite,
        "other-item",
        "group",
        "Breakthrough robotics",
        newText,
        null,
        2500,
      ).input?.meaningfulUpdate,
    ).toBe(false);
    f.store.sqlite
      .query("UPDATE story_memberships SET ended_at=4000 WHERE item_id='item'")
      .run();
    expect(
      deliveryHistory(
        f.store.sqlite,
        "other-item",
        "group",
        "Breakthrough robotics",
        newText,
        null,
        5000,
      ).input,
    ).toBeNull();
    f.store.sqlite
      .query("UPDATE story_memberships SET ended_at=NULL WHERE item_id='item'")
      .run();

    const insert = f.store.sqlite.query(
      "INSERT INTO deliveries(id,digest_id,edition_date,recipient,sender,idempotency_key,status,attempts,available_at,provider_id,created_at,updated_at) VALUES(?,?,?,?,?,?,'sent',1,1000,'provider',1000,2000)",
    );
    f.store.sqlite.transaction(() => {
      for (let n = 0; n < 100; n++)
        insert.run(
          `extra-${n}`,
          f.delivery.digest_id,
          "2026-01-01",
          `reader${n}@example.test`,
          "sender@example.test",
          `key-${n}`,
        );
    })();
    expect(f.read().evidence).toMatchObject({
      state: "unknown",
      reason: "history_limit",
    });
    expect(f.read().input).toBeNull();
  } finally {
    f.store.close();
  }
});

test("acceptance invalidates an in-flight score and preserves its frozen provenance through rescore", () => {
  const store = new Store(":memory:");
  try {
    const now = Date.now();
    store.addSource("https://example.com/feed");
    store.enqueueDue(now);
    store.complete(
      store.claim(now)!,
      { items: [{ nativeId: "a", title: "Robotics release", text: oldText }] },
      now,
    );
    const itemId = store.search("robotics")[0]!.id;
    const extraction = store.claimProcessing("extract", now)!;
    store.completeProcessing(extraction, "unavailable", now);
    const job = store.claimProcessing("score", now)!;
    const before = store.scoringSnapshot(job, now)!;
    const digest = new DigestStore(store.sqlite);
    const deliveries = new DeliveryStore(store.sqlite);
    const frozen = () =>
      digest.freeze(
        {
          date: "2026-01-02",
          timezone: "Europe/London",
          subject: "News",
          html: "News",
          text: "News",
          decisionSnapshot: {},
          items: [
            {
              itemId,
              groupId: null,
              scoreId: null,
              snapshot: { scoreSnapshot: { provenance: before.provenance } },
            },
          ],
        },
        now,
      );
    const delivery = deliveries.prepare(
      "2026-01-02",
      "reader@example.test",
      "sender@example.test",
      frozen,
      now,
    )!;
    const claim = deliveries.claim(now)!;
    deliveries.beginSend(claim, now);
    deliveries.sent(claim, "provider", now + 1);
    const staleResult = scoreItem(before.input);
    expect(
      store.completeScore(
        job,
        {
          capturedAt: now,
          inputHash: before.inputHash,
          criteriaVersion: staleResult.criteriaVersion,
          provenance: before.provenance,
          result: staleResult,
        },
        now + 2,
      ),
    ).toBe(false);
    const retry = store.claimProcessing("score", now + 2)!;
    const after = store.scoringSnapshot(retry, now + 2)!;
    expect(after.input.history).toMatchObject({
      sameDevelopment: true,
      meaningfulUpdate: false,
    });
    expect(after.provenance.history).toMatchObject({
      state: "accepted",
      editionId: delivery.digest_id,
    });
    const result = scoreItem(after.input);
    expect(
      store.completeScore(
        retry,
        {
          capturedAt: now + 2,
          inputHash: after.inputHash,
          criteriaVersion: result.criteriaVersion,
          provenance: after.provenance,
          result,
        },
        now + 2,
      ),
    ).toBe(true);
    expect(digest.get("2026-01-02")?.items[0]?.snapshot).toEqual({
      scoreSnapshot: { provenance: before.provenance },
    });
  } finally {
    store.close();
  }
});

test("oversized frozen snapshots stay unknown without entering scoring provenance", () => {
  const f = fixture({ padding: "x".repeat(250_001) });
  try {
    const claim = f.deliveries.claim(1000)!;
    f.deliveries.beginSend(claim, 1000);
    f.deliveries.sent(claim, "provider", 2000);
    expect(f.read().evidence).toMatchObject({
      state: "unknown",
      reason: "historical_snapshot_limit",
      editionId: f.delivery.digest_id,
    });
    expect(f.read().input).toBeNull();
  } finally {
    f.store.close();
  }
});

test("late reconciliation of an older edition cannot replace the newer frozen comparison", () => {
  const store = new Store(":memory:");
  try {
    const deliveries = new DeliveryStore(store.sqlite);
    const freeze =
      (date: string, frozenAt: number, title: string, text: string) => () =>
        new DigestStore(store.sqlite).freeze(
          {
            date,
            timezone: "Europe/London",
            subject: "News",
            html: "News",
            text: "News",
            decisionSnapshot: {},
            items: [
              {
                itemId: "item",
                groupId: null,
                scoreId: null,
                snapshot: {
                  scoreSnapshot: { provenance: { input: { title, text } } },
                },
              },
            ],
          },
          frozenAt,
        );
    const old = deliveries.prepare(
      "2026-01-01",
      "reader@example.test",
      "sender@example.test",
      freeze("2026-01-01", 1000, "Old robotics", oldText),
      1000,
    )!;
    const first = deliveries.claim(1000)!;
    deliveries.beginSend(first, 1000);
    deliveries.fail(first, "ambiguous", 1001);
    const newer = deliveries.prepare(
      "2026-01-02",
      "reader@example.test",
      "sender@example.test",
      freeze("2026-01-02", 2000, "Breakthrough robotics", newText),
      2000,
    )!;
    const second = deliveries.claim(2000)!;
    deliveries.beginSend(second, 2000);
    deliveries.sent(second, "provider-new", 2001);
    deliveries.reconcile(old.id, "accepted", "provider-old", 3000);
    const result = deliveryHistory(
      store.sqlite,
      "item",
      null,
      "Breakthrough robotics",
      newText,
      { ...update, observedAt: 4000 },
      5000,
    );
    expect(result.evidence).toMatchObject({
      state: "accepted",
      editionId: newer.digest_id,
    });
    expect(result.input?.meaningfulUpdate).toBe(false);
  } finally {
    store.close();
  }
});
