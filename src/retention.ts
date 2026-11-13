/**
 * Disposable derived-content retention. Only classes listed here may be
 * removed. Identity, provenance, observations, scores, frozen editions,
 * delivery and feedback history are never affected. Defaults retain data
 * indefinitely; an operator must opt in with an explicit age window.
 */
export const RETENTION_CLASSES = [
  "extracted_payload",
  "analysis_summary",
] as const;
export type RetentionClass = (typeof RETENTION_CLASSES)[number];

export interface RetentionPolicy {
  extractedPayloadDays?: number;
  analysisSummaryDays?: number;
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

/** Parses `RETENTION_EXTRACTED_PAYLOAD_DAYS` and `RETENTION_ANALYSIS_SUMMARY_DAYS`. */
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
  };
}

export function retentionCutoff(
  policy: RetentionPolicy,
  cls: RetentionClass,
  now: number,
): number | null {
  const window =
    cls === "extracted_payload"
      ? policy.extractedPayloadDays
      : policy.analysisSummaryDays;
  if (window === undefined) return null;
  return now - window * DAY_MS;
}

/** Tombstone stored in place of a removed payload so reads cannot mistake it for empty text. */
export const PURGED_EXTRACTION = JSON.stringify({
  status: "purged",
  reason: "retention",
});
