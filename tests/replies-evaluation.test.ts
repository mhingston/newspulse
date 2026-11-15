import { expect, test } from "bun:test";
import corpusJson from "./fixtures/newsletter-replies-corpus-v1.json";
import {
  ADOPTION_THRESHOLD,
  NEWSLETTER_REPLIES_EVALUATION_VERSION,
  evaluateNewsletterReplies,
  repliesCorpusSchema,
  type RepliesCorpus,
  type RepliesEvaluationReport,
} from "../src/replies-evaluation";

const corpus: RepliesCorpus = repliesCorpusSchema.parse(corpusJson);

async function reported(): Promise<RepliesEvaluationReport> {
  return evaluateNewsletterReplies(corpusJson);
}

async function scenario(
  reportPromise: Promise<RepliesEvaluationReport>,
  id: string,
): Promise<RepliesEvaluationReport["scenarios"][number]> {
  const report = await reportPromise;
  const row = report.scenarios.find((s) => s.scenarioId === id);
  expect(row).toBeDefined();
  return row!;
}

test("the reply replay is deterministic and matches the recorded baseline", async () => {
  const first = await reported();
  expect(await evaluateNewsletterReplies(corpusJson)).toEqual(first);
  const baseline = await Bun.file(
    "docs/baselines/newsletter-replies-v1.json",
  ).json();
  expect(first).toEqual(baseline);
});

test("the corpus validates its required scenario set before opening a store", async () => {
  // A corpus missing a required scenario is a schema error, never a
  // silent crash mid-replay.
  const incomplete = {
    ...corpusJson,
    replies: (corpusJson as typeof corpus).replies.filter(
      (r) => r.id !== "missing-edition",
    ),
  };
  expect(() => repliesCorpusSchema.parse(incomplete)).toThrow();
});

test("the recorded decision is a non-adoption under the fixed threshold", async () => {
  const report = await reported();
  expect(report.evaluationVersion).toBe(NEWSLETTER_REPLIES_EVALUATION_VERSION);
  expect(report.adoption.adopt).toBe(false);
  expect(report.adoption.threshold).toBe(ADOPTION_THRESHOLD);
  // Every trust gate a reply channel depends on fails against recorded
  // evidence, and the shipped MCP surface already answers the question.
  expect(report.gates.recordedVerifiableSenderField).toBe(false);
  expect(report.gates.recordedReplyEditionCorrelationKey).toBe(false);
  expect(report.gates.forwardAttribution).toBe("forwarder_only");
  expect(report.gates.autoResponderLoopRisk).toBe("created_by_adoption");
  expect(report.gates.replySendBudgetSurface).toBe("absent");
  expect(report.gates.shippedReplySends).toBe(0);
  expect(report.gates.mcpScopedKnowledgeEquivalence).toBe(true);
});

test("a valid reply is indexed but its sender identity stays unverified", async () => {
  const row = await scenario(reported(), "valid-reply");
  expect(row.verdict).toBe("indexed_without_verified_sender");
  expect(row.verifiableSender).toBe(false);
  // The From header is recorded verbatim; no authorization result exists.
  expect(row.shipped).toContain("whatever the From header claims");
  // The shipped chain recorded it: signed webhook -> worker -> indexer.
  expect(row.shipped).toContain("signed");
});

test("a spoofed reply is indistinguishable from a genuine one on recorded evidence", async () => {
  const report = await reported();
  const valid = report.scenarios.find((s) => s.scenarioId === "valid-reply")!;
  const spoofed = report.scenarios.find(
    (s) => s.scenarioId === "spoofed-sender",
  )!;
  expect(spoofed.verdict).toBe(valid.verdict);
  // The spoof claims the authorized recipient's address verbatim; nothing
  // recorded can tell it apart from the genuine reply.
  expect(spoofed.shipped).toContain("indexed identically");
  expect(spoofed.shipped).toContain(corpus.edition.recipient);
});

test("a forwarded thread is attributed only to the forwarder", async () => {
  const row = await scenario(reported(), "forwarded-thread");
  expect(row.verdict).toBe("attributed_to_forwarder_only");
  expect(row.recordedEditionKey).toBe(false);
});

test("duplicate provider events deduplicate by recorded identity", async () => {
  const row = await scenario(reported(), "duplicate-event");
  expect(row.verdict).toBe("deduplicated_by_provider_identity");
  expect(row.shipped).toContain(
    "exactly one message row and no second claimable delivery",
  );
});

test("no shipped path can originate a reply, so autoreply loops cannot form today", async () => {
  const row = await scenario(reported(), "auto-responder-loop");
  expect(row.verdict).toBe("no_outbound_capability");
  expect(row.shipped).toContain("performs no outbound send");
  // The adoption gate records the loop surface the feature would create.
  const report = await reported();
  expect(report.gates.autoResponderLoopRisk).toBe("created_by_adoption");
});

test("a reply referencing an unrecorded edition cannot be correlated", async () => {
  const row = await scenario(reported(), "missing-edition");
  expect(row.verdict).toBe("correlation_unresolvable");
  expect(row.recordedEditionKey).toBe(false);
});

test("expired reply context keeps citations while the frozen edition stays immutable", async () => {
  const row = await scenario(reported(), "expired-context");
  expect(row.verdict).toBe("citations_survive_context_expired");
  expect(row.shipped).toContain("missing-detail marker is recorded");
  expect(row.shipped).toContain("frozen edition bytes unchanged");
});

test("the shipped authenticated surface answers the same scoped question with citations", async () => {
  const row = await scenario(reported(), "mcp-equivalence");
  expect(row.verdict).toBe("answered_with_citations_over_mcp");
  expect(row.shipped).toContain("source-linked citation");
});

test("reply processing performs no network calls: nothing can send or call a model without explicit opt-in", async () => {
  // Poison outbound fetch for the duration of the shipped reply path: a
  // reply is verified (shipped verifier), recorded, retrieved (recorded
  // fake) and indexed with the shipped normalizer without any egress.
  const poisoned = () => {
    throw new Error("network egress attempted during reply processing");
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = poisoned as unknown as typeof fetch;
  try {
    const report = await evaluateNewsletterReplies(corpusJson);
    expect(report.gates.shippedReplySends).toBe(0);
  } finally {
    globalThis.fetch = realFetch;
  }
});
