import { z } from "zod";
import { discoveryConfig } from "./discovery-config";

const optionalSchema = z.object({
  DISCOVERY_SCHEDULE_ENABLED: z.string().default("false"),
  DISCOVERY_SCHEDULE_HOURS: z.coerce.number().int().min(1).max(168).default(24),
  DISCOVERY_ADJACENT_PERCENT: z.coerce
    .number()
    .int()
    .min(0)
    .max(75)
    .default(20),
});

export function scheduledDiscoveryConfig(
  env: Record<string, string | undefined> = process.env,
) {
  const base = optionalSchema.parse(env);
  if (base.DISCOVERY_SCHEDULE_ENABLED !== "true") return undefined;
  return {
    limits: discoveryConfig(env),
    intervalMs: base.DISCOVERY_SCHEDULE_HOURS * 3_600_000,
    adjacentPercent: base.DISCOVERY_ADJACENT_PERCENT,
  };
}
