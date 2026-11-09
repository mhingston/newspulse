import { describe, expect, test } from "bun:test";
import {
  compareScores,
  scoreItem,
  scoreWithSpecialist,
  type ScoringInput,
} from "../src/scoring";

const input: ScoringInput = {
  itemId: "a",
  title: "Robotics research release",
  text: "Robotics research tutorial ".repeat(50),
  now: 1_000_000_000,
  publishedAt: 1_000_000_000,
  interests: [
    {
      kind: "interest",
      id: "robotics",
      version: 1,
      description: "Robotics",
      entities: [],
      keywords: ["robotics"],
      priority: 3,
      positive: ["research"],
      negative: ["advertising"],
      queries: [],
      lifetime: "persistent",
      feedbackRefs: [],
    },
  ],
  analysis: null,
  history: { sameDevelopment: false, meaningfulUpdate: false },
};

describe("deterministic scoring", () => {
  test("ranks matching, borderline, duplicate and irrelevant items", () => {
    const relevant = scoreItem(input);
    const duplicate = scoreItem({
      ...input,
      history: { sameDevelopment: true, meaningfulUpdate: false },
    });
    const borderline = scoreItem({
      ...input,
      text: "Robotics",
      title: "Robotics",
    });
    const irrelevant = scoreItem({
      ...input,
      title: "Football",
      text: "Football",
    });
    expect([
      relevant.total,
      duplicate.total,
      borderline.total,
      irrelevant.total,
    ]).toEqual([68, 46, 56, 35]);
    expect(irrelevant.eligible).toBe(false);
    expect(irrelevant.reasons).toContain("no_interest_match");
    expect(
      compareScores(
        { itemId: "b", score: relevant },
        { itemId: "a", score: relevant },
      ),
    ).toBeGreaterThan(0);
  });
  test("stale coverage and meaningful updates receive distinct novelty", () => {
    const old = { ...input, publishedAt: input.now - 40 * 86_400_000 };
    expect(scoreItem(old).components.novelty).toBe(10);
    expect(
      scoreItem({
        ...old,
        history: { sameDevelopment: true, meaningfulUpdate: true },
      }).components.novelty,
    ).toBe(80);
    expect(scoreItem({ ...input, history: null }).uncertainty).toContain(
      "history_unavailable",
    );
  });
  test("editorial criteria affect weights and preserve profile version", () => {
    const result = scoreItem({
      ...input,
      analysis: { classification: "paper", claims: [], uncertainty: [] },
      editorialProfiles: [
        {
          id: "paper",
          version: 2,
          contentTypes: ["paper"],
          criteria: [
            { dimension: "evidence", weight: 20 },
            { dimension: "unknown", weight: 1 },
          ],
        },
      ],
    });
    expect(result.weights.evidence).toBe(30);
    expect(result.reasons).toContain("editorial:paper@2");
    expect(result.uncertainty).toContain("unknown_editorial_dimension:unknown");
  });
  test("failed, malformed and absent specialists leave baseline intact", async () => {
    const base = scoreItem(input);
    for (const judge of [
      undefined,
      { version: "v1", model: "fake", judge: async () => ({ bad: true }) },
      {
        version: "v1",
        model: "fake",
        judge: async () => {
          throw new Error("failed");
        },
      },
    ]) {
      const result = await scoreWithSpecialist(input, judge);
      expect(result.total).toBe(base.total);
      expect(result.specialist).toBeNull();
      expect(
        result.uncertainty.some((reason) => reason.startsWith("specialist_")),
      ).toBe(true);
    }
    const timed = await scoreWithSpecialist(
      input,
      { version: "v1", model: "fake", judge: () => new Promise(() => {}) },
      1,
    );
    expect(timed.uncertainty).toContain("specialist_failed");
  });
});
