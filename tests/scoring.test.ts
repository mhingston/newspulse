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
  test("explicit feedback adjusts relevance with provenance but never overrides matching", () => {
    const base = scoreItem(input);
    const useful = scoreItem({
      ...input,
      feedback: { useful: true, at: 999 },
    });
    const notUseful = scoreItem({
      ...input,
      feedback: { useful: false, at: 1000 },
    });
    expect(useful.total).toBeGreaterThan(base.total);
    expect(notUseful.total).toBeLessThan(base.total);
    expect(useful.reasons).toContain("explicit_feedback:useful@999");
    expect(notUseful.reasons).toContain("explicit_feedback:not_useful@1000");
    // Feedback is a bounded adjustment, not an eligibility override.
    const unmatched = scoreItem({
      ...input,
      title: "Football",
      text: "Football",
      feedback: { useful: false, at: 1 },
    });
    expect(unmatched.eligible).toBe(false);
    expect(unmatched.reasons).toContain("no_interest_match");
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

describe("model interest verdicts", () => {
  const robotics = input.interests[0]!;
  const analysis = {
    claims: [],
    uncertainty: [],
  };
  test("an irrelevant verdict vetoes an otherwise eligible lexical match", () => {
    const vetoed = scoreItem({
      ...input,
      analysis: {
        ...analysis,
        interestVerdicts: [
          {
            interestId: "robotics",
            verdict: "irrelevant",
            reason: "Mentions robotics only in a footer",
          },
        ],
      },
    });
    expect(vetoed.eligible).toBe(false);
    expect(vetoed.components.relevance).toBe(0);
  });
  test("a relevant or borderline verdict leaves the lexical match unchanged", () => {
    for (const verdict of ["relevant", "borderline"] as const) {
      const result = scoreItem({
        ...input,
        analysis: {
          ...analysis,
          interestVerdicts: [
            { interestId: "robotics", verdict, reason: "Checked" },
          ],
        },
      });
      expect(result.eligible).toBe(scoreItem(input).eligible);
      expect(result.total).toBe(scoreItem(input).total);
    }
  });
  test("a verdict can never create a match the lexical rule rejects", () => {
    const unmatched = {
      ...input,
      title: "Quarterly sales",
      text: "Revenue grew.",
    };
    const baseline = scoreItem(unmatched);
    const judged = scoreItem({
      ...unmatched,
      analysis: {
        ...analysis,
        interestVerdicts: [
          {
            interestId: "robotics",
            verdict: "relevant",
            reason: "Looks related",
          },
        ],
      },
    });
    expect(baseline.eligible).toBe(false);
    expect(judged.eligible).toBe(false);
    expect(judged.total).toBe(baseline.total);
  });
  test("a missing verdict list scores exactly as before", () => {
    expect(scoreItem({ ...input, analysis }).total).toBe(
      scoreItem(input).total,
    );
  });
  test("a verdict for another interest does not veto this one", () => {
    const other = scoreItem({
      ...input,
      analysis: {
        ...analysis,
        interestVerdicts: [
          { interestId: "other", verdict: "irrelevant", reason: "Unrelated" },
        ],
      },
    });
    expect(other.eligible).toBe(scoreItem(input).eligible);
  });
});
