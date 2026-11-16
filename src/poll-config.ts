import { z } from "zod";

const schema = z.object({
  POLL_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
  POLL_PER_HOST_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(1),
  EXTRACT_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),
  SCORE_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),
});

/** Poll and processing limits only, so local CLI commands do not require HTTP credentials. */
export function pollConfig(
  env: Record<string, string | undefined> = process.env,
) {
  const parsed = schema.parse(env);
  return {
    concurrency: parsed.POLL_CONCURRENCY,
    perHost: parsed.POLL_PER_HOST_CONCURRENCY,
  };
}

const groupingSchema = z.object({
  GROUPING_BATCH_SIZE: z.coerce.number().int().min(1).max(10000).default(50),
  GROUPING_MAX_DELAY_MS: z.coerce
    .number()
    .int()
    .min(0)
    .max(3600000)
    .default(30000),
});

/**
 * Story-grouping replan batching. A replan runs once `GROUPING_BATCH_SIZE`
 * inputs are waiting, or once the oldest waits `GROUPING_MAX_DELAY_MS`.
 */
export function groupingConfig(
  env: Record<string, string | undefined> = process.env,
) {
  const parsed = groupingSchema.parse(env);
  return {
    batch: parsed.GROUPING_BATCH_SIZE,
    maxDelayMs: parsed.GROUPING_MAX_DELAY_MS,
  };
}

/**
 * Per-stage processing ceilings for local work. Analysis and grouping are
 * intentionally absent: analysis stays at one because the cost ledger assumes a
 * single reservation at a time, and grouping reconciles one snapshot under an
 * immediate transaction so extra parallelism only adds stale retries.
 */
export function stageConcurrencyConfig(
  env: Record<string, string | undefined> = process.env,
) {
  const parsed = schema.parse(env);
  return {
    extract: parsed.EXTRACT_CONCURRENCY,
    score: parsed.SCORE_CONCURRENCY,
  };
}
