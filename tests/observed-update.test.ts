import { expect, test } from "bun:test";
import { Store } from "../src/db/store";
import { scoreItem } from "../src/scoring";
import { currentObservedUpdate } from "../src/observed-update";
import { createHash } from "node:crypto";

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
    // Scoring needs two source observations, not the full item/history response.
    store.getItem = () => {
      throw new Error("unbounded item retrieval");
    };
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
    expect(snapshot.provenance.input).toEqual(snapshot.input);
    expect(
      createHash("sha256")
        .update(
          JSON.stringify({
            criteriaVersion: scored.criteriaVersion,
            input: snapshot.provenance.input,
            provenance: snapshot.provenance,
          }),
        )
        .digest("hex"),
    ).toBe(snapshot.inputHash);
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

test("update evidence survives incidental changes and unrelated references but cancels on reversion", () => {
  const original = {
    id: 1,
    source_id: "s",
    native_id: "n",
    title: "Original robotics research",
    text: "Robotics original report and research methods",
    backfilled: 0,
    observed_at: 1,
  };
  const changed = {
    ...original,
    id: 2,
    title: "Revised robotics research",
    text: "Robotics revised research alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu",
    observed_at: 2,
  };
  const incidental = {
    ...changed,
    id: 3,
    text: `${changed.text}!`,
    observed_at: 3,
  };
  const anotherSource = {
    ...original,
    id: 4,
    source_id: "other",
    observed_at: 4,
  };
  const result = currentObservedUpdate([
    original,
    changed,
    incidental,
    anotherSource,
  ]);
  expect(result?.currentVersionId).toBe(2);
  expect(result?.observedAt).toBe(2);
  expect(
    currentObservedUpdate([
      original,
      changed,
      incidental,
      anotherSource,
      { ...original, id: 5, observed_at: 5 },
    ]),
  ).toBeNull();
});

test("small title or formatting changes do not imply meaningful updates", () => {
  const version = {
    id: 1,
    source_id: "s",
    native_id: "n",
    title: "Research initial findings",
    text: "Original long research report about the topic.",
    backfilled: 0,
    observed_at: 1,
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
