import { z } from "zod";
const schema = z.object({
  DB_PATH: z.string().default("./data/newspulse.sqlite"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  MCP_TOKEN: z.string().trim().min(24),
  ALLOWED_HOSTS: z.string().default("localhost,127.0.0.1"),
  TRUSTED_PRIVATE_FEEDS: z.string().default(""),
  ALLOWED_ORIGINS: z.string().default(""),
});
export function config(env: Record<string, string | undefined> = process.env) {
  return schema.parse(env);
}
