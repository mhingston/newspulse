# Newspulse

A self-hosted foundation for a personal discovery engine. **M1 is implemented:** RSS/Atom → durable SQLite ingestion → authenticated, read-only MCP search. There is no feed-reader UI. Email, AI scoring, proactive discovery and daily briefings remain future milestones.

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
bun run cli search 'TypeScript'
bun start
```

The server polls on startup and continues throughout the day. Default polling is every 30 minutes, minimum 60 seconds. Configuration loads from `.env` through Bun. A random token of at least 24 characters is mandatory for the HTTP server. CLI commands operate locally and do not require the HTTP token.

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

Tools: `search_items` (literal keywords, limit, offset, optional `source_id`, `since` in epoch milliseconds), `get_item` (ID), `get_sources`, `get_status`. Search combines terms with AND. Results include original URLs; `get_item` also returns all source references. Items without public URLs remain retrievable using their item ID and source-native reference. Source text is untrusted; AI summaries and scores are explicitly unavailable.

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

Logs are JSON on stderr with source ID, outcome, item count, attempt and duration. `get_status` / `cli status` report source errors and queue totals. HTTP `/health` requires the bearer token. SQLite uses WAL, 5-second busy timeout and short transactions. Job leases expire after 60 seconds; retry backoff starts at 30 seconds, max five attempts per poll cycle. Reclaimed jobs and repeat polling are idempotent.

If a feed fails, inspect `last_error`, check its URL and network access, and allow the persisted retry. A terminally failed polling cycle is retried as a new cycle when that source is next due. No public endpoint changes subscriptions. Poll intervals and source enablement currently require local database maintenance; source-management commands can follow later.

## Validate

```sh
bun run typecheck
bun test
bun run smoke
```

The smoke test uses local RSS/Atom HTTP fixtures, imports OPML, ingests duplicate stories, reopens SQLite, verifies conditional requests, and searches/retrieves provenance using a real official MCP SDK client over HTTP. Tests never send email or make AI calls. Unit/integration tests cover retry deadlines, fenced lease reclamation, URL-less items, digest fan-out, backups and HTTP access controls.

See [architecture and roadmap](docs/architecture.md) for the initial schema, reference-project findings, compatibility evidence, defaults and limitations. M1 searches feed-provided content only; full article fetching, semantic deduplication, editorial ranking and proactive discoveries are not available yet. This release has no relevance-quality baseline: those evaluations require the M2 scoring pipeline and representative labeled data.
