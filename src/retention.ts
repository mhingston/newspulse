/**
 * Disposable derived-content retention. Only classes listed here may be
 * removed. Identity, provenance, observations, scores, frozen editions,
 * delivery and feedback history are never affected. Defaults retain data
 * indefinitely; an operator must opt in with an explicit age window.
 */
export const RETENTION_CLASSES = [
  "extracted_payload",
  "analysis_summary",
  "feed_text",
] as const;
export type RetentionClass = (typeof RETENTION_CLASSES)[number];

export interface RetentionPolicy {
  extractedPayloadDays?: number;
  analysisSummaryDays?: number;
  inboundBodyDays?: number;
  feedTextDays?: number;
}

export const DAY_MS = 86_400_000;
const MAX_DAYS = 36_500;

function days(name: string, value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  if (!/^[1-9][0-9]{0,4}$/.test(value.trim()))
    throw new Error(`${name} must be a positive whole number of days`);
  const parsed = Number(value.trim());
  if (parsed > MAX_DAYS) throw new Error(`${name} exceeds ${MAX_DAYS} days`);
  return parsed;
}

/** Parses the opt-in retention windows; each unset variable retains its class indefinitely. */
export function retentionPolicy(
  env: Record<string, string | undefined> = process.env,
): RetentionPolicy {
  return {
    extractedPayloadDays: days(
      "RETENTION_EXTRACTED_PAYLOAD_DAYS",
      env.RETENTION_EXTRACTED_PAYLOAD_DAYS,
    ),
    analysisSummaryDays: days(
      "RETENTION_ANALYSIS_SUMMARY_DAYS",
      env.RETENTION_ANALYSIS_SUMMARY_DAYS,
    ),
    inboundBodyDays: days(
      "RETENTION_INBOUND_BODY_DAYS",
      env.RETENTION_INBOUND_BODY_DAYS,
    ),
    feedTextDays: days(
      "RETENTION_FEED_TEXT_DAYS",
      env.RETENTION_FEED_TEXT_DAYS,
    ),
  };
}

export function retentionCutoff(
  policy: RetentionPolicy,
  cls: RetentionClass | "inbound_body",
  now: number,
): number | null {
  const window =
    cls === "extracted_payload"
      ? policy.extractedPayloadDays
      : cls === "analysis_summary"
        ? policy.analysisSummaryDays
        : cls === "feed_text"
          ? policy.feedTextDays
          : policy.inboundBodyDays;
  if (window === undefined) return null;
  return now - window * DAY_MS;
}

/** Tombstone stored in place of a removed payload so reads cannot mistake it for empty text. */
export const PURGED_EXTRACTION = JSON.stringify({
  status: "purged",
  reason: "retention",
});

/**
 * Feed text is not replaced by a sentinel string: a non-blank tombstone would
 * be diffed as real content by observed-update and delivery-history, and a
 * blank one would trigger re-extraction. The explicit `purged_at` marker on
 * `content` and `content_versions` is the only signal, and every comparison
 * reader excludes marked rows. The stored text is cleared, but each version
 * first records a body fingerprint (`content_versions.text_fingerprint`) so a
 * later re-poll can still tell an unchanged body from a changed one. An
 * observation that was already empty records the empty fingerprint, keeping it
 * distinguishable from a legacy tombstone whose body is unknown.
 */

/** Tombstone for a removed analysis summary; never reusable as a cached analysis. */
export const PURGED_ANALYSIS = '{"purged":true}';

/**
 * Stored in `inbound_messages.body` once the provider body is removed. The
 * body is only read for indexing, and an indexed message is never re-read,
 * so the tombstone is never parsed as an email.
 */
export const PURGED_INBOUND_BODY = JSON.stringify({
  status: "purged",
  reason: "retention",
});
