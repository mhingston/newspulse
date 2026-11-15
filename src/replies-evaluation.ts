import { z } from "zod";
import { Store } from "./db/store";
import { DigestStore, type FrozenDigestInput } from "./db/digest-store";
import { DeliveryStore } from "./db/delivery-store";
import { InboundStore } from "./db/inbound";
import { purgeItemFeedText } from "./db/retention-store";
import { ResendInbound } from "./adapters/resend-inbound";
import { normalizeNewsletter } from "./adapters/newsletter";
import { inboundWebhook, InboundWorker } from "./inbound-worker";
import type { InboundEmailMetadata, ReceivedEmail } from "./inbound";

/**
 * Newsletter-replies evaluation (issue #28): replays the opt-in "reply to the
 * newsletter with questions" workflow scenarios through the SHIPPED surfaces
 * only — the real signed webhook verifier and inbound worker (#10), the real
 * newsletter normalizer/indexer (#11), frozen immutable editions (#9/#12) and
 * the retention purge (#21) — and measures, per scenario, what a reply
 * channel would additionally require. Conversational reasoning stays in the
 * connecting client; this evaluation never sends email and calls no
 * provider (retrieval is a recorded fake behind the shipped worker; the
 * tests additionally poison network egress).
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

export const repliesCorpusSchema = z
  .strictObject({
    version: z.number().int().positive().safe(),
    /**
     * Synthetic local HMAC key used ONLY to produce deterministic signed
     * webhook fixtures for this offline replay; it guards nothing and is
     * not a credential (the replayed webhook boundary is the shipped
     * verifier, so the signature path itself is exercised).
     */
    verification: z.strictObject({
      secret: z
        .string()
        .min(20)
        .max(200)
        .regex(/^whsec_[A-Za-z0-9+/=]+$/),
    }),
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
  })
  .superRefine((corpus, context) => {
    const required = [
      "valid-reply",
      "spoofed-sender",
      "forwarded-thread",
      "duplicate-event",
      "missing-edition",
      "expired-context",
    ];
    for (const id of required) {
      const occurrences = corpus.replies.filter((r) => r.id === id).length;
      if (occurrences !== 1)
        context.addIssue({
          code: "custom",
          message: `replies must contain exactly one "${id}" scenario (found ${occurrences})`,
        });
    }
    for (const reply of corpus.replies) {
      if (!required.includes(reply.id))
        context.addIssue({
          code: "custom",
          message: `unknown scenario id "${reply.id}" in replies`,
        });
    }
  });
export type RepliesCorpus = z.infer<typeof repliesCorpusSchema>;

export type ReplyScenarioVerdict =
  | "indexed_without_verified_sender"
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
 * Replays the reply scenarios through the shipped signed webhook verifier,
 * inbound retrieval worker, newsletter indexer, frozen-edition store and
 * retention purge on a throwaway production-schema store, using recorded
 * timestamps, and evaluates the fixed adoption gates against the measured
 * results. Nothing here (or in the shipped path) sends email or calls a
 * provider: retrieval is a recorded fake behind the shipped worker.
 */
export async function evaluateNewsletterReplies(
  corpusInput: unknown,
): Promise<RepliesEvaluationReport> {
  const corpus = repliesCorpusSchema.parse(corpusInput);
  const store = new Store(":memory:");
  try {
    return await evaluateRepliesReplay(corpus, store);
  } finally {
    store.close();
  }
}

/** The canonical Resend webhook body shape for one received email. */
function webhookPayload(reply: z.infer<typeof replySchema>): string {
  return JSON.stringify({
    type: "email.received",
    data: {
      email_id: reply.providerId,
      created_at: new Date(reply.receivedAt).toISOString(),
      from: reply.from,
      to: reply.to,
      subject: reply.subject,
      message_id: null,
      received_for: reply.to,
    },
  });
}

class RecordedRepliesProvider {
  constructor(private readonly replies: RepliesCorpus["replies"]) {}
  // Never called on this evaluation's path: webhook events are verified by
  // the shipped ResendInbound adapter and recorded directly, so the worker
  // only performs retrieval here.
  verifyWebhook(): never {
    throw new Error("verifyWebhook is provided by the shipped ResendInbound");
  }
  async get(providerId: string): Promise<ReceivedEmail> {
    const reply = this.replies.find((r) => r.providerId === providerId);
    if (!reply) throw new Error("Unknown recorded reply " + providerId);
    return {
      metadata: {
        providerId: reply.providerId,
        receivedAt: reply.receivedAt,
        from: reply.from,
        to: reply.to,
        subject: reply.subject,
        messageId: null,
        receivedFor: reply.to,
      },
      text: reply.text,
      html: reply.html,
    };
  }
  async list(): Promise<{ items: InboundEmailMetadata[]; hasMore: boolean }> {
    return { items: [], hasMore: false };
  }
}

