import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/db/store";
import { DigestStore } from "../src/db/digest-store";
import { DeliveryStore } from "../src/db/delivery-store";
import { DeliveryWorker } from "../src/delivery";
import {
  advanceScoreInvalidation,
  invalidateScores,
} from "../src/db/score-queue";
import {
  DIGEST_ACTIVITY_RETENTION_MS,
  historicalDigestDraft,
  pruneHistoricalDigestActivity,
} from "../src/historical-digest";
import { PublicationWorker } from "../src/publication-worker";

function addScoredItem(store: Store, cutoff: number) {
  store.sqlite
    .exec(`INSERT INTO sources(id,url,title) VALUES('source','https://example.com/feed','Feed');
    INSERT INTO items(id,identity,title,ingested_at) VALUES('item','source:item','Original title',${cutoff - 3 * 86_400_000});
    INSERT INTO processing_jobs(id,stage,item_id,generation,status,available_at,created_at) VALUES('extract','extract','item',1,'done',0,${cutoff - 3 * 86_400_000});
    INSERT INTO story_groups(id,first_seen) VALUES('old-group',${cutoff - 2 * 86_400_000});
    INSERT INTO story_memberships(group_id,item_id,evidence,rule_version,started_at) VALUES('old-group','item','{}','test',${cutoff - 2 * 86_400_000});`);
  store.sqlite
    .query(
      "INSERT INTO story_grouping_events(state,event_at) VALUES('ready',?)",
    )
    .run(Math.min(cutoff, Date.now()));
  store.sqlite
    .query(
      "INSERT INTO content_versions(item_id,source_id,native_id,url,title,text,observed_at) VALUES('item','source','native','https://example.com/original','Original title','Original body',?)",
    )
    .run(cutoff - 40 * 60_000);
  const provenance = {
    input: { title: "Original title", text: "Original body", interests: [] },
    analysis: { result: { summary: "Original summary", uncertainty: [] } },
    history: { state: "unknown", reason: "no_confirmed_delivery" },
    invalidationGeneration: 0,
  };
  store.sqlite
    .query(
      "INSERT INTO item_scores(id,item_id,generation,input_hash,criteria_version,provenance,result,created_at) VALUES('score-old','item',1,'old-hash','v1',?,?,?)",
    )
    .run(
      JSON.stringify(provenance),
      JSON.stringify({
        total: 90,
        eligible: true,
        reasons: ["interest:robots@1"],
      }),
      cutoff - 20 * 60_000,
    );
  store.sqlite
    .query(
      "INSERT INTO score_validity_events(item_id,score_id,kind,event_at,valid_until) VALUES('item','score-old','score_valid',?,NULL)",
    )
    .run(cutoff - 20 * 60_000);
}

test("historical curation uses only state available at its London DST deadline", async () => {
  const store = new Store(":memory:");
  try {
    const cutoff = Date.parse("2026-03-29T05:00:00Z");
    addScoredItem(store, cutoff);
    store.sqlite
      .query("UPDATE digest_history_state SET evidence_from=0 WHERE id=1")
      .run();

    // A correction, new score and regrouping happen after the missed deadline.
    store.sqlite
      .query("UPDATE items SET title='Corrected title' WHERE id='item'")
      .run();
    store.sqlite
      .query(
        "INSERT INTO content_versions(item_id,source_id,native_id,url,title,text,observed_at) VALUES('item','source','native','https://example.com/corrected','Corrected title','Corrected body',?)",
      )
      .run(cutoff + 30 * 60_000);
    store.sqlite
      .query(
        "UPDATE story_memberships SET ended_at=? WHERE item_id='item' AND ended_at IS NULL",
      )
      .run(cutoff + 30 * 60_000);
    store.sqlite.exec(
      "INSERT INTO story_groups(id,first_seen) VALUES('new-group',1)",
    );
    store.sqlite
      .query(
        "INSERT INTO story_memberships(group_id,item_id,evidence,rule_version,started_at) VALUES('new-group','item','{}','test',?)",
      )
      .run(cutoff + 30 * 60_000);
    const updated = {
      input: {
        title: "Corrected title",
        text: "Corrected body",
        interests: [],
      },
      analysis: { result: { summary: "Corrected summary", uncertainty: [] } },
      history: { state: "unknown", reason: "no_confirmed_delivery" },
      invalidationGeneration: 0,
    };
    store.sqlite
      .query(
        "INSERT INTO item_scores(id,item_id,generation,input_hash,criteria_version,provenance,result,created_at) VALUES('score-new','item',1,'new-hash','v1',?,?,?)",
      )
      .run(
        JSON.stringify(updated),
        JSON.stringify({
          total: 99,
          eligible: true,
          reasons: ["interest:robots@1"],
        }),
        cutoff + 35 * 60_000,
      );

    const draft = historicalDigestDraft(store, {
      date: "2026-03-29",
      timezone: "Europe/London",
      now: cutoff,
      minScore: 50,
      maxItems: 10,
      maxPerInterest: 4,
    });
    expect(draft.status).toBe("ready");
    if (draft.status !== "ready") return;
    expect(draft.selected[0]).toMatchObject({
      scoreId: "score-old",
      title: "Original title",
      groupId: "old-group",
    });
  } finally {
    store.close();
  }
});

