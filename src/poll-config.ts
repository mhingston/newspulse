import { z } from "zod";

const schema = z.object({
  POLL_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
  POLL_PER_HOST_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(1),
});

/** Poll limits only, so local CLI commands do not require HTTP credentials. */
export function pollConfig(
  env: Record<string, string | undefined> = process.env,
) {
  const parsed = schema.parse(env);
  return {
    concurrency: parsed.POLL_CONCURRENCY,
    perHost: parsed.POLL_PER_HOST_CONCURRENCY,
  };
}
