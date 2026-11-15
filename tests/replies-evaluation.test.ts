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

function reported(): RepliesEvaluationReport {
  return evaluateNewsletterReplies(corpusJson);
}

function scenario(
  report: RepliesEvaluationReport,
  id: string,
): RepliesEvaluationReport["scenarios"][number] {
  const row = report.scenarios.find((s) => s.scenarioId === id);
  expect(row).toBeDefined();
  return row!;
}

test("the reply replay is deterministic and matches the recorded baseline", async () => {
  const first = reported();
  expect(evaluateNewsletterReplies(corpusJson)).toEqual(first);
  const baseline = await Bun.file(
    "docs/baselines/newsletter-replies-v1.json",
  ).json();
  expect(first).toEqual(baseline);
});

test("the recorded decision is a non-adoption under the fixed threshold", () => {
  const report = reported();
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

test("a valid reply is indexed but its sender identity stays unverified", () => {
  const row = scenario(reported(), "valid-reply");
  expect(row.verdict).toBe("indexed_without_verified_sender");
  expect(row.verifiableSender).toBe(false);
  // The From header is recorded verbatim; no authorization result exists.
  expect(row.shipped).toContain(
    "attributed to whatever the From header claims",
  );
});

test("a spoofed reply is indistinguishable from a genuine one on recorded evidence", () => {
  const report = reported();
  const valid = scenario(report, "valid-reply");
  const spoofed = scenario(report, "spoofed-sender");
  expect(spoofed.verdict).toBe(valid.verdict);
  expect(spoofed.shipped).toContain("indexed identically");
});

test("a forwarded thread is attributed only to the forwarder", () => {
  const row = scenario(reported(), "forwarded-thread");
  expect(row.verdict).toBe("attributed_to_forwarder_only");
  expect(row.recordedEditionKey).toBe(false);
});

test("duplicate provider events deduplicate by recorded identity", () => {
  const row = scenario(reported(), "duplicate-event");
  expect(row.verdict).toBe("deduplicated_by_provider_identity");
  expect(row.shipped).toContain("one message row, no second claim");
});

test("no shipped path can originate a reply, so autoreply loops cannot form today", () => {
  const row = scenario(reported(), "auto-responder-loop");
  expect(row.verdict).toBe("no_outbound_capability");
  expect(row.shipped).toContain("performs no outbound send");
  // The adoption gate records the loop surface the feature would create.
  expect(reported().gates.autoResponderLoopRisk).toBe("created_by_adoption");
});

test("a reply referencing an unrecorded edition cannot be correlated", () => {
  const row = scenario(reported(), "missing-edition");
  expect(row.verdict).toBe("correlation_unresolvable");
  expect(row.recordedEditionKey).toBe(false);
});

test("expired reply context keeps citations while the frozen edition stays immutable", () => {
  const row = scenario(reported(), "expired-context");
  expect(row.verdict).toBe("citations_survive_context_expired");
  expect(row.shipped).toContain("citation survives");
  expect(row.shipped).toContain("frozen edition bytes unchanged");
});

test("the shipped authenticated surface answers the same scoped question with citations", () => {
  const row = scenario(reported(), "mcp-equivalence");
  expect(row.verdict).toBe("answered_with_citations_over_mcp");
  expect(row.shipped).toContain("citations and uncertainty provenance");
});

test("reply processing performs no network calls: nothing can send or call a model without explicit opt-in", async () => {
  // Poison outbound fetch for the duration of the shipped reply path: a
  // reply is verified, recorded, fetched (fake adapter) and indexed without
  // any egress, so no reply send or AI call can occur implicitly.
  const poisoned = () => {
    throw new Error("network egress attempted during reply processing");
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = poisoned as unknown as typeof fetch;
  try {
    const report = evaluateNewsletterReplies(corpusJson);
    expect(report.gates.shippedReplySends).toBe(0);
  } finally {
    globalThis.fetch = realFetch;
  }
});
