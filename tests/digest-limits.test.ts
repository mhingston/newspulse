import { expect, test } from "bun:test";
import { Store } from "../src/db/store";
import { ProfileStore } from "../src/profiles";
import { ProcessingWorker } from "../src/worker";
import { scoringHandler } from "../src/scoring-service";
import { digestDefaults, draftDigest } from "../src/digest-service";

const today = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Europe/London",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(Date.now());

test("oversized score and combined development references exclude only affected candidates", async () => {
  const store = new Store(":memory:");
  try {
    new ProfileStore(store.sqlite).import([
      {
        kind: "interest",
        id: "robots",
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
    store.enqueueDue();
    const common =
      "Robotics research release includes implementation, benchmarks, measurements, methodology, source code, technical descriptions, independent analysis and replication guidance for the announced model.";
    store.complete(store.claim()!, {
      items: [
        {
          nativeId: "group-a",
          title: "Acme releases Atlas 2 robotics model",
          text: common,
        },
        {
          nativeId: "group-b",
          title: "Atlas 2 robotics model launched by Acme",
          text: common,
        },
        {
          nativeId: "large",
          title: "Robotics engineering paper",
          text: "Robotics research benchmark design",
        },
        {
          nativeId: "good",
          title: "Robotics workshop guide",
          text: "Robotics tutorial implementation",
        },
      ],
    });
    for (
      let job = store.claimProcessing("extract");
      job;
      job = store.claimProcessing("extract")
    )
      store.completeProcessing(job, "unavailable");
    store.stories.reconcile();
    const worker = new ProcessingWorker(store, {
      score: scoringHandler(store),
    });
    await worker.drain("score");
    const refs = store.sqlite
      .query<{ item_id: string; native_id: string }, [string]>(
        "SELECT item_id,native_id FROM item_sources WHERE source_id=?",
      )
      .all(source.id);
    const byNative = new Map(refs.map((row) => [row.native_id, row.item_id]));
    // One member is outside the candidate window but remains part of the
    // current development and must retain its citation.
    store.sqlite
      .query("UPDATE digest_activity SET activity_at=0 WHERE item_id=?")
      .run(byNative.get("group-b")!);
    store.sqlite
      .query("UPDATE item_scores SET provenance=? WHERE item_id=?")
      .run(
        JSON.stringify({ input: "x".repeat(200_001) }),
        byNative.get("large")!,
      );
    for (const name of ["group-a", "group-b"])
      for (let i = 0; i < 9; i++)
        store.sqlite
          .query(
            "INSERT INTO item_sources(item_id,source_id,native_id) VALUES(?,?,?)",
          )
          .run(byNative.get(name)!, source.id, `${name}-additional-${i}`);
    const bounded = draftDigest(store, {
      ...digestDefaults(today),
      minScore: 0,
    });
    expect(bounded.status).toBe("ready");
    if (bounded.status !== "ready") throw new Error("expected a usable draft");
    expect(
      bounded.selected.find(
        (item) =>
          item.itemId === byNative.get("group-a") ||
          item.itemId === byNative.get("group-b"),
      )?.citations,
    ).toHaveLength(20);
    expect(
      bounded.selected
        .flatMap((item) => item.citations)
        .some((ref) => ref.nativeId === "group-b"),
    ).toBe(true);
    store.sqlite
      .query(
        "INSERT INTO item_sources(item_id,source_id,native_id) VALUES(?,?,?)",
      )
      .run(byNative.get("group-a")!, source.id, "group-a-one-too-many");
    const result = draftDigest(store, {
      ...digestDefaults(today),
      minScore: 0,
    });
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("expected a usable draft");
    expect(result.selected.map((item) => item.itemId)).toEqual([
      byNative.get("good")!,
    ]);
    const reasons = new Map(
      result.decisions.map((decision) => [
        decision.itemId,
        decision.reasons[0],
      ]),
    );
    expect(reasons.get(byNative.get("large")!)).toBe(
      "score_snapshot_limit_exceeded",
    );
    expect(reasons.get(byNative.get("group-a")!)).toBe(
      "reference_limit_exceeded",
    );
    expect(reasons.has(byNative.get("group-b")!)).toBe(false);
  } finally {
    store.close();
  }
});
