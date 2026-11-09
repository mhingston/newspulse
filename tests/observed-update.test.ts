import { expect, test } from "bun:test";
import { Store } from "../src/db/store";
import { scoreItem } from "../src/scoring";

test("actual source corrections produce auditable update evidence without implying presentation", () => {
  const store = new Store(":memory:");
  try {
    store.addSource("https://example.test/feed");
    const ingest = (title: string, text: string, at: number) => {
      store.enqueueDue(at, true);
      store.complete(
        store.claim(at)!,
        { items: [{ nativeId: "a", title, text, publishedAt: 1 }] },
        at,
      );
      const extraction = store.claimProcessing("extract", at)!;
      store.completeProcessing(extraction, "unavailable", at);
    };
    const original =
      "Robotics initial article original details describe the research project and its methods";
    const update =
      "Robotics correction research " +
      "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu";
    const at = 40 * 86_400_000;
    ingest("Robotics initial findings", original, at);
    ingest("Robotics revised findings", update, at + 100);
    const job =
      store.claimProcessing("score", at + 101) ??
      store.claimProcessing("score", at + 101)!;
    const snapshot = store.scoringSnapshot(job, at + 101)!;
    expect(snapshot.provenance.observedUpdate).toMatchObject({
      ruleVersion: "observed-update-v1",
      nativeId: "a",
    });
    expect(snapshot.input.history).toBeNull();
    expect(scoreItem(snapshot.input).components.novelty).toBe(80);
    expect(scoreItem(snapshot.input).uncertainty).toContain(
      "history_unavailable",
    );
    expect(
      scoreItem({ ...snapshot.input, now: at + 8 * 86_400_000 }).components
        .novelty,
    ).toBe(10);
    const scored = scoreItem(snapshot.input);
    expect(
      store.completeScore(
        job,
        {
          capturedAt: at + 101,
          inputHash: snapshot.inputHash,
          criteriaVersion: scored.criteriaVersion,
          provenance: snapshot.provenance,
          result: scored,
        },
        at + 101,
      ),
    ).toBe(true);
    const deadline = snapshot.input.observedUpdateAt! + 604800001;
    expect(
      store.sqlite
        .query<{ due_at: number }, [string]>(
          "SELECT due_at FROM score_refresh WHERE job_id=?",
        )
        .get(job.id)?.due_at,
    ).toBe(deadline);
    expect(store.claimProcessing("score", deadline - 1)).toBeNull();
    expect(store.claimProcessing("score", deadline)?.id).toBe(job.id);
    store.sqlite
      .query("UPDATE content_versions SET backfilled=1 WHERE id=?")
      .run(snapshot.provenance.observedUpdate!.previousVersionId);
    expect(
      store.scoringSnapshot(job, at + 101)!.provenance.observedUpdate,
    ).toBeNull();
  } finally {
    store.close();
  }
});

test("small title or formatting changes do not imply meaningful updates", () => {
  const version = {
    id: 1,
    source_id: "s",
    native_id: "n",
    title: "Research initial findings",
    text: "Original long research report about the topic.",
    backfilled: 0,
  };
  const { observedUpdate } =
    require("../src/observed-update") as typeof import("../src/observed-update");
  expect(
    observedUpdate(version, {
      ...version,
      id: 2,
      title: "Research revised findings",
      text: "Original long research report about the topic!",
    }),
  ).toBeNull();
  expect(
    observedUpdate(version, {
      ...version,
      id: 2,
      source_id: "other",
      title: "Research revised findings",
      text: "different ".repeat(100),
    }),
  ).toBeNull();
});
