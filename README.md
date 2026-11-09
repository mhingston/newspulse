# Newspulse

A self-hosted foundation for a personal discovery engine. **M1 is implemented:** RSS/Atom → durable SQLite ingestion → authenticated, read-only MCP search. There is no feed-reader UI. Optional analysis, deterministic story grouping and an initial scoring pipeline are part of the developing M2 milestone. Optional daily email delivery is available; proactive discovery remains a future milestone.

## Project decisions and remaining work

Start with [AGENTS.md](AGENTS.md) for contributor guidance, [decisions](docs/decisions.md) for architectural/product constraints, and the [roadmap and coverage map](docs/roadmap.md) for implementation order and dependencies. The [original handoff](docs/handoff.md) is preserved in full.

[Completion tracker #32](https://github.com/mhingston/newspulse/issues/32) links 23 required implementation/acceptance issues and 9 conditional refinement issues. Required issues need merged, verified behavior; optional ideas retain the handoff's evaluation gates. The initial “M1 only” instruction scoped PR #1; future sessions should implement a selected issue and its authorized scope rather than restart the entire handoff.

## Run locally

Install **Bun 1.4.4 or later**. Tested dependencies are exactly pinned and locked.

```sh
bun install --frozen-lockfile
cp .env.example .env
# Replace MCP_TOKEN in .env with a random value:
bun -e 'console.log(crypto.randomUUID()+crypto.randomUUID())'
bun run cli init
bun run cli import-opml /path/to/miniflux.opml
# Alternatively:
bun run cli add-source https://bun.com/rss.xml 'Bun' 1800
bun run cli poll --force
bun run cli list-sources
# Use an ID from list-sources; settings are per feed.
bun run cli update-source SOURCE_ID 'title=New title' poll-seconds=3600 max-entries=500 max-bytes=5000000
bun run cli disable-source SOURCE_ID
bun run cli enable-source SOURCE_ID
bun run cli remove-source SOURCE_ID
bun run cli search 'TypeScript'
bun start
```

The server polls on startup and continues throughout the day. Default polling is every 30 minutes, minimum 60 seconds. Configuration loads from `.env` through Bun. The example token is empty so a copied template fails closed. Supply a random token of at least 24 non-whitespace characters before starting the HTTP server. CLI commands operate locally and do not require the HTTP token.

## MCP

Connect a Streamable HTTP client to `http://127.0.0.1:3000/mcp` with header `Authorization: Bearer <MCP_TOKEN>`. The official TypeScript SDK client works directly:

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const client = new Client({ name: "personal-client", version: "1.0" });
await client.connect(
  new StreamableHTTPClientTransport(new URL("http://127.0.0.1:3000/mcp"), {
    requestInit: {
      headers: { Authorization: `Bearer ${process.env.MCP_TOKEN}` },
    },
  }),
);
const results = await client.callTool({
  name: "search_items",
  arguments: { query: "robotics", limit: 20 },
});
console.log(results);
await client.close();
```

Tools: `get_digest` (developing or frozen edition), `explain_ranking` (recorded score history and source references), `get_story_group` (development ID and preserved article references), `search_items` (literal keywords, limit, offset, optional `source_id`, `since` in epoch milliseconds), `get_item` (ID), `get_sources`, `get_status`. Search combines terms with AND. Results include canonical item URLs; `get_item` also returns all original resolved source references, including fragments and tracking context. Items without public URLs remain retrievable using their item ID and source-native reference. Source text is untrusted; model summaries and scores are estimates.

Transport is stateless Streamable HTTP with JSON responses. Stdio is optional in the handoff and not implemented. There are no mutation tools. A client with a browser Origin must appear in `ALLOWED_ORIGINS`. Hosts must appear in `ALLOWED_HOSTS`; use hostnames without ports. No CORS policy is exposed for browser apps yet.

## Docker Compose

```sh
# Set MCP_TOKEN in .env first.
docker compose up --build -d
docker compose exec newspulse bun src/cli.ts add-source https://bun.com/rss.xml Bun
docker compose exec newspulse bun src/cli.ts status
docker compose logs -f newspulse
```

Compose mounts a named persistent volume and publishes only on host loopback. The process runs as the image's `bun` user. Keep MCP and health endpoints on a private network or behind an authenticated private tunnel. When incoming email is enabled, expose only the signature-verified POST webhook through a TLS reverse proxy. Do not publish port 3000 on a public interface. For a private domain, add its hostname to `ALLOWED_HOSTS`, use TLS and retain bearer authentication. Anyone controlling CLI subscriptions can direct outbound HTTP requests; only import trusted subscription lists. Feed bodies and link text cannot alter source configuration.

## Configuration

| Variable          | Default                   | Purpose                                                  |
| ----------------- | ------------------------- | -------------------------------------------------------- |
| `DB_PATH`         | `./data/newspulse.sqlite` | Database file; Compose uses `/app/data/newspulse.sqlite` |
| `HOST`            | `127.0.0.1`               | Listen address; container uses `0.0.0.0` internally      |
| `PORT`            | `3000`                    | HTTP port                                                |
| `MCP_TOKEN`       | required                  | Private bearer token, at least 24 characters             |
| `ALLOWED_HOSTS`   | `localhost,127.0.0.1`     | Request hostname allowlist                               |
| `ALLOWED_ORIGINS` | empty                     | Permitted browser Origin values                          |

## Operations

```sh
bun run cli status
bun run cli export-opml > subscriptions.opml
bun run cli poll             # Due sources and queued retries
bun run cli poll --force     # Schedule all sources; does not bypass active retries
bun run cli backup ./backups/newspulse-2026-11-08.sqlite
# Stop the service. Restore to a NEW path, then validate before switching DB_PATH.
DB_PATH=./data/restored.sqlite bun run cli restore ./backups/newspulse-2026-11-08.sqlite
DB_PATH=./data/restored.sqlite bun run cli status
DB_PATH=./data/restored.sqlite bun run cli search robotics
```

Backup destinations must not already exist. Back up regularly and copy snapshots off-host; raw live database-file copies can omit WAL data. Treat backups as private content. In Compose, create snapshots under `/app/data/backups` and use `docker compose cp` to export them. Stop Compose before restoring into a new file in its volume, then configure the container's DB_PATH to that file. Never overwrite a running database or its WAL/SHM sidecars.

Logs are JSON on stderr with source ID, outcome, item count, attempt and duration. `get_status` / `cli status` report source errors, poll queue totals and processing job counts grouped by stage and state. `get_item` reports processing attempts, retry deadlines and errors for each generation. Extraction and scoring run automatically; analysis is optional. HTTP `/health` requires the bearer token. SQLite uses WAL, 5-second busy timeout and short transactions. Job leases expire after 60 seconds; retry backoff starts at 30 seconds, max five attempts per poll cycle. Reclaimed jobs and repeat polling are idempotent.

If a feed fails, inspect `last_error`, check its URL and network access, and allow the persisted retry. A terminally failed polling cycle is retried as a new cycle when that source is next due. No public endpoint changes subscriptions. Disabling or removing a source cancels pending polls and fences any in-flight poll; network work already started may finish, but its results cannot be committed. Removal hides the subscription and retains its source record, item references and history. Re-adding the same URL restores it; importing an already disabled feed leaves it disabled.

Feed limits default to 1,000 entries and 5,000,000 bytes per response; permitted ranges are 1–10,000 entries and 1–20,000,000 bytes. `get_status` and CLI `status` include the latest entry count and truncation flag, retained across a 304 response. A truncated feed may omit older entries; increase the budget where appropriate. Changing either feed budget clears validators, cancels any active poll and schedules a fresh fetch. Changing an interval schedules the next poll from the last successful poll or immediately if overdue. Original and resolved URLs remain in references. When a known source-native entry changes, its title and latest observed non-empty text become current and searchable; prior observed titles, bodies and source URLs remain in `get_item.content_versions`, and a new fenced extraction generation invalidates downstream work for that item. Frozen editions are not modified. Cross-source content observations are retained individually; this is not an assertion that one publisher's correction applies to another publisher's copy. Back up before upgrading; restore a pre-upgrade backup to a new stopped database path to roll back.

Content versions marked `backfilled` represent the item text present at upgrade time, copied for each existing source reference; earlier source-specific bodies were not retained and cannot be reconstructed.

## Validate

```sh
bun run typecheck
bun test
bun run smoke
```

The smoke test uses local RSS/Atom HTTP fixtures, imports OPML, ingests duplicate stories, reopens SQLite, verifies conditional requests, and searches/retrieves provenance using a real official MCP SDK client over HTTP. Tests never send email or make AI calls. Unit/integration tests cover retry deadlines, fenced lease reclamation, URL-less items, digest fan-out, backups, HTTP access controls, fail-closed template configuration and coordinated HTTP/worker shutdown. Feed regressions cover namespace-prefixed Atom, mixed XHTML text/links, out-of-line content summary fallback, escaped HTML URL attributes, original citations, publication-date enrichment and encoded byte streams.

Feed decoding follows [RFC 7303 §3.2](https://www.rfc-editor.org/rfc/rfc7303#section-3.2): BOM first, then HTTP charset, then XML declaration/autodetection, defaulting to UTF-8. UTF-16LE/BE and legacy encodings supported by Bun's TextDecoder are covered; unsupported encodings (including UTF-32) and invalid bytes produce explicit feed-health errors instead of silent replacement characters.

See [architecture and roadmap](docs/architecture.md) for the initial schema, reference-project findings, compatibility evidence, defaults and limitations. Semantic deduplication and proactive discoveries are not available yet. A synthetic offline regression baseline is available; it is not a measured real-world relevance-quality baseline. See [offline evaluation](docs/evaluation.md) for replay, comparison and limitations.

### Interest and editorial profiles

Profiles are explicitly configured; no example interests are activated automatically.
Create a JSON array such as the following, then import it using `bun run cli import-profiles profiles.json`. Edit the file with the same ID and incremented version to update it; versions are immutable and consecutive. `bun run cli list-profiles` lists all versions and `bun run cli export-profiles > profiles.json` exports their full history. Imports are transactional and reject unknown fields, including credentials. Back up the database before upgrading or changing configuration.

```json
[
  {
    "kind": "interest",
    "id": "example-robotics",
    "version": 1,
    "description": "Example only",
    "entities": ["robots"],
    "keywords": ["robotics"],
    "priority": 3,
    "positive": ["research"],
    "negative": ["advertising"],
    "queries": ["robotics research"],
    "lifetime": "persistent",
    "feedbackRefs": []
  },
  {
    "kind": "editorial",
    "id": "paper",
    "version": 1,
    "description": "Evaluate papers",
    "contentTypes": ["paper"],
    "criteria": [{ "dimension": "evidence", "weight": 1 }],
    "presentation": ["methods"]
  }
]
```

Priority ranges from 1 to 5. A temporary interest requires `expiresAt`, an epoch millisecond timestamp; at and after expiry it is excluded from active interests while historical versions remain available. Persistent interests omit `expiresAt`. Editorial criteria are separate from interests. Query scheduling, feedback records and analysis references are implemented in later milestones; `feedbackRefs` contains explicit external identifiers and does not infer feedback from reading behavior. No discovery is scheduled by profile import alone.

Optional, deterministic starting editorial criteria for six content types are in `examples/editorial-profiles.json`; import them explicitly if useful. The scoring baseline applies recognized component weights when an analysis classification matches a profile; unknown dimensions are reported as uncertainty.
Article extraction runs asynchronously after ingestion for public HTTP(S) item URLs. Search and MCP retain feed text while full text is pending or unavailable. See [architecture notes](docs/architecture.md#http-article-extraction) for destination restrictions, limits and extraction behavior.

### Optional structured analysis

Analysis is disabled unless all six settings below are supplied. `ANALYSIS_ENDPOINT` is the complete HTTPS Chat Completions URL and must have no credentials, query or fragment. `ANALYSIS_KEY` is sent only in the authorization header; use a dedicated secret, not a profile. The selected provider must support non-streaming Chat Completions with `response_format: {"type":"json_object"}`, `max_completion_tokens`, and usage fields as described by the [OpenAI Chat API reference](https://developers.openai.com/api/reference/resources/chat). Compatibility varies: validate the selected provider and model before enabling it. [OpenAI structured output guidance](https://developers.openai.com/api/docs/guides/structured-outputs) describes limitations including refusal and incomplete responses; Newspulse validates output locally and rejects incomplete output. No provider requests run in default tests.

```sh
export ANALYSIS_ENDPOINT=https://api.openai.com/v1/chat/completions
export ANALYSIS_KEY='your-secret'
export ANALYSIS_MODEL='your-supported-model'
export ANALYSIS_TOTAL_TOKENS=180000
export ANALYSIS_TOTAL_MICROS=1000000
export ANALYSIS_CALL_MICROS=10000
```

Budget amounts are lifetime ledger ceilings, not daily limits. `ANALYSIS_CALL_MICROS` is an operator-supplied conservative upper bound in millionths of the billing currency for each request, including all provider fees; verify it against the chosen model's actual pricing and maximum request size. Each call permanently charges that full bound to the local cost ledger even when the provider reports no cost. The token reservation is 18,000 per request: 16,000 input bytes, 1,000 output tokens and 1,000 tokens of message overhead. This bound relies on the selected provider's tokenizer and request accounting fitting that envelope; a provider that can exceed it must not be enabled. The local ledger cannot prevent a provider from charging more than the operator's bound or reporting incorrect usage. Actual monetary cost is stored as unknown; consult provider billing. Exhaustion stops new requests. If reported token usage exceeds the reserved bound, the actual reported amount is recorded even if it exceeds the configured ceiling; this persists an envelope-breach flag and blocks later dispatch even when lifetime budget remains; it cannot reverse an already completed provider call. Inspect `analysis_envelope_breach` in status, stop the service, review the provider envelope and configuration, then run `bun run cli analysis-acknowledge-envelope` before restarting. No automatic budget reset exists.

Validated provider responses are persisted before the fenced job completes so a restart can replay them without another request. A received 429 or server error consumes its full reservation and may retry within the remaining budget. A fully received response that fails output validation retires its reservation while retaining its full charge; subsequent retries remain budgeted. A timeout or other ambiguous failure retains its full reservation and blocks further dispatch until an operator reconciles it. Stop the service and verify the provider's billing and request status first, then inspect `bun run cli analysis-reservations` and use `bun run cli analysis-reconcile KEY` to allow a retry. Reconciliation retains the full previous reservation as spent; a retry needs additional budget and may be chargeable. When analysis is enabled, the service holds an exclusive OS lock for the database until the process exits, including after shutdown starts; reconciliation refuses to run while the service holds it. This requires Linux with glibc and a local filesystem with working `flock` semantics; unsupported environments fail closed. Do not access the same database through hard links or delete its `.analysis.lock` sidecar while running. The OS releases the lock on process exit or crash. Never reconcile while a worker or provider request is still running. Job retry backoff and its five-attempt ceiling still apply. Once a failed job is reconciled or a budget is increased, run `bun run cli analysis-retry ITEM_ID` to explicitly requeue it. Back up the database before migration or reconciliation and restore only into a new stopped path.

Analyses preserve model, provider, prompt version, input hash, exact profile snapshots, claims, citations, uncertainty and reported token usage. Summaries are model-generated, source content is untrusted, and source claims are not verified facts. Missing extraction retains the feed text and source reference; items lacking usable text remain unavailable for analysis. To request reanalysis after an analysis completes, run `bun run cli analysis-reanalyse ITEM_ID`. Changed model or profile configuration creates a new version; identical input and configuration reuses an existing result. Publication and scoring remain separate.

### Story grouping (M2 issue #6)

A durable independent grouping stage groups coverage of **specific developments**, never broad topics. Canonical URL identity and historical aliases continue to control exact item deduplication. A story group preserves the individual articles and their original source URLs, processing generations, analyses and citations.

Evidence is deterministic: long, varied, identical source text identifies syndication; lexical event/action, product/version and temporal constraints identify same-event reporting. Membership records include the rule version, matched item, and evidence. Corrected observations close old memberships and retain them for audit. Later related events may have an explicit directional relationship but remain distinct groups. `get_item` reports current and historical grouping; `get_story_group` returns all current/historical members with original article details and related developments. `get_status` reports grouping counts.

Existing databases enqueue one backfill job when upgraded. Grouping jobs do not block ingested items from being searchable, and unchanged snapshots do not create new membership history or paid analysis work. Back up before migration, and if rollback is needed, restore that backup to a **new stopped database path** rather than downgrading an upgraded database in place. Future immutable newsletter editions will not be rewritten by regrouping.

**Limitations:** The initial rule is deliberately conservative and uncalibrated; some real shared events will remain distinct, especially if titles lack explicit event verbs or identifiers. Long identical boilerplate may be ambiguous. The initial snapshot-wide reconciler needs further scalability evaluation for large libraries and may require more focused invalidation later. No model, vector database or external queue is required.

### Initial scoring (M2 issue #7)

After extraction, a durable score job evaluates the item even when analysis is disabled or unavailable. `explain_ranking` returns saved runs, source references, component values, weights, eligibility, reasons, uncertainty and the input/profile/analysis provenance. Historical runs are retained; a historical score is not necessarily current. The explanation tool returns up to 20 runs by default (maximum 100); pass `next_before` as `before` to retrieve older runs. Search remains available during processing and is not ordered by these scores.

The deterministic baseline uses explicit active interests, lexical matches and preferences, publication age, text length and simple indicators for the other components. Matching editorial criteria adjust known component weights when an analysis classification is available. Components and totals range from 0 to 100; ties in the domain comparator use item ID. No interest is enabled by default, and missing clicks or unread state are not inputs. Citations and keyword indicators do not establish factual accuracy or source credibility. The optional specialist interface is disabled in the running service; its absence is recorded as uncertainty and requires no binary or provider.

Scoring is a development baseline, not a validated ranking. A conservative update rule compares successive non-backfilled observations of the same source-native item: a changed title and at least 20 new distinct body terms representing at least 20% of the current vocabulary raise novelty for seven days after observation. Incidental changes and other source references do not restart or erase that window. A lexical reversion to a retained comparison observation, or removal of more than half the new terms, cancels that source's evidence. The saved explanation includes the source, version IDs, new terms and rule version. This heuristic can miss meaningful updates and can mistake extensive unrelated changes for one; it does not verify claims. It does not infer that a user saw earlier coverage. Confirmed provider acceptance and reconciled sent state supply prior-presentation evidence from frozen edition snapshots; acceptance is not evidence that anyone read the email. Draft, failed and unresolved deliveries do not establish presentation. Missing or ambiguous evidence remains uncertain. Same-item updates are compared conservatively with the actual historical snapshot, and grouping alone cannot prove a meaningful follow-up. If a legacy or malformed frozen snapshot lacks the historical title or text, the explanation reports `historical_snapshot_unavailable` and no meaningful update is asserted. History lookup is bounded to 100 matching edition items and 250 KB per frozen item snapshot; exceeding either bound reports unknown history and prevents repeat selection. Related developments in separate groups are not yet compared with accepted editions; required follow-up [#49](https://github.com/mhingston/newspulse/issues/49) owns that comparison. Synthetic offline evaluation does not establish real-world quality or cost per useful discovery.

Profile imports, completed extraction or analysis, grouping changes and delivery acceptance or reconciliation requeue affected scores; temporary-interest expiry, publication-age boundaries and expiry of an observed-update boost also trigger re-scoring. The score history remains available for comparison. Back up before upgrading: the migration adds score storage and queues existing extracted items. If rollback is needed, restore a pre-upgrade backup into a new stopped database path and verify it before switching. Inspect processing job counts and per-item stage status if scoring fails; ingestion and search do not wait for scoring.

### Offline scoring and grouping replay

Run `bun run cli evaluate tests/fixtures/evaluation-corpus-v1.json 5` to replay the synthetic corpus without a database, provider or email. The [evaluation guide](docs/evaluation.md) describes recorded results, configurable gates, comparison, missing labels and timing. Synthetic interests are examples, not the user’s profile.

### Developing and frozen digests

`get_digest` reads a developing draft or an immutable frozen edition by date. Drafts consider recent ingestion, source observations and first scoring of a content generation in the 24 hours ending at preview time, using completed current scores. The requested date must match the preview time in Europe/London. Pending grouping or scores return `processing`; terminal failures are explained as exclusions. The newest 500 candidates are considered, with truncation explicitly reported in the snapshot. A development with more than 20 source references or more than 4 KB of citation data, or a score snapshot over 200 KB, is excluded with a reason. The initial defaults are at most ten items, at most four per interest, and a minimum score of 50. No active interests can produce a `no_digest` result. Search and ingestion continue independently.

To prepare an edition locally, run `bun run cli digest-preview 2026-11-09` and inspect its decisions and rendered content. To freeze exactly that preview within five minutes, run `bun run cli digest-freeze 2026-11-09 AS_OF HASH`, using `confirmation.asOf` and `confirmation.hash` from the preview. Changed inputs, options or an expired confirmation require a new preview. A frozen date cannot be replaced; back up before upgrading and restore a pre-upgrade backup into a new stopped database path for rollback. Freezing prepares a snapshot and does not send email or establish delivery.

Summaries are labeled as model-generated and original source identities remain available even without a public URL. Each frozen decision includes selected items, score snapshots and feedback targets. Accepted delivery and reconciled sent state provide historical presentation evidence for later scoring, while a frozen draft alone does not. Actionable scoped feedback links remain assigned to #18, and identifying outside-subscription discoveries belongs to later discovery work. Missing clicks are not feedback.

## Incoming email

Incoming Resend email is optional. Set both `RESEND_API_KEY` and `RESEND_WEBHOOK_SECRET` (or neither), configure a receiving domain or inbox in Resend, and register an `email.received` webhook at `https://YOUR-HOST/webhooks/resend`. Add that hostname to `ALLOWED_HOSTS`. Expose only this POST route through a TLS reverse proxy; keep `/mcp`, `/health`, and all other routes private. The supplied Compose port is loopback-only. The raw body is limited to 64 KiB, 10 seconds, and 16 concurrent requests per process and verified with the pinned Resend SDK and its Svix headers before event and message identities are committed. Duplicate events and messages are idempotent. The response does not wait for Resend retrieval.

A background worker retrieves message text and HTML, using bounded requests and fenced leases. It also scans the received-email list in pages, persists its cursor after each page, checks the newest page between historical pages, and restarts at the newest page after each complete scan to overlap previous scans. Transient and invalid responses retry after a minute with an error category; provider-reported missing messages are marked unavailable. Requests run sequentially from one service instance, at most one retrieval and one listing request per two-second wake-up; use a single running instance for this provider budget. List cycles wait 15 minutes after completion. A large inbox can take longer to scan; monitor the cursor and provider retention and quota. Listing is subject to Resend's account permissions and retention, so recovery cannot cover messages no longer available there.

The private SQLite tables `inbound_messages`, `inbound_events`, and `inbound_reconciliation` hold untrusted content and operational state; protect backups accordingly. Operators can inspect counts and `last_error` codes locally, for example `SELECT status, count(*) FROM inbound_messages GROUP BY status` and `SELECT available_at, attempts, last_error FROM inbound_reconciliation`. Errors are categories, not provider response bodies. Retrieved newsletters are indexed as independent, URL-optional original items. Eligible article links are ingested separately, deduplicated against other sources, and retain newsletter parent attribution. The original and its children can be searched before analysis completes; neither retrieval nor indexing sends a digest. Newsletter bodies and link text are untrusted data. Attachments are neither downloaded nor executed, and missing bodies cannot supply content or links. Received time remains separate from publication time; it is not invented as a publication date. `get_item` references include the newsletter sender, received time, provider/message identity, parent item and indexing diagnostics. Diagnostics indicate missing bodies, truncated links and unsupported attachments. Parsing bounds each body to 2,000,000 characters, scans at most 500 links and creates at most 50 unique child candidates. Link filtering is conservative and heuristic: it omits known opaque trackers and ad networks but cannot identify every advertisement or tracker. Known wrapper URLs are unwrapped locally without requesting the tracker; the original citation is retained and only the cleaned destination is submitted for extraction. Article destinations still use the extraction safety checks.

Before enabling, back up the database as above. For a live contract check, use a dedicated Resend test inbox/domain and key, configure a TLS webhook, send a non-sensitive test message, confirm the event and completed body in the private database and search for the original and eligible linked articles through MCP, then temporarily disable the webhook and confirm a second test message is found by list reconciliation. This is an operator-run check requiring configured credentials and DNS; automated tests use fixtures only. To roll back, stop the service and restore the pre-upgrade backup into a new path.

### Daily email delivery

Outbound delivery is opt-in. Set `DELIVERY_ENABLED=true`, `RESEND_API_KEY`, `DELIVERY_FROM` and `DELIVERY_TO`; the sender must be authorized on a verified Resend domain. `DELIVERY_TIMEZONE` defaults to `Europe/London` and `DELIVERY_TIME` to `06:00`. Use plain email addresses. Inbound webhooks additionally require `RESEND_WEBHOOK_SECRET`. An empty edition is recorded without sending. A frozen edition and its outbox entry commit before the network call, and retries reuse the same frozen message and idempotency key. Resend acceptance means acceptance by the provider, not inbox delivery.

Resend [retains idempotency keys for 24 hours](https://resend.com/docs/dashboard/emails/idempotency-keys). Newspulse stops automatic retries when a send outcome is ambiguous and requires operator reconciliation; repeated claims are also bounded. Inspect `bun run cli delivery-list`. Stop the service and check provider records before reconciling an unknown outcome. Never assert `not_sent` without evidence; it permits another attempt. Check `bun run cli` usage for the reconciliation confirmation protocol. Keep system clocks synchronized and do not move them backwards. A restored backup can predate a send. The CLI restore creates a `.delivery-restore-pending` sidecar that blocks outbound startup; keep the service stopped, audit provider activity since the backup, reconcile matching outbox rows, and use `delivery-restore-preview` followed by `delivery-restore-confirm AS_OF HASH` only after every possible send is safely accounted for. A matching restored pending row can be reconciled as accepted with its provider ID. If an accepted edition has no outbox row and cannot be safely suppressed, keep delivery disabled and do not confirm; an operator suppression workflow is tracked in [#21](https://github.com/mhingston/newspulse/issues/21). Copies made outside the CLI or moved without the sidecar bypass this guard and require the same manual audit before enabling delivery. The delivery lock requires Linux/glibc, a local filesystem with working `flock`, and an ordinary file database. Do not delete its lock file or access the database through hard links.

The scheduler catches up frozen missed editions, but cannot recreate a historical draft from mutable current scores and grouping; it records unfrozen missed dates as skipped. Unfrozen historical catch-up is tracked in [#48](https://github.com/mhingston/newspulse/issues/48). Scoped feedback links are not yet available and remain owned by [#18](https://github.com/mhingston/newspulse/issues/18). Do not interpret a missing click as feedback. Back up before migration or enabling sending, and restore only to a new stopped path. Tests use fake providers and never send real email.