test("catch-up across the London spring clock change freezes once and sends one idempotent outbox", async () => {
  const directory = mkdtempSync(
    join(tmpdir(), "newspulse-historical-restart-"),
  );
  const path = join(directory, "db.sqlite");
  let store: Store | undefined = new Store(path);
  const calls: string[] = [];
  try {
    const asOf = Date.parse("2026-03-29T05:00:00Z");
    addScoredItem(store, asOf);
    store.sqlite
      .query("UPDATE digest_history_state SET evidence_from=0 WHERE id=1")
      .run();
    store.sqlite
      .query(
        "INSERT INTO publication_schedule_state(id,next_date,timezone,hour,minute,updated_at) VALUES(1,'2026-03-28','Europe/London',6,0,?)",
      )
      .run(asOf);
    store.close();
    store = undefined;
    store = new Store(path);
    const deliveries = new DeliveryStore(store.sqlite);
    const now = Date.parse("2026-03-30T05:00:00Z");
    const sender = new DeliveryWorker(
      deliveries,
      {
        send: async (_message, key) => {
          calls.push(key);
          return { id: "provider-1" };
        },
      },
      () => now,
    );
    const worker = new PublicationWorker(store, deliveries, sender, {
      timezone: "Europe/London",
      hour: 6,
      minute: 0,
      from: "sender@example.com",
      to: "reader@example.com",
    });
    await worker.tick(now);
    await worker.tick(now);
    expect(new DigestStore(store.sqlite).get("2026-03-28")).toBeNull();
    expect(
      new DigestStore(store.sqlite).get("2026-03-29")?.plain_text,
    ).toContain("Original title");
    expect(deliveries.list()).toHaveLength(1);
    expect(deliveries.list()[0]?.status).toBe("sent");
    expect(calls).toHaveLength(1);
    expect(
      store.sqlite
        .query(
          "SELECT date,status FROM publication_schedule_history ORDER BY date",
        )
        .all(),
    ).toEqual([
      { date: "2026-03-28", status: "empty" },
      { date: "2026-03-29", status: "prepared" },
    ]);
  } finally {
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("pre-upgrade windows and incomplete processing are reported unavailable", () => {
  const store = new Store(":memory:");
  try {
    const cutoff = Date.now();
    addScoredItem(store, cutoff);
    const options = {
      date: new Intl.DateTimeFormat("en-CA", {
        timeZone: "Europe/London",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date(cutoff)),
      timezone: "Europe/London",
      now: cutoff,
      minScore: 50,
      maxItems: 10,
      maxPerInterest: 4,
    };
    expect(historicalDigestDraft(store, options)).toMatchObject({
      status: "unavailable",
      reason: "activity_history_not_complete_since_upgrade",
    });
    store.sqlite
      .query("UPDATE digest_history_state SET evidence_from=? WHERE id=1")
      .run(cutoff - 2 * 86_400_000);
    store.sqlite.query("DELETE FROM item_scores").run();
    expect(historicalDigestDraft(store, options)).toMatchObject({
      status: "unavailable",
      reason: "processing_incomplete_at_historical_cutoff",
    });
  } finally {
    store.close();
  }
});

test("historical editions defer when an item-specific invalidation predates cutoff", () => {
  const store = new Store(":memory:");
  try {
    const cutoff = Date.now();
    addScoredItem(store, cutoff);
    store.sqlite
      .query("UPDATE digest_history_state SET evidence_from=0 WHERE id=1")
      .run();
    store.sqlite
      .query(
        "INSERT INTO score_validity_events(item_id,score_id,kind,event_at) VALUES('item',NULL,'item_invalidation',?)",
      )
      .run(cutoff - 1);
    const draft = historicalDigestDraft(store, {
      date: "2026-06-01",
      timezone: "Europe/London",
      now: cutoff,
      minScore: 50,
      maxItems: 10,
      maxPerInterest: 4,
    });
    expect(draft).toMatchObject({
      status: "unavailable",
      reason: "processing_incomplete_at_historical_cutoff",
    });
  } finally {
    store.close();
  }
});

test("historical editions use the recorded refresh deadline after mutable refresh changes", () => {
  const store = new Store(":memory:");
  try {
    const cutoff = Date.now();
    addScoredItem(store, cutoff);
    store.sqlite
      .query("UPDATE digest_history_state SET evidence_from=0 WHERE id=1")
      .run();
    store.sqlite
      .query(
        "UPDATE score_validity_events SET valid_until=? WHERE score_id='score-old'",
      )
      .run(cutoff - 1);
    store.sqlite.exec("DELETE FROM score_refresh");
    const draft = historicalDigestDraft(store, {
      date: "2026-06-01",
      timezone: "Europe/London",
      now: cutoff,
      minScore: 50,
      maxItems: 10,
      maxPerInterest: 4,
    });
    expect(draft).toMatchObject({
      status: "unavailable",
      reason: "processing_incomplete_at_historical_cutoff",
    });
  } finally {
    store.close();
  }
});

test("historical selection follows the latest valid event when score rows are reused A to B to A", () => {
  const store = new Store(":memory:");
  try {
    const cutoff = Date.now();
    addScoredItem(store, cutoff);
    store.sqlite
      .query("UPDATE digest_history_state SET evidence_from=0 WHERE id=1")
      .run();
    store.sqlite
      .query(
        `INSERT INTO item_scores(id,item_id,generation,input_hash,criteria_version,provenance,result,created_at)
         SELECT 'score-b',item_id,generation,'hash-b',criteria_version,provenance,
           json_set(result,'$.total',20),created_at+1 FROM item_scores WHERE id='score-old'`,
      )
      .run();
    store.sqlite
      .query(
        "INSERT INTO score_validity_events(item_id,score_id,kind,event_at) VALUES('item','score-b','score_valid',?)",
      )
      .run(cutoff - 20);
    store.sqlite
      .query(
        "INSERT INTO score_validity_events(item_id,score_id,kind,event_at) VALUES('item','score-old','score_valid',?)",
      )
      .run(cutoff - 10);
    const draft = historicalDigestDraft(store, {
      date: "2026-06-01",
      timezone: "Europe/London",
      now: cutoff,
      minScore: 50,
      maxItems: 10,
      maxPerInterest: 4,
    });
    expect(draft.status).toBe("ready");
    if (draft.status === "ready")
      expect(draft.selected[0]?.scoreId).toBe("score-old");
  } finally {
    store.close();
  }
});

test("an expired latest score event does not fall back to an older score", () => {
  const store = new Store(":memory:");
  try {
    const cutoff = Date.now();
    addScoredItem(store, cutoff);
    store.sqlite
      .query("UPDATE digest_history_state SET evidence_from=0 WHERE id=1")
      .run();
    store.sqlite
      .query(
        `INSERT INTO item_scores(id,item_id,generation,input_hash,criteria_version,provenance,result,created_at)
         SELECT 'score-b',item_id,generation,'hash-b',criteria_version,provenance,result,created_at+1 FROM item_scores WHERE id='score-old'`,
      )
      .run();
    store.sqlite
      .query(
        "INSERT INTO score_validity_events(item_id,score_id,kind,event_at) VALUES('item','score-b','score_valid',?)",
      )
      .run(cutoff - 20);
    store.sqlite
      .query(
        "INSERT INTO score_validity_events(item_id,score_id,kind,event_at,valid_until) VALUES('item','score-b','score_valid',?,?)",
      )
      .run(cutoff - 10, cutoff - 1);
    const draft = historicalDigestDraft(store, {
      date: "2026-06-01",
      timezone: "Europe/London",
      now: cutoff,
      minScore: 50,
      maxItems: 10,
      maxPerInterest: 4,
    });
    expect(draft).toMatchObject({
      status: "unavailable",
      reason: "processing_incomplete_at_historical_cutoff",
    });
  } finally {
    store.close();
  }
});

test("historical score selection waits while a global invalidation pass is pending", () => {
  const store = new Store(":memory:");
  try {
    const cutoff = Date.now();
    addScoredItem(store, cutoff);
    store.sqlite
      .query("UPDATE digest_history_state SET evidence_from=0 WHERE id=1")
      .run();
    invalidateScores(store.sqlite, cutoff - 10);
    const draft = historicalDigestDraft(store, {
      date: "2026-06-01",
      timezone: "Europe/London",
      now: cutoff,
      minScore: 50,
      maxItems: 10,
      maxPerInterest: 4,
    });
    expect(draft).toMatchObject({
      status: "unavailable",
      reason: "global_score_invalidation_pending_at_historical_cutoff",
    });
  } finally {
    store.close();
  }
});

test("historical curation refuses a cutoff with dirty grouping evidence", () => {
  const store = new Store(":memory:");
  try {
    const cutoff = Date.now();
    addScoredItem(store, cutoff);
    store.sqlite
      .query(
        "INSERT INTO story_grouping_events(state,event_at) VALUES('dirty',?)",
      )
      .run(cutoff);
    store.sqlite
      .query("UPDATE digest_history_state SET evidence_from=0 WHERE id=1")
      .run();
    expect(
      historicalDigestDraft(store, {
        date: "2026-06-01",
        timezone: "Europe/London",
        now: cutoff,
        minScore: 50,
        maxItems: 10,
        maxPerInterest: 4,
      }),
    ).toMatchObject({
      status: "unavailable",
      reason: "story_grouping_incomplete_at_historical_cutoff",
    });
  } finally {
    store.close();
  }
});

test("post-cutoff merges of inactive story members make group citations unavailable", () => {
  const store = new Store(":memory:");
  try {
    const cutoff = Date.now() - 1_000;
    addScoredItem(store, cutoff);
    store.sqlite.exec(`INSERT INTO items(id,identity,title,ingested_at) VALUES
      ('member','member','Other member',${cutoff - 3 * 86_400_000}),
      ('winner','winner','Merge winner',${cutoff - 3 * 86_400_000});
      INSERT INTO content_versions(item_id,source_id,native_id,url,title,text,observed_at)
        VALUES('member','source','member-native','https://example.com/member','Member','Member body',${cutoff - 40 * 60_000});
      INSERT INTO story_memberships(group_id,item_id,evidence,rule_version,started_at)
        VALUES('old-group','member','{}','test',${cutoff - 2 * 86_400_000});`);
    store.sqlite
      .query("UPDATE digest_history_state SET evidence_from=0 WHERE id=1")
      .run();
    store.sqlite
      .query(
        "INSERT INTO item_redirects(item_id,old_id) VALUES('winner','member')",
      )
      .run();
    expect(
      historicalDigestDraft(store, {
        date: "2026-06-01",
        timezone: "Europe/London",
        now: cutoff,
        minScore: 50,
        maxItems: 10,
        maxPerInterest: 4,
      }),
    ).toMatchObject({
      status: "unavailable",
      reason: "identity_merged_after_historical_cutoff",
    });
  } finally {
    store.close();
  }
});

test("purged feed text keeps its citation reconstructible in historical digests", () => {
  const store = new Store(":memory:");
  try {
    const cutoff = Date.now() - 1_000;
    addScoredItem(store, cutoff);
    store.sqlite
      .query("UPDATE digest_history_state SET evidence_from=0 WHERE id=1")
      .run();
    store.sqlite
      .query(
        "UPDATE content_versions SET text='',purged_at=? WHERE item_id='item'",
      )
      .run(cutoff - 1);
    store.sqlite
      .query("UPDATE content SET text='',purged_at=? WHERE item_id='item'")
      .run(cutoff - 1);
    const draft = historicalDigestDraft(store, {
      date: "2026-06-01",
      timezone: "Europe/London",
      now: cutoff,
      minScore: 50,
      maxItems: 10,
      maxPerInterest: 4,
    });
    expect(draft).toMatchObject({
      status: "ready",
      decisionEvidence: [
        {
          evidence: {
            citations: [
              {
                sourceId: "source",
                nativeId: "native",
                url: "https://example.com/original",
              },
            ],
          },
        },
      ],
    });
  } finally {
    store.close();
  }
});

test("global invalidation sweep records interleaved per-item score invalidation", () => {
  const store = new Store(":memory:");
  try {
    const cutoff = Date.now();
    addScoredItem(store, cutoff);
    store.sqlite
      .query("UPDATE digest_history_state SET evidence_from=0 WHERE id=1")
      .run();
    store.sqlite
      .exec(`INSERT INTO processing_jobs(id,stage,item_id,generation,status,available_at,created_at,outcome)
      VALUES('score-job','score','item',1,'done',0,${cutoff - 1},'scored')`);
    invalidateScores(store.sqlite, cutoff - 30);
    store.sqlite
      .query(
        "INSERT INTO item_scores(id,item_id,generation,input_hash,criteria_version,provenance,result,created_at) SELECT 'score-interleaved',item_id,generation,'hash-interleaved',criteria_version,provenance,result,? FROM item_scores WHERE id='score-old'",
      )
      .run(cutoff - 20);
    store.sqlite
      .query(
        "INSERT INTO score_validity_events(item_id,score_id,kind,event_at) VALUES('item','score-interleaved','score_valid',?)",
      )
      .run(cutoff - 20);
    advanceScoreInvalidation(store.sqlite, cutoff - 10);
    const draft = historicalDigestDraft(store, {
      date: "2026-06-01",
      timezone: "Europe/London",
      now: cutoff,
      minScore: 50,
      maxItems: 10,
      maxPerInterest: 4,
    });
    expect(draft).toMatchObject({
      status: "unavailable",
      reason: "processing_incomplete_at_historical_cutoff",
    });
  } finally {
    store.close();
  }
});

test("historical editions wait retryably for prior delivery reconciliation", () => {
  const store = new Store(":memory:");
  try {
    const cutoff = Date.now() + 1_000;
    addScoredItem(store, cutoff);
    store.sqlite
      .query("UPDATE digest_history_state SET evidence_from=0 WHERE id=1")
      .run();
    store.sqlite
      .exec(`INSERT INTO digests(id,edition_date,timezone,subject,html,plain_text,decisions,fingerprint,frozen_at,sealed)
      VALUES('prior','2026-06-01','Europe/London','subject','','','[]','fingerprint',${cutoff},0);
      INSERT INTO items(id,identity,title,ingested_at) VALUES('alias','alias','Alias',${cutoff - 3 * 86_400_000});
      INSERT INTO item_redirects(item_id,old_id) VALUES('item','alias');
      INSERT INTO digest_items(digest_id,position,item_id,snapshot) VALUES('prior',0,'alias','{}');
      INSERT INTO deliveries(id,digest_id,edition_date,recipient,sender,idempotency_key,status,available_at,created_at,updated_at)
      VALUES('delivery','prior','2026-06-01','a@example.com','b@example.com','key','pending',${cutoff},${cutoff},${cutoff});`);
    store.sqlite
      .query(
        `UPDATE item_scores SET provenance=json_set(provenance,'$.history.state','unknown',
         '$.history.reason','ambiguous_delivery','$.history.editionId','prior') WHERE id='score-old'`,
      )
      .run();
    const draft = historicalDigestDraft(store, {
      date: "2026-06-02",
      timezone: "Europe/London",
      now: cutoff,
      minScore: 50,
      maxItems: 10,
      maxPerInterest: 4,
    });
    expect(draft).toMatchObject({
      status: "blocked",
      reason: expect.stringContaining(
        "prior_delivery_requires_reconciliation:item",
      ),
    });
    store.sqlite
      .query("UPDATE deliveries SET status='failed' WHERE id='delivery'")
      .run();
    const reconciled = historicalDigestDraft(store, {
      date: "2026-06-02",
      timezone: "Europe/London",
      now: cutoff,
      minScore: 50,
      maxItems: 10,
      maxPerInterest: 4,
    });
    expect(reconciled.status).toBe("ready");
    if (reconciled.status === "ready")
      expect(reconciled.selected.map((item) => item.itemId)).toEqual(["item"]);
  } finally {
    store.close();
  }
});

test("activity retention is bounded and its evidence floor advances", () => {
  const store = new Store(":memory:");
  try {
    const now = Date.now();
    store.sqlite.exec(`
      UPDATE digest_history_state SET evidence_from=${now - DIGEST_ACTIVITY_RETENTION_MS} WHERE id=1;
      INSERT INTO items(id,identity,title,ingested_at) VALUES
        ('old','old','Old',${now - 1_000}),('recent','recent','Recent',${now - 1_000});
      INSERT INTO digest_activity_events(item_id,activity_at,kind) VALUES
        ('old',${now - 365 * 86_400_000},'ingested'),
        ('recent',${now - 360 * 86_400_000},'ingested'),
        ('old',${now - DIGEST_ACTIVITY_RETENTION_MS - 86_400_000},'ingested');
    `);
    expect(
      store.sqlite
        .query<{ n: number }, [number]>(
          "SELECT count(*) AS n FROM digest_activity_events WHERE activity_at<?",
        )
        .get(now - DIGEST_ACTIVITY_RETENTION_MS)?.n,
    ).toBe(0);
    const pruneAt = now + 2 * 86_400_000;
    expect(pruneHistoricalDigestActivity(store, pruneAt)).toBe(1);
    const retained = store.sqlite
      .query<{ activity_at: number }, []>(
        "SELECT activity_at FROM digest_activity_events ORDER BY activity_at",
      )
      .all();
    expect(retained).toHaveLength(3);
    expect(
      retained.every(
        (row) => row.activity_at >= pruneAt - DIGEST_ACTIVITY_RETENTION_MS,
      ),
    ).toBe(true);
    expect(
      store.sqlite
        .query("SELECT evidence_from FROM digest_history_state WHERE id=1")
        .get(),
    ).toEqual({
      evidence_from: pruneAt - DIGEST_ACTIVITY_RETENTION_MS,
    });
  } finally {
    store.close();
  }
});

test("post-cutoff identity merges are diagnosed instead of rewriting old identity", () => {
  const store = new Store(":memory:");
  try {
    const cutoff = Date.now() - 60_000;
    addScoredItem(store, cutoff);
    store.sqlite
      .query("UPDATE digest_history_state SET evidence_from=? WHERE id=1")
      .run(cutoff - 2 * 86_400_000);
    store.sqlite.exec(
      "INSERT INTO items(id,identity,title,ingested_at) VALUES('winner','winner','Winner',1)",
    );
    store.sqlite
      .query(
        "UPDATE digest_activity_events SET item_id='winner' WHERE item_id='item'",
      )
      .run();
    store.sqlite
      .query(
        "INSERT INTO item_redirects(old_id,item_id) VALUES('item','winner')",
      )
      .run();
    const draft = historicalDigestDraft(store, {
      date: new Intl.DateTimeFormat("en-CA", {
        timeZone: "Europe/London",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date(cutoff)),
      timezone: "Europe/London",
      now: cutoff,
      minScore: 50,
      maxItems: 10,
      maxPerInterest: 4,
    });
    expect(draft).toMatchObject({
      status: "unavailable",
      reason: "identity_merged_after_historical_cutoff",
    });
  } finally {
    store.close();
  }
});

test("backup and restore preserve historical events, citations, FTS and integrity", () => {
  const directory = mkdtempSync(join(tmpdir(), "newspulse-digest-history-"));
  const sourcePath = join(directory, "source.sqlite");
  const backupPath = join(directory, "backup.sqlite");
  let store: Store | undefined = new Store(sourcePath);
  let restored: Store | undefined;
  try {
    const now = Date.now();
    const source = store.addSource("https://example.com/feed");
    store.enqueueDue(now);
    store.complete(
      store.claim(now)!,
      {
        items: [
          {
            nativeId: "history",
            title: "Historical search",
            text: "searchable provenance",
          },
        ],
      },
      now + 1,
    );
    expect(
      store.sqlite
        .query("SELECT count(*) AS n FROM digest_activity_events")
        .get(),
    ).toMatchObject({ n: 2 });
    expect(
      store.getItem(store.search("searchable")[0]!.id)?.references[0],
    ).toMatchObject({ source_id: source.id, native_id: "history" });
    store.backup(backupPath);
    store.close();
    store = undefined;
    restored = new Store(backupPath);
    expect(restored.search("searchable")[0]?.title).toBe("Historical search");
    expect(
      restored.sqlite
        .query("SELECT count(*) AS n FROM digest_activity_events")
        .get(),
    ).toMatchObject({ n: 2 });
    expect(restored.sqlite.query("PRAGMA integrity_check").get()).toEqual({
      integrity_check: "ok",
    });
    expect(restored.sqlite.query("PRAGMA foreign_key_check").all()).toEqual([]);
    restored.sqlite.exec(
      "INSERT INTO items_fts(items_fts) VALUES('integrity-check')",
    );
  } finally {
    store?.close();
    restored?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
