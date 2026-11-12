import { z } from "zod";
const schema = z
  .object({
    DB_PATH: z.string().default("./data/newspulse.sqlite"),
    HOST: z.string().default("127.0.0.1"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    MCP_TOKEN: z.string().trim().min(24),
    ALLOWED_HOSTS: z.string().default("localhost,127.0.0.1"),
    TRUSTED_PRIVATE_FEEDS: z.string().default(""),
    ALLOWED_ORIGINS: z.string().default(""),
    POLL_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
    POLL_PER_HOST_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(1),
    GITHUB_TOKEN: z
      .string()
      .trim()
      .min(1)
      .optional()
      .or(z.literal("").transform(() => undefined)),
    RESEND_API_KEY: z
      .string()
      .trim()
      .min(1)
      .optional()
      .or(z.literal("").transform(() => undefined)),
    RESEND_WEBHOOK_SECRET: z
      .string()
      .trim()
      .min(1)
      .optional()
      .or(z.literal("").transform(() => undefined)),
  })
  .refine(
    (value) => !value.RESEND_WEBHOOK_SECRET || Boolean(value.RESEND_API_KEY),
    {
      message: "RESEND_WEBHOOK_SECRET requires RESEND_API_KEY",
    },
  );
export function config(env: Record<string, string | undefined> = process.env) {
  return schema.parse(env);
}
