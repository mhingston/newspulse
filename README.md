# Newspulse

A self-hosted foundation for a personal discovery engine. **M1 is implemented:** RSS/Atom → durable SQLite ingestion → authenticated, read-only MCP search. There is no feed-reader UI. Email, AI scoring, proactive discovery and daily briefings remain future milestones.

## Project decisions and remaining work

Start with [AGENTS.md](AGENTS.md) for contributor guidance, [decisions](docs/decisions.md) for architectural/product constraints, and the [roadmap and coverage map](docs/roadmap.md) for implementation order and dependencies. The [original handoff](docs/handoff.md) is preserved in full.

[Completion tracker #32](https://github.com/mhingston/newspulse/issues/32) links 22 required implementation/acceptance issues and 9 conditional refinement issues. Required issues need merged, verified behavior; optional ideas retain the handoff's evaluation gates. The initial “M1 only” instruction scoped PR #1; future sessions should implement a selected issue and its authorized scope rather than restart the entire handoff.

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

Tools: `search_items` (literal keywords, limit, offset, optional `source_id`, `since` in epoch milliseconds), `get_item` (ID), `get_sources`, `get_status`. Search combines terms with AND. Results include canonical item URLs; `get_item` also returns all original resolved source references, including fragments and tracking context. Items without public URLs remain retrievable using their item ID and source-native reference. Source text is untrusted; AI summaries and scores are explicitly unavailable.

Transport is stateless Streamable HTTP with JSON responses. Stdio is optional in the handoff and not implemented. There are no mutation tools. A client with a browser Origin must appear in `ALLOWED_ORIGINS`. Hosts must appear in `ALLOWED_HOSTS`; use hostnames without ports. No CORS policy is exposed for browser apps yet.

## Docker Compose

```sh
# Set MCP_TOKEN in .env first.
docker compose up --build -d
docker compose exec newspulse bun src/cli.ts add-source https://bun.com/rss.xml Bun
docker compose exec newspulse bun src/cli.ts status
docker compose logs -f newspulse
```

Compose mounts a named persistent volume and publishes only on host loopback. The process runs as the image's `bun` user. Keep MCP and health endpoints on a private network or behind an authenticated private tunnel. This release has no public webhook route. Do not publish port 3000 on a public interface. For a private domain, add its hostname to `ALLOWED_HOSTS`, use TLS and retain bearer authentication. Anyone controlling CLI subscriptions can direct outbound HTTP requests; only import trusted subscription lists. Feed bodies and link text cannot alter source configuration.

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

Logs are JSON on stderr with source ID, outcome, item count, attempt and duration. `get_status` / `cli status` report source errors, poll queue totals and processing job counts grouped by stage and state. `get_item` reports processing attempts, retry deadlines and errors for each generation. Extraction, analysis and scoring handlers are not yet configured; queued work remains pending until those later capabilities are implemented. HTTP `/health` requires the bearer token. SQLite uses WAL, 5-second busy timeout and short transactions. Job leases expire after 60 seconds; retry backoff starts at 30 seconds, max five attempts per poll cycle. Reclaimed jobs and repeat polling are idempotent.

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

See [architecture and roadmap](docs/architecture.md) for the initial schema, reference-project findings, compatibility evidence, defaults and limitations. Semantic deduplication, editorial ranking and proactive discoveries are not available yet. This release has no relevance-quality baseline: those evaluations require the M2 scoring pipeline and representative labeled data.

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

Optional, deterministic starting editorial criteria for six content types are in `examples/editorial-profiles.json`; import them explicitly if useful. They are configuration for later scoring, not claims that scoring is implemented.
Article extraction runs asynchronously after ingestion for public HTTP(S) item URLs. Search and MCP retain feed text while full text is pending or unavailable. See [architecture notes](docs/architecture.md#http-article-extraction) for destination restrictions, limits and extraction behavior.
