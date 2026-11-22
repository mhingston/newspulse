import { z } from "zod";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Plain HTTP is allowed only for loopback endpoints, such as a local gateway. */
export function isAllowedAnalysisEndpoint(s: string): boolean {
  const u = new URL(s);
  return (
    (u.protocol === "https:" ||
      (u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname))) &&
    !u.username &&
    !u.password &&
    !u.search &&
    !u.hash
  );
}

const schema = z
  .object({
    ANALYSIS_ENDPOINT: z.url().refine(isAllowedAnalysisEndpoint),
    ANALYSIS_KEY: z.string().trim().min(1),
    ANALYSIS_MODEL: z.string().trim().min(1),
    ANALYSIS_TOTAL_TOKENS: z.coerce.number().int().safe().positive().min(18000),
    ANALYSIS_TOTAL_MICROS: z.coerce.number().int().safe().positive(),
    ANALYSIS_CALL_MICROS: z.coerce.number().int().safe().positive(),
    ANALYSIS_DAILY_MICROS: z.coerce.number().int().safe().positive().optional(),
    ANALYSIS_MAX_OUTPUT_TOKENS: z.coerce
      .number()
      .int()
      .safe()
      .positive()
      .max(16000)
      .optional(),
    ANALYSIS_REASONING_EFFORT: z
      .enum(["none", "minimal", "low", "medium", "high"])
      .optional()
      .or(z.literal("").transform(() => undefined)),
  })
  .refine((x) => x.ANALYSIS_CALL_MICROS <= x.ANALYSIS_TOTAL_MICROS)
  .refine(
    (x) =>
      x.ANALYSIS_DAILY_MICROS === undefined ||
      x.ANALYSIS_DAILY_MICROS >= x.ANALYSIS_CALL_MICROS,
  );
export function analysisConfig(
  env: Record<string, string | undefined> = process.env,
) {
  const keys = [
    "ANALYSIS_ENDPOINT",
    "ANALYSIS_KEY",
    "ANALYSIS_MODEL",
    "ANALYSIS_TOTAL_TOKENS",
    "ANALYSIS_TOTAL_MICROS",
    "ANALYSIS_CALL_MICROS",
  ];
  if (!keys.some((k) => (env[k] ?? "").trim() !== "")) return null;
  const parsed = schema.parse(env);
  return {
    endpoint: parsed.ANALYSIS_ENDPOINT,
    apiKey: parsed.ANALYSIS_KEY,
    model: parsed.ANALYSIS_MODEL,
    maxTokens: parsed.ANALYSIS_TOTAL_TOKENS,
    maxMicros: parsed.ANALYSIS_TOTAL_MICROS,
    maxDailyMicros: parsed.ANALYSIS_DAILY_MICROS ?? null,
    maxOutputTokens: parsed.ANALYSIS_MAX_OUTPUT_TOKENS ?? 4000,
    reasoningEffort: parsed.ANALYSIS_REASONING_EFFORT,
    reserveTokens: 18000,
    reserveMicros: parsed.ANALYSIS_CALL_MICROS,
  };
}

/** Status-only: a malformed analysis setting must not make status unreadable. */
export function analysisDailyLimitOrUndefined(
  env: Record<string, string | undefined> = process.env,
): number | undefined {
  try {
    return analysisConfig(env)?.maxDailyMicros ?? undefined;
  } catch {
    return undefined;
  }
}

/** Processing stages that run in this configuration; idle stages are not warned about. */
export function enabledProcessingStages(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const analysisOn = !!analysisConfig(env);
  return ["extract", "score", "group", ...(analysisOn ? ["analyse"] : [])];
}