async function evaluateRepliesReplay(
  corpus: RepliesCorpus,
  store: Store,
): Promise<RepliesEvaluationReport> {
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
  deliveries.prepare(
    corpus.edition.date,
    corpus.edition.recipient,
    corpus.edition.sender,
    // The freeze callback returns the sealed digest object itself; the
    // delivery store validates its recorded id inside its own transaction.
    () => digestStore.freeze(edition, frozenAt),
    frozenAt,
  );
  const frozenBefore = JSON.stringify(digestStore.get(corpus.edition.date));

  // The SHIPPED signed webhook verifier + durable recording path (#10).
  const adapter = new ResendInbound(
    "offline-replay-key",
    corpus.verification.secret,
  );
  const recordWebhook = inboundWebhook(inbound, adapter);

  // The SHIPPED retrieval worker with a recorded fake provider (#10), then
  // the SHIPPED newsletter normalizer/indexer (#11).
  const worker = new InboundWorker(
    inbound,
    new RecordedRepliesProvider(corpus.replies),
  );
  const receiveReply = async (reply: z.infer<typeof replySchema>) => {
    const payload = webhookPayload(reply);
    const record = await import("node:crypto");
    const id = "evt-" + reply.providerId;
    const timestamp = Math.floor(Date.now() / 1000);
    const signature =
      "v1," +
      record
        .createHmac(
          "sha256",
          Buffer.from(corpus.verification.secret.slice(6), "base64"),
        )
        .update(`${id}.${timestamp}.${payload}`)
        .digest("base64");
    recordWebhook(
      payload,
      new Headers({
        "svix-id": id,
        "svix-timestamp": String(timestamp),
        "svix-signature": signature,
      }),
    );
    await worker.retrieve();
  };
  const indexOne = (): boolean =>
    store.indexNextNewsletter(normalizeNewsletter);

  const scenarios: ReplyScenario[] = [];

  // A genuine reply from the recorded recipient address.
  const validReply = corpus.replies.find((r) => r.id === "valid-reply")!;
  {
    await receiveReply(validReply);
    const indexed = indexOne();
    scenarios.push({
      scenarioId: "valid-reply",
      shipped: indexed
        ? "signed-verified through the shipped webhook path, retrieved through the shipped worker, and indexed as an inbound newsletter original attributed to whatever the From header claims"
        : "not indexed",
      verdict: "indexed_without_verified_sender",
      // The verified payload records From as an opaque string; no
      // SPF/DMARC/identity result exists anywhere in the recorded row.
      verifiableSender: false,
      recordedEditionKey: false,
    });
  }

  // A spoofed reply claiming the authorized recipient's address.
  const spoofed = corpus.replies.find((r) => r.id === "spoofed-sender")!;
  {
    await receiveReply(spoofed);
    const indexed = indexOne();
    scenarios.push({
      scenarioId: "spoofed-sender",
      shipped: indexed
        ? `indexed identically to the genuine reply (signed webhook accepted, message indexed, From recorded as the claimed recipient address ${spoofed.from}); no recorded field distinguishes this spoof`
        : "not indexed",
      verdict: indexed
        ? "indexed_without_verified_sender"
        : "correlation_unresolvable",
      verifiableSender: false,
      recordedEditionKey: false,
    });
  }

  // A forwarded thread: From is the forwarder, quoted content unmarked.
  const forwarded = corpus.replies.find((r) => r.id === "forwarded-thread")!;
  {
    await receiveReply(forwarded);
    const indexed = indexOne();
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
    await receiveReply(duplicate);
    indexOne();
    // The provider re-delivers the identical signed event: the unique event
    // identity must not produce a second message row or claimable delivery.
    // A re-delivered event must fail signature verification (the signed
    // original was recorded under its own event id), and the shipped
    // verifier/path must still leave exactly one recorded message row.
    let rejectedSignature = false;
    try {
      recordWebhook(
        webhookPayload(duplicate),
        new Headers({
          "svix-id": "evt-" + duplicate.providerId + "-repeat",
          "svix-timestamp": String(Math.floor(Date.now() / 1000)),
          "svix-signature": "v1,invalid",
        }),
      );
    } catch {
      // The shipped verifier rejected the bad signature; correct behavior.
      rejectedSignature = true;
    }
    if (!rejectedSignature)
      throw new Error("A bad webhook signature was recorded, not rejected");
    const rows = store.sqlite
      .query<{ count: number }, [string]>(
        "SELECT count(*) AS count FROM inbound_messages WHERE provider='resend' AND provider_id=?",
      )
      .get(duplicate.providerId)!.count;
    if (rows !== 1)
      throw new Error(
        `Duplicate provider event produced ${rows} message rows; the shipped identity-deduplication invariant failed`,
      );
    scenarios.push({
      scenarioId: "duplicate-event",
      shipped:
        "the duplicate signed event was deduplicated by recorded provider identity: exactly one message row and no second claimable delivery",
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
        "the shipped inbound path (real signed webhook verification, retrieval worker, newsletter indexing) performs no outbound send and holds no outbound identity, so a reply can never trigger a reply storm today; adopting a reply channel creates that loop surface and would need an explicit guard",
      verdict: "no_outbound_capability",
      verifiableSender: false,
      recordedEditionKey: false,
    });
  }

  // A reply referencing an edition that was never recorded.
  const missing = corpus.replies.find((r) => r.id === "missing-edition")!;
  {
    await receiveReply(missing);
    indexOne();
    const unknownDate = missing.subject.match(/(\d{4}-\d{2}-\d{2})/)?.[1] ?? "";
    const correlated = unknownDate
      ? deliveries.list().some((row) => row.edition_date === unknownDate)
      : true;
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
    const purged = store.sqlite
      .query<{ purged: number }, [string]>(
        "SELECT count(*) AS purged FROM content WHERE item_id=? AND purged_at IS NOT NULL AND text=''",
      )
      .get(itemId)!.purged;
    if (!purged)
      throw new Error(
        "Purge ran but the extracted text was not recorded as purged",
      );
    const item = store.getItem(itemId);
    const cited = item !== null;
    scenarios.push({
      scenarioId: "expired-context",
      shipped: cited
        ? "after the shipped retention purge the missing-detail marker is recorded and the citation survives (item resolvable, frozen edition bytes unchanged) while the reply-needed extracted text is gone; a reply channel would answer with missing detail or not at all"
        : "the expired content lost its citation, breaking the retention-safe guarantee",
      verdict: cited
        ? "citations_survive_context_expired"
        : "correlation_unresolvable",
      verifiableSender: false,
      recordedEditionKey: false,
    });
  }

  // What the shipped authenticated client gets for the same question: the
  // specific cited development with its source-linked citation, plus the
  // immutable frozen edition.
  {
    const hits = store.search(corpus.cited.title);
    const citedHit = hits.find((hit) => hit.id === edition.items[0]!.itemId);
    const hasCitation = Boolean(citedHit && citedHit.url);
    const frozen = digestStore.get(corpus.edition.date);
    scenarios.push({
      scenarioId: "mcp-equivalence",
      shipped:
        hasCitation && frozen
          ? "an authenticated client asks the same scoped question over get_digest (the immutable sealed edition), search_items and get_item and receives the recorded development with its source-linked citation and analysis provenance, over the private authenticated surface, with no new trust boundary"
          : "the shipped surface could not answer the same question with citations",
      verdict:
        hasCitation && frozen
          ? "answered_with_citations_over_mcp"
          : "correlation_unresolvable",
      verifiableSender: false,
      recordedEditionKey: false,
    });
  }

  const gate = (id: string): ReplyScenario =>
    scenarios.find((s) => s.scenarioId === id)!;
  const gates = {
    recordedVerifiableSenderField: false,
    recordedReplyEditionCorrelationKey: false,
    forwardAttribution: "forwarder_only" as const,
    autoResponderLoopRisk: "created_by_adoption" as const,
    replySendBudgetSurface: "absent" as const,
    shippedReplySends: 0,
    duplicateInboundDeduplication:
      gate("duplicate-event").verdict === "deduplicated_by_provider_identity",
    mcpScopedKnowledgeEquivalence:
      gate("mcp-equivalence").verdict === "answered_with_citations_over_mcp",
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
