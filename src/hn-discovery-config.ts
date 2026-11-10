import { z } from "zod";
import { discoveryConfig } from "./discovery-config";

const optionalSchema = z.object({
  HN_DISCOVERY_ENABLED: z.string().default("false"),
  HN_DISCOVERY_HOURS: z.coerce.number().int().min(1).max(168).default(24),
});

export interface HnDiscoveryConfig {
  limits: ReturnType<typeof discoveryConfig>;
  intervalMs: number;
}

export function hnDiscoveryConfig(
  env: Record<string, string | undefined> = process.env,
): HnDiscoveryConfig | undefined {
  const base = optionalSchema.parse(env);
  if (base.HN_DISCOVERY_ENABLED !== "true") return undefined;
  return {
    limits: discoveryConfig(env),
    intervalMs: base.HN_DISCOVERY_HOURS * 3_600_000,
  };
}
