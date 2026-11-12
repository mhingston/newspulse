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
