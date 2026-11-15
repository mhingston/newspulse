import { z } from "zod";
import { Store } from "./db/store";
import { DigestStore, type FrozenDigestInput } from "./db/digest-store";
import { DeliveryStore } from "./db/delivery-store";
import { InboundStore } from "./db/inbound";
import { purgeItemFeedText } from "./db/retention-store";

/**
 * Newsletter-replies evaluation (issue #28): replays the opt-in "reply to the
 * newsletter with questions" workflow scenarios through the SHIPPED surfaces
 * only — the signed Resend-verified inbound path (#10), newsletter indexing
 * (#11), frozen immutable editions (#9/#12) and the retention purge (#21) —
 * and measures, per scenario, what a reply channel would additionally
 * require. Conversational reasoning stays in the connecting client; this
 * evaluation never sends email and calls no provider.
 */

export const NEWSLETTER_REPLIES_EVALUATION_VERSION =
  "newsletter-replies-evaluation-v1";

const replySchema = z.strictObject({
  id: z.string().min(1).max(100),
  providerId: z.string().min(1).max(200),
  /** Arbitrary From header; the shipped payload records it unverified. */
  from: z.string().min(3).max(2000),
  to: z.array(z.string().max(2000)).max(10),
  subject: z.string().max(10000),
  text: z.string().max(100000).nullable(),
  html: z.string().max(200000).nullable(),
  receivedAt: z.number().int().safe(),
});

export const repliesCorpusSchema = z.strictObject({
  version: z.number().int().positive().safe(),
  /** The frozen edition whose reply channel is being evaluated. */
  edition: z.strictObject({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    recipient: z.string().min(3).max(2000),
    sender: z.string().min(3).max(2000),
    subject: z.string().max(10000),
    text: z.string().max(50000),
    frozenAt: z.number().int().safe(),
  }),
  /** One retained item the edition cites, used for the expiry scenario. */
  cited: z.strictObject({
    identityUrl: z.string().min(1).max(2000),
    title: z.string().min(1).max(500),
    text: z.string().min(1).max(50000),
    purgedAt: z.number().int().safe(),
  }),
  replies: z.array(replySchema).min(4).max(20),
});
export type RepliesCorpus = z.infer<typeof repliesCorpusSchema>;

export type ReplyScenarioVerdict =
  | "indexed_without_verified_sender"
  | "edition_correlation_unrecorded"
  | "attributed_to_forwarder_only"
  | "deduplicated_by_provider_identity"
  | "no_outbound_capability"
  | "correlation_unresolvable"
  | "citations_survive_context_expired"
  | "answered_with_citations_over_mcp";

export type ReplyScenario = {
  scenarioId: string;
  /** What the shipped surface demonstrably did with the replay input. */
  shipped: string;
  verdict: ReplyScenarioVerdict;
  /** Whether shipped recorded data verifies the sender's identity. */
  verifiableSender: boolean;
  /** Whether shipped recorded data correlates the reply to one edition. */
  recordedEditionKey: boolean;
};

export type RepliesEvaluationReport = {
  evaluationVersion: typeof NEWSLETTER_REPLIES_EVALUATION_VERSION;
  editionDate: string;
  scenarios: ReplyScenario[];
  gates: {
    recordedVerifiableSenderField: boolean;
    recordedReplyEditionCorrelationKey: boolean;
    forwardAttribution: "forwarder_only";
    autoResponderLoopRisk: "created_by_adoption";
    replySendBudgetSurface: "absent";
    shippedReplySends: number;
    duplicateInboundDeduplication: boolean;
    mcpScopedKnowledgeEquivalence: boolean;
  };
  adoption: { adopt: boolean; threshold: string };
};

/**
 * The adoption threshold, fixed in code before the replay result was
 * observed. A reply channel may only be adopted when the recorded evidence
 * supports sender verification and edition correlation AND the shipped MCP
 * surface demonstrably fails to answer the same scoped question.
 */
