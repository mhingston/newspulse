# M1 design and implementation notes

The initial handoff task's implementation boundary was M1. The first usable release definition needs M2–M3 capabilities (RSS + newsletters + accessible knowledge + daily email); proactive discovery in M4 completes the broader core mission. This foundation does not claim either is complete. The full handoff is archived in [handoff.md](handoff.md), durable decisions are in [decisions.md](decisions.md), and the [roadmap](roadmap.md) links every remaining requirement to an issue.

## Module boundaries

- `domain.ts`: provider-independent candidate, adapter and identity contracts.
- `adapters/rss.ts`, `adapters/feed-xml.ts`, `adapters/feed-encoding.ts`, `adapters/opml.ts`: namespace-aware ordered XML/text-construct parsing, byte decoding, bounded HTTP polling and OPML.
- `db/schema.ts`, `db/store.ts`, `drizzle/`: Drizzle schema and versioned migrations; SQLite-specific transactional repository.
- `worker.ts`: durable job runner and Bun scheduling shell.
- `mcp.ts`, `http.ts`: official SDK Streamable HTTP tools and authenticated Hono routing.
- `cli.ts`, `main.ts`, `lifecycle.ts`: operational entry points and coordinated HTTP/worker shutdown.

The adapter returns data, never database operations. Domain types have no Bun or provider dependency. SQLite and scheduling are explicitly Bun-specific infrastructure. MCP clients supply conversational reasoning; source text is labeled untrusted and summaries unavailable. No content is executed or given access to privileged tools.

## Initial schema

`sources` stores subscription configuration and health. `source_state` stores HTTP validators. `items` stores canonical identity independently of a public URL. `item_sources` preserves each source-native ID, original URL and digest parent. `content` stores cleaned feed text. `jobs` stores attempts, due times and fenced leases. `items_fts` indexes titles and text, maintained by migration-owned triggers.

URL identity strips fragments and known tracking parameters and sorts remaining query parameters. Original resolved citations are carried separately through candidates and stored in `item_sources.url`, including digest children; canonical `items.url` remains the deduplication key. It does not merge HTTP with HTTPS or guess equivalent publishers. Without a URL, identity is scoped to the source and stable native ID. Semantic deduplication belongs to M2. Empty digest placeholders can be enriched when another source supplies a body; a missing publication timestamp is filled without overwriting an existing date. Repeat native IDs are otherwise immutable in M1; publisher corrections are not refreshed yet.

Drizzle Kit generated the relational baseline. FTS and its triggers use a separate checked-in custom migration, registered in the Drizzle journal. Use `bun run db:generate` for relational changes; use `bunx drizzle-kit generate --custom --name=<name>` for future FTS changes. Do not use `drizzle-kit push` in deployed databases.

## Processing and recovery

A startup tick, a minute `Bun.cron` callback, and a one-second queue pump reconcile due sources. SQLite's persisted `next_poll` and job timestamps determine work; schedules do not carry durable state. Catch-up coalesces missed intervals into one poll per source. A partial unique index permits only one active poll per source. The initial single worker bounds HTTP concurrency to one; source intervals and Retry-After bound request frequency.

Jobs are atomically claimed using an immediate transaction. A 60-second lease has a random fencing token. Polling has a 20-second request/body timeout and 5 MB response budget. Items, provenance, validators, source health and job success commit in one short transaction after fetching. Stale workers cannot commit after their lease expires. Five attempts use exponential backoff starting at 30 seconds, honoring Retry-After up to 24 hours. After terminal failure the next scheduled poll starts a fresh job, keeping subscriptions recoverable. Failed sources do not block healthy ones. Shutdown signals both the scheduler and HTTP server before awaiting either drain, then closes SQLite after both finish. New claims stop while the active poll finishes; queued work stays persisted for restart.

FTS results are immediately available after ingestion. Status stays `ingested`: full-article extraction, analysis and scoring are separate future stages. Digest-like entries with at least five unique links across three hosts retain their original item and fan out up to 50 attributed candidates. Child candidates have titles/URLs but no fetched article body in M1. Feed responses process up to 1,000 entries; older entries beyond that cap are not backfilled.

