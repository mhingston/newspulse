import { z } from "zod";
import { discoveryConfig } from "./discovery-config";

const optionalSchema = z.object({
  GITHUB_DISCOVERY_ENABLED: z.string().default("false"),
  GITHUB_DISCOVERY_HOURS: z.coerce.number().int().min(1).max(168).default(24),
  GITHUB_DISCOVERY_WINDOW_DAYS: z.coerce
    .number()
    .int()
    .min(1)
    .max(365)
    .default(90),
});

export interface GithubDiscoveryConfig {
  limits: ReturnType<typeof discoveryConfig>;
  intervalMs: number;
  windowDays: number;
}

export function githubDiscoveryConfig(
  env: Record<string, string | undefined> = process.env,
): GithubDiscoveryConfig | undefined {
  const base = optionalSchema.parse(env);
  if (base.GITHUB_DISCOVERY_ENABLED !== "true") return undefined;
  return {
    limits: discoveryConfig(env),
    intervalMs: base.GITHUB_DISCOVERY_HOURS * 3_600_000,
    windowDays: base.GITHUB_DISCOVERY_WINDOW_DAYS,
  };
}
