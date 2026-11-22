# Newspulse

**A self-hosted personal curation and discovery engine.** Newspulse ingests the feeds, newsletters, repositories and discussions you follow, optionally searches outside them on a budget you set, and keeps a durable, source-linked record that you can question through MCP or read in a daily email.

It is not a traditional feed reader. There is no unread counter and no dashboard: instead of handing back a chronological list to triage, Newspulse ranks, deduplicates and summarizes across your subscriptions and optional discovery sources to surface what actually matters.

## The problem

Following a few feeds is easy. Keeping up with a field is not. The writing that changes your mind is scattered across blogs, YouTube channels, newsletters you skim, repositories you track, threads you never opened, and publications whose names you do not know yet. A reader solves the plumbing and hands back a longer list.

Newspulse turns that stream into a curated brief and searchable memory:

- **Ingest** — RSS/Atom and OPML, email newsletters, GitHub releases and activity, Hacker News discussions, and URLs you submit yourself.
- **Process** — article extraction, optional structured summaries, story grouping, and explainable scoring. Every item is searchable the moment it is ingested; extraction, analysis and scoring catch up in the background.
- **Discover** — bounded, budgeted searches (GDELT, Hacker News, GitHub) built from the interests you declare, aimed at sources you do not subscribe to.
- **Brief** — a daily email edition, frozen and persisted before it is sent, carrying original citations and one-click feedback links.
- **Answer** — an authenticated MCP endpoint, so the client you already use can search the collection, explain a ranking, compare developments and report what changed.

Three rules shape everything else: publication selects from already-processed items rather than driving ingestion; missing clicks and unread material are never treated as negative feedback; and every summary, score and explanation is labelled as an estimate next to the original source it came from.

## How it fits together

```text
subscriptions ─┐
newsletters   ─┤
discovery     ─┼─→ ingest → extract → group → score ─┬─→ MCP: search, ask, explain
manual URLs   ─┤   (searchable from here on)        └─→ daily digest → email
GitHub / HN   ─┘
```

## Quickstart

