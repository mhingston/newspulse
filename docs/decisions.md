# Product and architecture decisions

These decisions preserve the original handoff rather than replacing it. Status is **accepted direction** unless explicitly marked as an M1 implementation fact or optional evaluation. Implementation progress lives in [the roadmap](roadmap.md) and linked issues. The user's later instructions can revise a decision; record the reason and consequences here when that happens.

## D1 — Discovery is the product

The service should surface worthwhile ideas and developments outside followed sources, preserve history, and offer conversation through MCP plus a curated daily briefing. It is not a full-featured RSS reader or unread-count UI. Feed ingestion is a foundation, not the product's completion criterion. Basis: handoff §§1, 8, 9, 10, 12.

## D2 — One small self-hosted application

Use Bun, strict TypeScript, Hono, SQLite through `bun:sqlite`, Drizzle migrations, FTS5, the official MCP SDK, `Bun.cron` and Docker Compose with a persistent volume. M1 tested Bun 1.4.4 and exactly pinned dependencies. Domain rules stay independent of the runtime/provider, with small adapter boundaries. Exclude microservices, distributed queues, a separate DB service, mandatory local models, vector databases and agent frameworks. Basis: §§3, 14; observed M1 manifest, migrations and Compose configuration.

## D3 — Processing runs continuously, publication separately

Persist/index at ingestion, then independently extract, analyse, score and expose availability. Pending/failed AI must not hide collected items or stop other sources. Publication selects already processed content. Developing digest reads use completed scores; freezing captures an immutable prepared snapshot and is not evidence of delivery. Scheduling callbacks only wake durable SQLite jobs; they do not own recoverable state. Preserve retries, bounded work, leases and fencing. Basis: §§4, 11. Extraction and deterministic scoring handlers run independently of optional analysis; existing extracted items are queued by migration and remain searchable while processing is pending.

## D4 — Identity and attribution are independent

A canonical item can have many source-native references and parents. Email originals may lack a public URL and must remain searchable after their article links are expanded. Preserve original and resolved URLs where useful. Canonical URL cleanup must not erase meaningful parameters or merge broad-topic coverage. M1 handles exact URL identity and conservative digest fan-out; semantic/event grouping is future work. Basis: §§5, 6, 10.

## D5 — Interests and editorial rules are separate, versioned objects

Interests describe what matters to this user; editorial profiles describe how a content type is evaluated and presented. Priorities, positive/negative preferences, search queries, expiry, criteria, model provenance and explicit feedback need persistent versioning. Unread or missing clicks must never become negative feedback. Samples are not real user preferences. Basis: §§6, 7.

## D6 — Deterministic decisions first, bounded optional AI

Use deterministic filtering, ranking, novelty, redundancy and curation wherever practical. Use OpenAI-compatible providers for structured analysis behind a small interface; optional specialist judgments must expose their provenance and failure fallback. The initial scoring baseline records its components, versioned profiles and uncertainty, and does not infer prior publication from grouping or source edits. Prior-presentation redundancy and its production acceptance are assigned to required follow-up #42 after immutable editions and delivery state exist. Offline regression reports preserve explicit label coverage and unknown cost; synthetic fixtures do not establish real-world quality. Do not build an internal conversational assistant. Embeddings require a measured retrieval gap after simpler FTS improvements have been evaluated. Basis: §§3, 6, 7, 9, 13, 14.

## D7 — Discovery is explicit, budgeted and auditable

Begin with bounded scheduled queries from active interests, persist query lineage/results/cost/yield, and reserve some capacity for adjacent interests and unexpected connections. Refine from explicit feedback, without an autonomous loop. Provider availability, terms, limits and cost must be validated when an adapter is implemented; the handoff's provider examples are candidates, not a claim all APIs exist. Basis: §§7, 8, 13.

## D8 — Private MCP is the first interface

Use official SDK Streamable HTTP and source-linked tools; stdio is optional. Read tools precede mutation tools. The connecting client reasons conversationally; service responses distinguish source claims, summaries, uncertainty and unavailable content. MCP/admin stay private and authenticated. Only an appropriately signature-verified incoming webhook becomes public. Consequential mutations need scoped confirmation. Basis: §§3, 5, 9, 11. M1 provides four read tools; the full tool list remains planned.

## D9 — Email originals and delivery have durable state