No raw XML/HTML is retained. Metadata, cleaned content and job history currently have indefinite retention. Backups use SQLite `VACUUM INTO`, which includes committed WAL contents and FTS consistently. Restore checks integrity and requires an unused target path; stop the service and retain the old database until validation succeeds.

## Reference review

Reviewed on 2026-11-08 (Newsweave `6d2d1930947f3a6eadf4b23e9669dfdab3dae18e`; Horizon `0a8d740b1a774f27ba9ffb612227ab87832a138c`):

- [Newsweave](https://github.com/mhingston/newsweave): `ingest.ts` separates canonical items and source entries and retains fan-out attribution; `process.ts` illustrates stale recovery and attempts; `extractor.ts` isolates extraction; `decision.ts` keeps specialist scoring optional. Its publishing flow sends before persisting the edition, which this project must not copy in M3: persist immutable editions and send state first, with provider idempotency.
- [Horizon](https://github.com/Thysrael/Horizon): `scrapers/base.py` has a normalized adapter contract and per-source outcomes; `scrapers/rss.py` bounds concurrency and handles rate limits; `processing/profiles.py` separates structured editorial profiles; `mcp/server.py` exposes operations with diagnostics. Adopt small adapters and explicit health, without importing its full pipeline or agent orchestration.

M1 does not copy either implementation. Newsweave's AI baseline needs recorded inputs and labels before an honest scoring comparison is possible.

## Compatibility evidence

Tested Bun 1.4.4 with exact dependency versions in `package.json` and `bun.lock`. Checked current [Bun cron documentation](https://bun.com/docs/runtime/cron) and installed Bun declarations; the callback overload actually runs during the smoke test. Official MCP SDK 1.32.2's Web Standard transport documents Bun/Hono support; an actual SDK HTTP client initializes, lists tools and retrieves items in tests. Drizzle ORM 0.45.4 migrations, WAL, FTS triggers and backup reopen run in integration tests. Resend 6.37.0 loads under Bun and exposes receiving get/list, send and webhook verification APIs; no provider requests or signature verification are implemented or claimed in M1. Provider contract integration belongs to M3.

## Later milestones

- **M2:** full-text extraction, versioned editorial/interest profiles, structured summaries, deterministic scores and explanations, event grouping, replay evaluation fixtures and draft digest queries.
- **M3:** verified/persisted Resend webhook events, asynchronous Receiving API retrieval, reconciliation, newsletter fan-out, immutable editions and idempotent delivery at 06:00 Europe/London.
- **M4:** budgeted search discovery, GitHub/HN, explicit feedback and quality evaluation. Track useful discoveries beyond subscriptions, top-result precision, redundancy, latency and cost.
- **M5:** optional permitted browser extraction, historical tracking, alerts, measured retrieval improvements and opt-in recommendations of valuable new sources.

MCP mutations, browser automation, AI calls, embeddings, outbound email and interest inference are absent from M1.

A synthetic labeled seed fixture lives at `tests/fixtures/evaluation.json`, with relevant, irrelevant, duplicate and borderline examples. It is not a measured relevance baseline or a claim about the user’s actual interests. M2 can replay it without email delivery or external model calls.

## Feed compatibility fixes from PR review

Ordered parsing resolves Atom/RSS extension namespaces by URI plus local name, retaining namespace scope and mixed XHTML text order. Atom HTML/text/XHTML constructs are handled separately; external/empty content falls back to an available summary. HTML link attributes use a pinned `entities` decoder before URL resolution. Decoding follows RFC 7303 §3.2 BOM/HTTP charset/declaration precedence, with explicit unsupported/invalid encoding errors. No schema migration is needed for original citations or date enrichment: these use existing source-reference and timestamp columns. Previously discarded original URLs cannot be reconstructed from canonical-only stored data.