Needs [Bun](https://bun.sh) 1.4.4 or later. Dependencies are pinned and locked, so `bun install --frozen-lockfile` installs exactly the tested versions. About two minutes from clone to a searchable collection:

```sh
bun install --frozen-lockfile
cp .env.example .env
# Put a random token in MCP_TOKEN — at least 24 characters:
bun -e 'console.log(crypto.randomUUID()+crypto.randomUUID())'
bun run cli init
bun run cli add-source https://bun.com/rss.xml 'Bun'
bun run cli poll --force
bun run cli search 'Bun'
```

`search` already returns titles, URLs and text while analysis is still pending. CLI commands are local and need no token. Already have subscriptions elsewhere? `bun run cli import-opml subscriptions.opml` takes any standard OPML export; re-importing never overwrites an existing title or interval.

Then run the service:

```sh
bun start
```

It polls on startup and keeps polling throughout the day — every 30 minutes per source by default, 60 seconds minimum. The copied `.env` ships an empty `MCP_TOKEN` on purpose, so the server refuses to start until you set one.

### Connect a client

Point any Streamable HTTP MCP client at `http://127.0.0.1:3000/mcp` with an `Authorization: Bearer <MCP_TOKEN>` header. The official TypeScript SDK client is the tested one:

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

Other clients may work, but verify each one in your own environment before relying on it; a client that advertises MCP support is not interoperability evidence. For local, process-spawned clients there is an opt-in stdio mode: `bun run cli serve-mcp-stdio`.

Then ask things like:

| Question                                    | Tool behind it                                  |
| ------------------------------------------- | ----------------------------------------------- |
| What did I miss today?                      | `get_digest`, `search_items`, `get_discoveries` |
| Why did this rank so highly?                | `explain_ranking`                               |
| What changed in this story since Tuesday?   | `get_development_changes`                       |
| Who else covered this?                      | `get_story_group`, `get_item`                   |
| What am I subscribed to, and is it healthy? | `get_sources`, `get_status`                     |

The service does not hold the conversation — your MCP client does. Mutations (`add_source`, `remove_source`, `update_interest`, `submit_feedback`, `ingest_url`, `trigger_discovery`) use a two-step preview/confirmation flow, so nothing consequential happens on a single call.

## Make it yours

Interests are what turn ingestion into ranking and digests. Nothing is configured for you and no example interest is activated automatically. Save a JSON array and import it:

```json
[
  {
    "kind": "interest",
    "id": "local-first",
    "version": 1,
    "description": "Local-first software and embedded databases",
    "entities": ["SQLite"],
    "keywords": ["local-first", "sync engine"],
    "priority": 3,
    "positive": ["benchmarks"],
    "negative": ["advertising"],
    "queries": ["local-first sync engine"],
    "lifetime": "persistent",
    "feedbackRefs": []
  }
]
```

```sh
bun run cli import-profiles profiles.json
bun run cli list-profiles
```

Versions are immutable: edit the file with the same `id` and an incremented `version` to change an interest. Priority runs 1–5; a temporary interest adds an `expiresAt` epoch-millisecond timestamp and drops out of the active set at expiry while its history stays. Editorial profiles — how a content type is evaluated and presented, kept separate from what you care about — use `kind: "editorial"` with `contentTypes`, `criteria` and `presentation`; deterministic starters for six content types are in `examples/editorial-profiles.json`.

`bun run cli export-profiles > profiles.json` exports the full version history. Imports are transactional and reject unknown fields, including credentials — and importing a profile never schedules discovery or spends anything on its own.

Everything below is optional and off by default:

| Want                 | Turn on                                                                                | Notes                                                                                    |
| -------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Structured summaries | `ANALYSIS_ENDPOINT`, `ANALYSIS_KEY`, `ANALYSIS_MODEL`, budgets                         | OpenAI-compatible Chat Completions; lifetime token and cost ceilings                     |
| Daily email edition  | `DELIVERY_ENABLED`, `RESEND_API_KEY`, `DELIVERY_FROM`, `DELIVERY_TO`, feedback secrets | Frozen and persisted before sending; an ambiguous send needs reconciliation, not a retry |
| Incoming newsletters | `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, plus a Resend receiving domain and webhook  | Only the signature-verified POST route is public                                         |
| Scheduled discovery  | `DISCOVERY_SCHEDULE_ENABLED` plus micro-budgets                                        | GDELT; GitHub and HN have their own `*_DISCOVERY_ENABLED` switches                       |
| Event alerts         | `ALERTS_ENABLED`                                                                       | Implemented, but not recommended: the recorded evaluation is a non-adoption by default   |

Each of those has an operational section in [docs/operations.md](docs/operations.md) with the exact variables, limits and recovery steps.

## What is real today

Newspulse is at 0.1.0. The pipeline, digest, delivery, discovery and MCP surface are implemented and covered by offline tests; the ranking and grouping rules are recorded baselines, not validated relevance quality.

| Area                                                                          | State                                                    |
| ----------------------------------------------------------------------------- | -------------------------------------------------------- |
| RSS/Atom, OPML import/export, conditional requests, feed budgets              | Shipped                                                  |
| Extraction, story grouping, development change evidence                       | Shipped                                                  |
| Scoring with saved explanations                                               | Shipped; a development baseline, not a validated ranking |
| Email newsletters, daily delivery, scoped feedback links                      | Shipped; opt-in, needs Resend                            |
| GitHub releases/activity, Hacker News, manual and Reddit URLs                 | Shipped                                                  |
| GDELT / GitHub / Hacker News discovery                                        | Explicit queries shipped; scheduling opt-in and budgeted |
| Source suggestions                                                            | Adopted opt-in slice; never auto-follows                 |
| MCP over HTTP / stdio                                                         | Shipped / opt-in                                         |
| Web UI, browser extraction, embeddings, richer adaptation, newsletter replies | Evaluated and not adopted, with recorded evidence        |
| Semantic deduplication, an in-service assistant, multi-user access            | Not built                                                |

The [decisions log](docs/decisions.md) records why each non-adopted feature is absent and what evidence would reopen it.

## Everyday commands

| Command                                                                            | Does                                                    |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `bun run cli status`                                                               | Health, queues, sources, delivery and processing counts |
| `bun run cli search QUERY`                                                         | Full-text search over the local collection              |
| `bun run cli add-source URL [TITLE] [POLL_SECONDS]`                                | Subscribe to a feed, GitHub stream or HN discussion     |
| `bun run cli list-sources`                                                         | Subscription list with health and settings              |
| `bun run cli update-source` / `enable-source` / `disable-source` / `remove-source` | Rename, retune, disable or remove subscriptions         |
| `bun run cli import-opml FILE` / `export-opml`                                     | Move subscriptions in and out                           |
| `bun run cli ingest-url URL`                                                       | Submit a URL outside the feed pipeline                  |
| `bun run cli discover QUERY`                                                       | One bounded discovery query (budgets required)          |
| `bun run cli digest-preview DATE` / `digest-freeze`                                | Prepare and freeze an edition locally                   |
| `bun run cli suggest-sources`                                                      | Propose sources from recorded discovery evidence        |
| `bun run cli backup FILE` / `verify-backup` / `restore`                            | Snapshot, check and restore                             |
| `bun run cli`                                                                      | Full command list                                       |

## Configuration

`.env` is loaded by Bun and `.env.example` documents every switch with its default. `MCP_TOKEN` is the only mandatory value and must be at least 24 characters; the template ships it empty so a copied file fails closed instead of starting with a guessable token. `DB_PATH` defaults to `./data/newspulse.sqlite`. Keep the service on loopback and publish nothing but the Resend webhook and the feedback links through a TLS proxy — `/mcp` and `/health` are bearer-authenticated.

The full variable reference, including `ALLOWED_HOSTS`, the retention windows and every provider budget, is in [docs/operations.md](docs/operations.md#core-settings).

## Docker Compose

```sh
docker compose up --build -d
docker compose exec newspulse bun src/cli.ts add-source https://bun.com/rss.xml Bun
docker compose logs -f newspulse
```

Compose mounts a named volume, runs as the image's `bun` user and publishes only on host loopback. Set `MCP_TOKEN` in `.env` first; restoring a snapshot inside the volume is covered in [operations](docs/operations.md#docker-compose).

## Development

```sh
bun run typecheck
bun run format:check
bun test
bun run smoke
```

Default tests use local fixtures and fakes only — no live models, no provider calls, no real email. The smoke test drives the real HTTP app with an official MCP SDK client over local RSS fixtures, and `bun test tests/full-system.test.ts` runs the end-to-end acceptance pass.

Before changing behaviour, read [AGENTS.md](AGENTS.md) for the invariants, [decisions](docs/decisions.md) for what is settled and why, and [the roadmap](docs/roadmap.md) for what each issue owns. [Completion tracker #32](https://github.com/mhingston/newspulse/issues/32) links the required implementation and acceptance issues and the conditional refinement issues; GitHub issues own execution state.

## Documentation

| Document                                           | Covers                                                                                   |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| [operations](docs/operations.md)                   | Interfaces, settings, every source, processing, delivery, retention, backup and recovery |
| [decisions](docs/decisions.md)                     | Durable product and architecture decisions, with evidence and revisit triggers           |
| [roadmap](docs/roadmap.md)                         | Implementation order, issue ownership, requirement coverage                              |
| [architecture](docs/architecture.md)               | Module boundaries, schema, processing and recovery notes                                 |
| [evaluation](docs/evaluation.md)                   | Offline replays, recorded baselines, gates and limitations                               |
| [operator acceptance](docs/operator-acceptance.md) | The staged live-provider acceptance report                                               |
| [AGENTS.md](AGENTS.md)                             | Contributor instructions and verification commands                                       |

## License

[MIT](LICENSE).
