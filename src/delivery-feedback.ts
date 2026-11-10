import type { Database } from "bun:sqlite";
import type { DeliveryEmailProvider, DeliveryMessage } from "./delivery";
import { deliverableDigest } from "./email-feedback";

export interface FeedbackDeliveryConfig {
  secret: string;
  baseUrl: string;
}

/**
 * Inject narrowly scoped feedback links into the outbound body at send time.
 * The frozen edition row stays immutable: links live in `digest_feedback_tokens`
 * and are re-derived deterministically for retries, so a retry sends the same
 * addresses without recording anything about the recipient.
 */
export class FeedbackLinkDelivery implements DeliveryEmailProvider {
  constructor(
    private readonly db: Database,
    private readonly inner: DeliveryEmailProvider,
    private readonly config: FeedbackDeliveryConfig,
    private readonly now: () => number = Date.now,
  ) {}

  send(
    message: DeliveryMessage,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<{ id: string }> {
    const { html, text } = this.render(message);
    return this.inner.send({ ...message, html, text }, idempotencyKey, signal);
  }

  private render(message: DeliveryMessage): { html: string; text: string } {
    if (!message.digestId || !message.editionDate)
      return { html: message.html, text: message.text };
    const targets = feedbackTargets(message.decisions);
    if (targets.length === 0) return { html: message.html, text: message.text };
    return deliverableDigest(this.db, {
      secret: this.config.secret,
      baseUrl: this.config.baseUrl,
      digestId: message.digestId,
      editionDate: message.editionDate,
      html: message.html,
      text: message.text,
      feedbackTargets: targets,
      now: this.now(),
    });
  }
}

function feedbackTargets(
  decisions: string | undefined,
): { itemId: string; actions: ("useful" | "not_useful")[] }[] {
  if (!decisions) return [];
  try {
    const parsed = JSON.parse(decisions) as {
      feedbackTargets?: { itemId?: unknown; actions?: unknown }[];
    };
    if (!Array.isArray(parsed.feedbackTargets)) return [];
    return parsed.feedbackTargets
      .filter(
        (
          target,
        ): target is { itemId: string; actions: ("useful" | "not_useful")[] } =>
          typeof target?.itemId === "string" &&
          Array.isArray(target.actions) &&
          target.actions.every(
            (action) => action === "useful" || action === "not_useful",
          ),
      )
      .map((target) => ({ itemId: target.itemId, actions: target.actions }));
  } catch {
    return [];
  }
}