Resend is the initial inbound/outbound provider, isolated behind small interfaces so IMAP can follow later without changing domain logic. Verify and persist webhook events quickly, then retrieve/process asynchronously; reconcile received-email listings for missed events. Freeze immutable digest editions and durable send state before calling the provider. Use provider idempotency within its actual guarantees; an unknown send beyond the key lifetime must be reconciled rather than retried blindly. Basis: §§5, 10, 11. Default publication is configurable 06:00 Europe/London, with persisted local edition identity and DST tests.

## D10 — History outlives disposable content

Separate raw/content retention from stable identity, provenance, grouping, feedback and publication metadata. Historical editions and ranking explanations must remain understandable after model/profile changes or content expiry. Defaults retain data until configured cleanup is explicitly introduced; operators choose documented retention policies. Backup/restore is a core operational feature. Restoring a pre-send snapshot requires provider reconciliation before re-enabling delivery. Basis: §§6, 9, 10, 11.

## D11 — HTTP/API first, browser only where justified and permitted

Prefer ordinary HTTP extraction and structured APIs for GitHub/HN. Reddit initially comes through search results, newsletter notifications and manual submissions; unavailable source content must be labeled honestly. An optional browser interface may support a permitted fallback, with concurrency/time/resource limits and failure isolation. Browser automation must never become core infrastructure or circumvent access restrictions. Basis: §5; M5 evaluates concrete browser implementation.

## D12 — Completion means evidence, not issue-count reduction

Use versioned recorded evaluation data, offline score replay, source-linked outputs and failure-injection tests. Measure relevant discoveries beyond subscriptions, top-result precision, duplicates, known-important-development misses, source reliability, cost/useful discovery and latency. Capture a comparable Newsweave baseline when practical and report when it is unavailable. Required issues need merged, verified behavior. M5 refinements and optional stdio require a documented evaluation and implemented adoption or justified non-adoption; optional ideas do not become mandatory features merely because they have tracking issues. Basis: §§12–15.

## D13 — Story groups are explainable and independent of item identity

A specific-development group is a _relationship_ among canonical items, not a replacement for any item or original source citation. Prefer deterministic, negative-tested lexical, entity, version, temporal and content-hash evidence to an unmeasured semantic model. Persist the rule version and explicit membership evidence. Corrections end memberships and retain their audit trail; a later substantive update is a distinct group with an optional directional historical link. Reconciliation runs through durable processing jobs and avoids paid analysis. Snapshot-wide calculation is the initial implementation, not an indefinitely accepted scalability guarantee. No vector store, mandatory model, external queue or publisher rewrite is justified by #6.

## Updating decisions

For a consequential change, record the affected D-number, evidence, chosen alternative, compatibility/data consequences and rollback. Update the affected issue and operator-facing README. Do not silently change the product toward reader UI, uncontrolled discovery spend or a provider-specific conversational system. The original handoff is an archived requirement source; new approved decisions are recorded here, not retroactively edited into it.

Inbound implementation: verified raw Resend webhooks commit message/event identities before acknowledgement; bounded background Receiving get/list requests use durable fenced leases and a paginated full rescan for overlap. Provider IDs remain distinct from RFC Message-ID. Bodies remain untrusted; attachments are not fetched. Retrieved newsletters become URL-optional, independently searchable original items; linked articles enter the shared ingestion pipeline with parent attribution and canonical deduplication. Filter newsletter chrome and tracking conservatively without fetching arbitrary redirect URLs. Missing bodies and unsupported attachments remain explicit limitations. A single service instance enforces the configured request cadence.

### Outbound delivery and deferred acceptance

The #12 implementation uses a conservative 23-hour retry window within Resend's documented 24-hour idempotency retention, and treats an unknown outcome beyond that window as requiring operator reconciliation. The first possible attempt and immutable envelope are persisted before network work. An exclusive process lock and payload-bound confirmation protect reconciliation. Provider acceptance is not inbox delivery.

Catch-up has an unresolved boundary: prior-day drafts cannot be reconstructed from the current mutable scores and grouping snapshots. The current implementation can enqueue an already-frozen missed edition and records other missed days as skipped; The user authorized deferring point-in-time reconstruction of unfrozen missed editions to required issue [#48](https://github.com/mhingston/newspulse/issues/48). The required feedback links and mixed-edition link test remain assigned to [#18](https://github.com/mhingston/newspulse/issues/18); the HTTP boundary permits only the verified inbound webhook to be public.
