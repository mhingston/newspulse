import { z } from "zod";

// A cost reservation is mandatory even when the provider does not report usage.
const schema = z
  .object({
    DISCOVERY_DAILY_QUERIES: z.coerce
      .number()
      .int()
      .safe()
      .min(1)
      .max(1000)
      .default(10),
    DISCOVERY_RUN_QUERIES: z.coerce
      .number()
      .int()
      .safe()
      .min(1)
      .max(20)
      .default(1),
    DISCOVERY_DAILY_RESULTS: z.coerce
      .number()
      .int()
      .safe()
      .min(1)
      .max(250000)
      .default(250),
    DISCOVERY_RUN_RESULTS: z.coerce
      .number()
      .int()
      .safe()
      .min(1)
      .max(5000)
      .default(25),
    DISCOVERY_DAILY_MICROS: z.coerce.number().int().safe().positive(),
    DISCOVERY_RUN_MICROS: z.coerce.number().int().safe().positive(),
    DISCOVERY_QUERY_MICROS: z.coerce.number().int().safe().positive(),
  })
  .refine(
    (v) =>
      v.DISCOVERY_QUERY_MICROS <= v.DISCOVERY_RUN_MICROS &&
      v.DISCOVERY_RUN_MICROS <= v.DISCOVERY_DAILY_MICROS &&
      v.DISCOVERY_RUN_QUERIES <= v.DISCOVERY_DAILY_QUERIES &&
      v.DISCOVERY_RUN_RESULTS <= v.DISCOVERY_DAILY_RESULTS,
    "Discovery run limits must fit daily limits and each query must fit the run budget",
  );

/** Status-only: a malformed discovery setting must not make health unreadable. */
export function discoveryLimitsOrUndefined(
  env: Record<string, string | undefined> = process.env,
) {
  try {
    const { maxQueriesPerDay, maxResultsPerDay, maxCostMicrosPerDay } =
      discoveryConfig(env);
    return { maxQueriesPerDay, maxResultsPerDay, maxCostMicrosPerDay };
  } catch {
    return undefined;
  }
}

export function discoveryConfig(
  env: Record<string, string | undefined> = process.env,
) {
  const v = schema.parse(env);
  return {
    maxQueriesPerDay: v.DISCOVERY_DAILY_QUERIES,
    maxQueriesPerRun: v.DISCOVERY_RUN_QUERIES,
    maxResultsPerDay: v.DISCOVERY_DAILY_RESULTS,
    maxResultsPerRun: v.DISCOVERY_RUN_RESULTS,
    maxCostMicrosPerDay: v.DISCOVERY_DAILY_MICROS,
    maxCostMicrosPerRun: v.DISCOVERY_RUN_MICROS,
    reservedCostMicrosPerQuery: v.DISCOVERY_QUERY_MICROS,
  };
}
