import { z } from "zod";
const schema = z
  .object({
    ANALYSIS_ENDPOINT: z.url().refine((s) => {
      const u = new URL(s);
      return (
        u.protocol === "https:" &&
        !u.username &&
        !u.password &&
        !u.search &&
        !u.hash
      );
    }),
    ANALYSIS_KEY: z.string().trim().min(1),
    ANALYSIS_MODEL: z.string().trim().min(1),
    ANALYSIS_TOTAL_TOKENS: z.coerce.number().int().safe().positive().min(18000),
    ANALYSIS_TOTAL_MICROS: z.coerce.number().int().safe().positive(),
    ANALYSIS_CALL_MICROS: z.coerce.number().int().safe().positive(),
  })
  .refine((x) => x.ANALYSIS_CALL_MICROS <= x.ANALYSIS_TOTAL_MICROS);
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
    reserveTokens: 18000,
    reserveMicros: parsed.ANALYSIS_CALL_MICROS,
  };
}

/** Processing stages that run in this configuration; idle stages are not warned about. */
export function enabledProcessingStages(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const analysisOn = !!analysisConfig(env);
  return ["extract", "score", "group", ...(analysisOn ? ["analyse"] : [])];
}
