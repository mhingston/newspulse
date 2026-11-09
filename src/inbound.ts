/** Normalized provider identities are separate from RFC Message-ID headers. */
export interface InboundEmailMetadata {
  providerId: string;
  receivedAt: number;
  from: string;
  to: string[];
  subject: string;
  messageId: string | null;
  receivedFor: string[];
}
export interface VerifiedInboundEvent {
  eventId: string;
  metadata: InboundEmailMetadata;
}
export interface ReceivedEmail {
  metadata: InboundEmailMetadata;
  text: string | null;
  html: string | null;
}
export interface ReceivedEmailPage {
  items: InboundEmailMetadata[];
  hasMore: boolean;
}
export interface InboundEmailProvider {
  verifyWebhook(
    payload: string,
    headers: { id: string; timestamp: string; signature: string },
  ): VerifiedInboundEvent;
  get(id: string, signal?: AbortSignal): Promise<ReceivedEmail>;
  list(after?: string, signal?: AbortSignal): Promise<ReceivedEmailPage>;
}
export class InboundProviderError extends Error {
  constructor(
    readonly kind: "transient" | "unavailable" | "invalid",
    message: string,
  ) {
    super(message);
  }
}
