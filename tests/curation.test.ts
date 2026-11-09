import { expect, test } from "bun:test";
import {
  curateDigest,
  type CurationCandidate,
  type CurationInput,
} from "../src/curation";

const candidate = (
  itemId: string,
  overrides: Partial<CurationCandidate> = {},
): CurationCandidate => ({
  itemId,
  groupId: itemId,
  scoreId: `score-${itemId}`,
  score: 80,
  scoreSnapshot: { total: 80 },
  eligible: true,
  interestIds: ["robots"],
  title: itemId,
  summary: null,
  explanation: "A source-linked explanation",
  citations: [{ sourceId: "feed", nativeId: itemId, url: null }],
  discovery: false,
  update: null,
  ...overrides,
});
const input = (candidates: CurationCandidate[]): CurationInput => ({
  candidates,
  priorEditions: [],
  minScore: 50,
  maxItems: 10,
  maxPerInterest: 3,
});

test("drafts balance interests, retain original references and deduplicate specific developments", () => {
  const items = [
    candidate("a", { score: 99 }),
    candidate("b", { score: 95 }),
    candidate("c", { score: 60, interestIds: ["climate"], discovery: true }),
    candidate("dup", { groupId: "a", score: 90 }),
  ];
  const result = curateDigest(input(items));
  expect(result.selected.map((item) => item.itemId)).toEqual(["a", "c", "b"]);
  expect(result.selected[0]!.citations[0]).toEqual({
    sourceId: "feed",
    nativeId: "a",
    url: null,
  });
  expect(result.decisions.find((d) => d.itemId === "dup")?.reasons).toContain(
    "duplicate_development",
  );
  expect(result.decisions.find((d) => d.itemId === "c")?.reasons).toContain(
    "outside_subscriptions",
  );
  expect(curateDigest(input([...items].reverse()))).toEqual(result);
});

test("confirmed prior edition requires documented later update; uncertain delivery remains distinct", () => {
  const item = candidate("a");
  const prior = {
    editionId: "old",
    state: "sent" as const,
    publishedAt: 100,
    items: [{ itemId: "a", groupId: "a" }],
  };
  expect(
    curateDigest({ ...input([item]), priorEditions: [prior] }).decisions[0],
  ).toMatchObject({
    included: false,
    priorEditionId: "old",
    reasons: ["previously_published_without_documented_update"],
  });
  const corrected = {
    ...item,
    update: {
      priorEditionId: "old",
      observedAt: 101,
      evidence: "Source correction",
    },
  };
  expect(
    curateDigest({ ...input([corrected]), priorEditions: [prior] })
      .decisions[0],
  ).toMatchObject({
    included: true,
    priorEditionId: "old",
    reasons: ["meets_quality_threshold", "documented_update"],
  });
  expect(
    curateDigest({
      ...input([
        { ...corrected, update: { ...corrected.update, observedAt: 99 } },
      ]),
      priorEditions: [prior],
    }).status,
  ).toBe("no_digest");
  expect(
    curateDigest({
      ...input([item]),
      priorEditions: [{ ...prior, state: "frozen" }],
    }).status,
  ).toBe("ready");
  expect(
    curateDigest({
      ...input([item]),
      priorEditions: [{ ...prior, state: "ambiguous" }],
    }).decisions[0]?.reasons,
  ).toEqual(["prior_delivery_ambiguous"]);
});

test("quality, citation, per-interest and edition limits explain all exclusions", () => {
  const items = [
    candidate("a"),
    candidate("b", { score: 70 }),
    candidate("low", { score: 49 }),
    candidate("missing", { citations: [] }),
    candidate("ineligible", { eligible: false }),
  ];
  const result = curateDigest({
    ...input(items),
    maxItems: 3,
    maxPerInterest: 1,
  });
  expect(result.selected.map((item) => item.itemId)).toEqual(["a"]);
  expect(
    Object.fromEntries(result.decisions.map((d) => [d.itemId, d.reasons[0]])),
  ).toEqual({
    a: "meets_quality_threshold",
    b: "interest_limit",
    ineligible: "score_ineligible",
    low: "below_quality_threshold",
    missing: "missing_source_reference",
  });
  expect(curateDigest(input([candidate("low", { score: 1 })])).status).toBe(
    "no_digest",
  );
  expect(() => curateDigest(input([items[0]!, items[0]!]))).toThrow();
});
