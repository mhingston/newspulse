import { expect, test } from "bun:test";
import { Store } from "../src/db/store";
import { ProfileStore } from "../src/profiles";
import { scoringHandler } from "../src/scoring-service";
import { ProcessingWorker } from "../src/worker";

test("scoring runs without an analysis provider and exposes its explanation", async () => {
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
    store.addSource("https://example.com/feed");
    store.enqueueDue();
    store.complete(store.claim()!, {
      items: [
        {
          nativeId: "a",
          title: "Robotics release",
          text: "Robotics tool release",
        },
      ],
    });
    const id = store.search("robotics")[0]!.id;
    const extract = store.claimProcessing("extract")!;
    store.completeProcessing(extract, "unavailable");
    const worker = new ProcessingWorker(store, {
      score: scoringHandler(store),
    });
    expect(await worker.drain("score")).toBeGreaterThan(0);
    const scores = store.scoreHistory(id);
    expect(scores).toHaveLength(1);
    const result = scores[0]!.result as {
      eligible: boolean;
      uncertainty: string[];
    };
    expect(result.eligible).toBe(true);
    expect(result.uncertainty).toContain("analysis_unavailable");
    expect(store.search("robotics")).toHaveLength(1);
    // A software upgrade must re-evaluate completed jobs without rewriting
    // the historical result, even when no item or profile changed.
    store.sqlite
      .query("UPDATE item_scores SET criteria_version='older-rules'")
      .run();
    expect(await worker.drain("score")).toBeGreaterThan(0);
    const rescored = store.scoreHistory(id);
    expect(rescored).toHaveLength(2);
    expect(rescored.map((row) => row.criteria_version)).toContain(
      "older-rules",
    );
    expect(rescored[0]!.criteria_version).not.toBe("older-rules");
  } finally {
    store.close();
  }
});