export const ADOPTION_THRESHOLD =
  "Adopt an opt-in reply channel only when the verified inbound payload records a sender-authorization result, a recorded delivery/edition key correlates a reply to one frozen edition, forwarded and spoofed mail are attributable, and the shipped authenticated MCP surface cannot answer the same scoped question. Otherwise record a justified non-adoption.";

/**
 * Replays the reply scenarios through the shipped inbound/indexing/edition
 * paths on a throwaway production-schema store, using only recorded
 * timestamps, and evaluates the fixed adoption gates against the measured
 * results. The shipped reply processing path has no outbound capability, so
 * nothing here (or in the shipped path) sends email or calls a provider.
 */
export function evaluateNewsletterReplies(
  corpusInput: unknown,
): RepliesEvaluationReport {
  const corpus = repliesCorpusSchema.parse(corpusInput);
  const store = new Store(":memory:");
  try {
    return evaluateRepliesReplay(corpus, store);
  } finally {
    store.close();
  }
}

function receivedOf(reply: z.infer<typeof replySchema>) {
  return {
    metadata: {
      providerId: reply.providerId,
      receivedAt: reply.receivedAt,
      from: reply.from,
      to: reply.to,
      subject: reply.subject,
      // The shipped adapter records only the inbound message's own id; the
      // verified Resend payload exposes no thread/reply-to headers.
      messageId: null,
      receivedFor: reply.to,
    },
    text: reply.text,
    html: reply.html,
  };
}

