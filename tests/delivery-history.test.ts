import { expect, test } from "bun:test";
import { Store } from "../src/db/store";
import { DigestStore } from "../src/db/digest-store";
import { DeliveryStore } from "../src/db/delivery-store";
import { deliveryHistory } from "../src/db/delivery-history";
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
  },
) {
  const store = new Store(":memory:");
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