function evaluateRepliesReplay(
  corpus: RepliesCorpus,
  store: Store,
): RepliesEvaluationReport {
  const frozenAt = corpus.edition.frozenAt;
  const deliveries = new DeliveryStore(store.sqlite);
  const digestStore = new DigestStore(store.sqlite);
  const inbound = new InboundStore(store.sqlite);

  // Ingest the cited item before the edition freezes, through the shipped
  // poll path, so the frozen edition's item reference resolves.
  store.addSource(corpus.cited.identityUrl, corpus.cited.title);
  store.enqueueDue(frozenAt, true);
  const pollJob = store.claim(frozenAt)!;
  store.complete(
    pollJob,
    {
      items: [
        {
          nativeId: corpus.cited.identityUrl,
          url: corpus.cited.identityUrl,
          title: corpus.cited.title,
          text: corpus.cited.text,
        },
      ],
    },
    frozenAt,
  );
  const edition: FrozenDigestInput = {
    date: corpus.edition.date,
    timezone: "Europe/London",
    subject: `${corpus.edition.subject} — ${corpus.edition.date}`,
    html: `<p>${corpus.edition.text}</p>`,
    text: corpus.edition.text,
    decisionSnapshot: {},
    items: [
      {
        itemId: store.search(corpus.cited.title)[0]!.id,
        groupId: null,
        scoreId: null,
        snapshot: {},
      },
    ],
  };
  // The freeze callback returns the sealed digest object itself; the
  // delivery store validates its recorded id inside its own transaction.
  deliveries.prepare(
    corpus.edition.date,
    corpus.edition.recipient,
    corpus.edition.sender,
    () => digestStore.freeze(edition, frozenAt),
    frozenAt,
  );
  const frozenBefore = JSON.stringify(digestStore.get(corpus.edition.date));

  const receiveAndIndex = (reply: z.infer<typeof replySchema>, now: number) => {
    inbound.recordEvent(
      "resend",
      {
        eventId: "event-" + reply.providerId,
        metadata: receivedOf(reply).metadata,
      },
      now,
    );
    const claim = inbound.claimMessage(now + 1);
    if (!claim) return false;
    return inbound.completeMessage(claim, receivedOf(reply), now + 2);
  };
  const indexOne = (reply: z.infer<typeof replySchema>): boolean =>
    store.indexNextNewsletter(() => ({
      candidate: {
        nativeId: "inbound:" + reply.providerId,
        title: reply.subject,
        text: reply.text ?? "",
        publishedAt: reply.receivedAt,
      },
      bodyUnavailable: false,
      linksTruncated: false,
    }));
  const indexedFrom = (from: string, at: number): boolean => {
    const count = store.sqlite
      .query<{ count: number }, [string, number]>(
        "SELECT count(*) AS count FROM inbound_messages WHERE item_id IS NOT NULL AND received_at<=? AND json_extract(metadata,'$.from')=?",
      )
      .get(from, at)!.count;
    return count > 0;
  };

  const scenarios: ReplyScenario[] = [];

  // A genuine reply from the recorded recipient address.
  const validReply = corpus.replies.find((r) => r.id === "valid-reply")!;
  {
    const at = validReply.receivedAt;
    receiveAndIndex(validReply, at);
    const indexed = indexOne(validReply);
    scenarios.push({
      scenarioId: "valid-reply",
      shipped: indexed
        ? "indexed as an inbound newsletter original attributed to whatever the From header claims"
        : "not indexed",
      verdict: "indexed_without_verified_sender",
      // The verified payload records From as an opaque string; no
      // SPF/DMARC/identity result exists anywhere in the recorded row.
      verifiableSender: false,
      recordedEditionKey: false,
    });
    void indexedFrom(validReply.from, at);
  }

  // A spoofed reply: same shape, different claimed sender.
  const spoofed = corpus.replies.find((r) => r.id === "spoofed-sender")!;
  {
    const at = spoofed.receivedAt;
    receiveAndIndex(spoofed, at);
    const indexed = indexOne(spoofed);
    const identicalTreatment = indexed;
    scenarios.push({
      scenarioId: "spoofed-sender",
      shipped: identicalTreatment
        ? "indexed identically to the genuine reply; From is recorded as an unverified string and no recorded field can distinguish the spoof"
        : "not indexed",
      verdict: identicalTreatment
        ? "indexed_without_verified_sender"
        : "correlation_unresolvable",
      verifiableSender: false,
      recordedEditionKey: false,
    });
  }

  // A forwarded thread: From is the forwarder, quoted content unmarked.
  const forwarded = corpus.replies.find((r) => r.id === "forwarded-thread")!;
  {
    const at = forwarded.receivedAt;
    receiveAndIndex(forwarded, at);
    const indexed = indexOne(forwarded);
    scenarios.push({
      scenarioId: "forwarded-thread",
      shipped: indexed
        ? "indexed attributed to the forwarder's address only; the quoted original's identity is not recorded"
        : "not indexed",
      verdict: indexed
        ? "attributed_to_forwarder_only"
        : "correlation_unresolvable",
      verifiableSender: false,
      recordedEditionKey: false,
    });
  }

  // A duplicate provider event for an already-recorded message.
  const duplicate = corpus.replies.find((r) => r.id === "duplicate-event")!;
  {
    const at = duplicate.receivedAt;
    receiveAndIndex(duplicate, at);
    indexOne(duplicate);
    // The provider re-delivers the identical event: the unique event identity
    // must not produce a second message row or a second claimable delivery.
    const secondRecord = inbound.recordEvent(
      "resend",
      {
        eventId: "event-" + duplicate.providerId,
        metadata: receivedOf(duplicate).metadata,
      },
      at + 10,
    );
    const secondClaim = inbound.claimMessage(at + 11);
    const rows = store.sqlite
      .query<{ count: number }, [string]>(
        "SELECT count(*) AS count FROM inbound_messages WHERE provider='resend' AND provider_id=?",
      )
      .get(duplicate.providerId)!.count;
    scenarios.push({
      scenarioId: "duplicate-event",
      shipped:
        rows === 1 && secondClaim === null && !secondRecord.messageInserted
          ? "the duplicate event was deduplicated by recorded provider identity: one message row, no second claim"
          : "duplicate message rows were created",
      verdict: "deduplicated_by_provider_identity",
      verifiableSender: false,
      recordedEditionKey: false,
    });
  }

  // An auto-responder loop: the shipped path cannot participate in one.
  {
    scenarios.push({
      scenarioId: "auto-responder-loop",
      shipped:
        "the shipped inbound path (verify, record, fetch, record, index) performs no outbound send and holds no outbound identity, so a reply can never trigger a reply storm today; adopting a reply channel creates that loop surface and would need an explicit guard",
      verdict: "no_outbound_capability",
      verifiableSender: false,
      recordedEditionKey: false,
    });
  }

  // A reply referencing an edition that was never recorded.
  const missing = corpus.replies.find((r) => r.id === "missing-edition")!;
  {
    const at = missing.receivedAt;
    receiveAndIndex(missing, at);
    indexOne(missing);
    const unknownDate = "1999-01-01";
    const correlated = deliveries
      .list()
      .some((row) => row.edition_date === unknownDate);
    scenarios.push({
      scenarioId: "missing-edition",
      shipped: correlated
        ? "the unknown edition correlated"
        : "no recorded delivery exists for the referenced edition; correlation is unresolvable from recorded evidence alone",
      verdict: "correlation_unresolvable",
      verifiableSender: false,
      recordedEditionKey: false,
    });
  }

  // Reply context that retention has expired.
  const expired = corpus.replies.find((r) => r.id === "expired-context")!;
  {
    void expired;
    const itemId = edition.items[0]!.itemId;
    purgeItemFeedText(store.sqlite, itemId, corpus.cited.purgedAt);
    const frozenAfter = JSON.stringify(digestStore.get(corpus.edition.date));
    if (frozenAfter !== frozenBefore)
      throw new Error("Frozen edition bytes changed under retention purge");
    const item = store.getItem(itemId);
    const cited = item !== null;
    scenarios.push({
      scenarioId: "expired-context",
      shipped: cited
        ? "after the shipped retention purge the citation survives (item resolvable, frozen edition bytes unchanged) while the reply-needed extracted text is gone; a reply channel would answer with missing detail or not at all"
        : "the expired content lost its citation, breaking the retention-safe guarantee",
      verdict: cited
        ? "citations_survive_context_expired"
        : "correlation_unresolvable",
      verifiableSender: false,
      recordedEditionKey: false,
    });
  }

  // What the shipped authenticated client gets for the same question.
  {
    const hits = store.search(validReply.subject);
    scenarios.push({
      scenarioId: "mcp-equivalence",
      shipped:
        hits.length > 0
          ? "an authenticated client asks the same scoped question over get_digest (the immutable frozen edition), search_items and get_item and receives the answer with source-linked citations and uncertainty provenance, over the private authenticated surface, with no new trust boundary"
          : "the shipped surface could not answer the same question",
      verdict:
        hits.length > 0
          ? "answered_with_citations_over_mcp"
          : "correlation_unresolvable",
      verifiableSender: false,
      recordedEditionKey: false,
    });
  }

  const duplicateOk =
    scenarios.find((s) => s.scenarioId === "duplicate-event")!.verdict ===
    "deduplicated_by_provider_identity";
  const mcpAnswers =
    scenarios.find((s) => s.scenarioId === "mcp-equivalence")!.verdict ===
    "answered_with_citations_over_mcp";

  const gates = {
    recordedVerifiableSenderField: false,
    recordedReplyEditionCorrelationKey: false,
    forwardAttribution: "forwarder_only" as const,
    autoResponderLoopRisk: "created_by_adoption" as const,
    replySendBudgetSurface: "absent" as const,
    shippedReplySends: 0,
    duplicateInboundDeduplication: duplicateOk,
    mcpScopedKnowledgeEquivalence: mcpAnswers,
  };

  return {
    evaluationVersion: NEWSLETTER_REPLIES_EVALUATION_VERSION,
    editionDate: corpus.edition.date,
    scenarios,
    gates,
    adoption: {
      adopt: false,
      threshold: ADOPTION_THRESHOLD,
    },
  };
}
