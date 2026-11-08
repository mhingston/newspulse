# Project Handoff — Personal Discovery & Intelligence Engine

## 1. Mission

Build a lightweight, self-hosted personal intelligence service that proactively discovers, ingests, evaluates and curates information relevant to the user's interests.

The system should:

- Continuously discover and process information throughout the day.
- Aggregate RSS, newsletters, GitHub, web searches and other sources.
- Find relevant material outside explicitly followed sources.
- Learn from explicit interests, preferences and feedback.
- Expose its knowledge and capabilities through MCP for interactive conversations.
- Produce a curated daily email briefing.
- Preserve historical context so it can track developments over time.

**The goal is not another RSS reader or newsletter aggregator. It's a system that finds worthwhile information the user wouldn't otherwise have discovered.**

## 2. Reference implementations

Review these before implementation:

- [Newsweave](https://github.com/mhingston/newsweave) — existing personal project. Reference its ingestion, digest fan-out, extraction, semantic deduplication, decision-model scoring, retry handling and Resend delivery.
- [Horizon](https://github.com/Thysrael/Horizon) — reference its source adapters, editorial profiles, configurable scoring, enrichment, source discovery and MCP integration.

Repo: mhingston/newspulse

Reuse proven design ideas rather than copying either implementation wholesale.

## 3. Technology decisions

| Component | Decision |
|---|---|
| Runtime | Bun 1.4+ |
| Language | TypeScript, strict mode |
| Persistence | SQLite via `bun:sqlite` |
| ORM / migrations | Drizzle ORM / Drizzle Kit |
| Search | SQLite FTS5 |
| HTTP framework | Hono |
| MCP | Official TypeScript MCP SDK |
| MCP transport | Streamable HTTP, optionally stdio |
| Scheduling | `Bun.cron` with persisted job state |
| Tests | `bun test` |
| Email ingestion | Resend Receiving API and webhooks |
| Email delivery | Resend |
| AI providers | OpenAI-compatible API |
| Specialist judgments | Optional `@mhingston5/jev-cli` |
| Deployment | Docker Compose, persistent volume |
| Authentication | Private MCP access initially |

Use built-in Bun capabilities where practical.

Keep domain logic independent of Bun-specific APIs and third-party providers. Encapsulate external integrations behind small interfaces.

Use a **modular monolith**. No microservices, distributed queues, vector databases or agent orchestration frameworks initially.

## 4. Architectural overview

```text
                      Interest Profiles
                             |
                      Discovery Planner
                             |
       +---------------------+------------------+
       |                     |                  |
   Subscribed             Search-based        Manual
    sources                discovery           input
       |                     |                  |
  RSS / Atom             Web Search         Submitted URLs
  Newsletters            GitHub / HN        Bookmarks
  GitHub                 Reddit discovery
       |                     |                  |
       +---------------------+------------------+
                             |
                      Source Adapters
                             |
                       Normalisation
                             |
                      Extraction
                             |
                     Deduplication
                             |
                  Analysis & Summarisation
                             |
                   Relevance & Novelty
                             |
                       SQLite Store
                             |
                 +-----------+-----------+
                 |                       |
              MCP API              Digest Curation
                 |                       |
          Conversational              Resend
             Clients               Daily Email
                 |
              Feedback
                 |
          Interest Profiles
```

### Processing lifecycle

`Discovered → Ingested → Extracted → Analysed → Scored → Available`

Publication is a separate process that selects from already-processed items.

Items should become queryable as soon as they're ingested, even if AI analysis is still pending.

Do not wait until newsletter publication to perform processing.

## 5. Ingestion

Implement a shared `SourceAdapter` abstraction.

Each adapter produces normalised content with stable IDs, source metadata, publication timestamps and provenance.

An item must not require a public URL. Email messages may use their message ID as the source identity.

### Native RSS / Atom

- Subscribe directly to RSS and Atom feeds.
- Support OPML import/export, including Miniflux exports.
- Conditional HTTP requests with ETag and Last-Modified.
- Configurable polling frequency.
- Retry, timeout and rate-limit handling.
- Feed health and error reporting.
- Deduplication across feeds.
- Detect and expand link-heavy digest entries.

Do not recreate a traditional RSS reader or unread-count interface.

### Email newsletters

Use Resend for incoming and outgoing email.

Inbound process:

1. Receive an `email.received` webhook.
2. Verify its signature.
3. Persist the event ID and enqueue ingestion.
4. Retrieve the message body using Resend's Receiving API.
5. Parse HTML and plain text.
6. Remove boilerplate and tracking links.
7. Preserve the newsletter as an original content item.
8. Extract linked articles as separate candidate items.
9. Preserve parent-child relationships and attribution.
10. Deduplicate linked articles against other sources.

Add periodic reconciliation using Resend's received-email listing API to recover missed webhook events.

Keep email ingestion provider-agnostic so IMAP can be introduced later.

Expose only the webhook endpoint publicly. Keep MCP and administrative endpoints private.

### GitHub and Hacker News

Provide adapters for:

- GitHub releases and repository activity.
- Relevant trending or newly discovered projects.
- Hacker News submissions and discussions.

Prefer APIs or structured data sources over browser extraction.

### Reddit

Reddit is a high-value discovery source, but access restrictions make direct automated ingestion uncertain.

Initial strategy:

- Search-engine discovery of Reddit posts.
- Ingest Reddit's notification/digest emails.
- Support manually submitted Reddit URLs.
- Preserve subreddit and discussion provenance where available.

Design an optional browser adapter based on agent-browser, with CloakBrowser where appropriate and permitted.

Do not depend on browser automation for core functionality or use it to circumvent platform access restrictions.

### Browser extraction

Implement a generic optional browser-extraction interface.

Prefer ordinary HTTP fetching and content extraction first. Use a browser only when needed and permitted.

Apply concurrency limits, timeouts and resource budgets.

Browser failures must not block other sources.

## 6. Persistence

Use SQLite with WAL mode, busy timeouts and short transactions.

Proposed data model:

- `sources` — subscriptions, configuration and health.
- `source_state` — polling cursors, ETags and timestamps.
- `items` — canonical content identities and metadata.
- `item_sources` — original references and provenance.
- `content` — extracted text and retention metadata.
- `analyses` — summaries, classifications and model versions.
- `interest_profiles` — topics, priorities and preferences.
- `item_scores` — relevance, novelty and judgment results.
- `story_groups` — related events or developments.
- `feedback` — explicit user judgments.
- `jobs` — durable processing state, retries and leases.
- `digests` / `digest_items` — publication history.
- `discovery_runs` — search queries, results and costs.

Use FTS5 for keyword search across titles, summaries and extracted content.

Avoid embeddings initially. Introduce them only if evaluation demonstrates a meaningful retrieval gap.

Separate retention policies for raw content and historical metadata. Preserve enough history to recognise previously encountered items and track ongoing developments.

Implement database backup and restore from the beginning.

## 7. Interest profiles and personalisation

Distinguish two concepts.

**Editorial profiles** describe how different content should be evaluated and presented.

Examples:

- Technical engineering article.
- Research paper.
- Software release.
- News event.
- Philosophical essay.
- Community discussion.

**Interest profiles** describe what matters to the user.

Each interest may contain:

- A description and relevant keywords/entities.
- Priority.
- Positive and negative preferences.
- Search queries.
- Temporary or persistent status.
- Optional expiry.
- Explicit feedback history.

Use structured, versioned scoring criteria.

Ranking should consider:

- Personal relevance.
- Novelty.
- Substantive information.
- Evidence and credibility.
- Practical significance.
- Potential impact.
- Redundancy with previously seen material.

Use deterministic ranking and filtering wherever practical, with optional specialist-model judgments.

Preserve scoring explanations and model provenance.

Do not treat unread material or missing clicks as negative feedback.

Reserve some discovery capacity for adjacent interests and unexpected connections.

## 8. Proactive discovery

Discovery must be a first-class subsystem, not merely a collection of fixed RSS feeds.

Initially:

1. Generate bounded search queries from explicit interests.
2. Execute them on a schedule.
3. Ingest candidate results.
4. Filter duplicates and previously seen material.
5. Evaluate relevance and novelty.
6. Record which queries produced useful discoveries.
7. Refine future queries using explicit feedback.

Start with simple scheduled search strategies.

Potential providers include Brave Search, Google News and GDELT, subject to their current API terms, limits and costs.

Use a provider abstraction and configurable search budget.

Do not introduce an autonomous agent loop unless simpler discovery strategies are demonstrably insufficient.

## 9. MCP and conversational access

MCP is a first-class interface.

The service exposes knowledge and operations. The connecting agent or chat client performs conversational reasoning.

This keeps the architecture independent of Claude Code, Codex, Pi and other compatible clients.

### Read-only tools

- `search_items` — full-text search with filters.
- `get_item` — extracted content, summaries, references and scores.
- `get_digest` — current draft or historical editions.
- `get_discoveries` — noteworthy discoveries outside subscriptions.
- `explain_ranking` — scoring and inclusion decisions.
- `get_interests` — configured interest profiles.
- `get_sources` — subscriptions and source configuration.
- `get_status` — ingestion, processing and delivery health.

### Mutation tools

Introduce after read-only functionality:

- `add_source`
- `remove_source`
- `update_interest`
- `submit_feedback`
- `ingest_url`
- `trigger_discovery`

Require authentication and appropriate confirmation for consequential changes.

### Example interactions

- "What have you discovered about small specialist models today?"
- "Summarise recent developments in AI agent orchestration."
- "What interesting conversations were discovered on Reddit?"
- "Why did you exclude this article from today's digest?"
- "What has changed since last week's coverage?"
- "I'm interested in robotics now. Start looking for relevant projects."
- "Find connections between these research papers."

Every factual answer should retain links to source material.

MCP responses should distinguish retrieved facts, model summaries, uncertain claims and unavailable source content.

Support both today's developing knowledge collection and historical material.

## 10. Newsletter curation and delivery

Publish a curated digest at a configurable time, initially 06:00 Europe/London.

The digest should:

- Prioritise valuable information rather than volume.
- Group coverage of the same specific development.
- Avoid repeated stories from earlier editions unless there is a meaningful update.
- Balance coverage across interest categories.
- Highlight worthwhile discoveries outside subscribed sources.
- Explain why important developments matter.
- Link to original sources.
- Include a mechanism for explicit feedback.

Persist immutable editions before sending.

Ensure publication retries cannot accidentally deliver the same edition twice. Use durable send state and provider idempotency where supported.

Later, consider configurable important-event alerts and replying to the newsletter with questions.

## 11. Scheduling and reliability

Use `Bun.cron` for in-process schedules, backed by durable job state in SQLite.

Support:

- Restart recovery.
- Job leases and stale-job reclamation.
- Idempotent processing.
- Retry with exponential backoff.
- Per-source rate limits.
- Bounded AI concurrency.
- Structured logging.
- Processing and model-cost metrics.
- Partial failure tolerance.

Avoid running expensive model calls inside database transactions.

The webhook handler should acknowledge successfully persisted events quickly and perform actual processing asynchronously.

Keep external content isolated from instructions and privileged operations. Treat ingested pages, newsletters and repository text as untrusted.

## 12. Development milestones

### M1 — Functional foundation

Create the repository and implement a working vertical slice:

- Bun project with strict TypeScript.
- Hono HTTP server.
- SQLite, Drizzle migrations and FTS5.
- Source-independent content model.
- Native RSS/Atom adapter.
- OPML import.
- Durable job processing and scheduling.
- Minimal read-only MCP endpoint.
- CLI commands.
- Docker Compose and persistent storage.
- Unit and integration tests.

**Acceptance:** Import a set of RSS subscriptions, ingest articles, survive restarts, avoid duplicates, and search collected content through MCP.

Verify Bun compatibility with the actual MCP, Drizzle and Resend SDK versions early. Pin tested dependency versions.

### M2 — Content intelligence

- Reliable extraction and text cleaning.
- Structured summarisation.
- Interest and editorial profiles.
- Relevance and novelty scoring.
- Duplicate event grouping.
- Persisted scoring provenance.
- Developing digest queries through MCP.

**Acceptance:** Ask the service what it found today and receive useful, source-linked answers explaining the important items.

### M3 — Email ingestion and delivery

- Resend inbound webhook.
- Receiving API integration.
- Newsletter parsing and fan-out.
- Cross-source deduplication.
- Daily digest curation.
- Resend outbound delivery.
- Publication history and retry safety.

**Acceptance:** RSS and inbound email contribute to one curated daily briefing, while remaining independently searchable through MCP.

### M4 — Proactive discovery

- Web search discovery adapters.
- GitHub and Hacker News integration.
- Scheduled interest-based queries.
- Novel-source detection.
- Feedback mutation tools.
- Evaluation of discovery quality.

**Acceptance:** The service regularly identifies useful material from sources the user does not subscribe to.

### M5 — Refinement

Evaluate and selectively introduce:

- Reddit browser-assisted access where permitted.
- More sophisticated interest adaptation.
- Historical event tracking.
- Selective high-priority alerts.
- Advanced retrieval or embeddings if justified.
- Optional web UI.

Do not treat M5 features as MVP dependencies.

## 13. Evaluation

Measure system quality from the beginning.

Key metrics:

- Relevant discoveries not present in subscribed sources.
- Precision of the top-ranked recommendations.
- Duplicate rate.
- Missed important developments.
- Source reliability.
- Cost per useful discovery.
- End-to-end processing latency.

Create a small, representative evaluation fixture with relevant, irrelevant, duplicate and borderline items.

Keep a baseline from the existing Newsweave where practical.

Scoring changes should be testable against recorded data without sending newsletters or performing unnecessary external API calls.

## 14. Engineering constraints

- Prefer small, cohesive modules over elaborate abstractions.
- No unnecessary services or infrastructure dependencies.
- No separate database container.
- No mandatory local model.
- No vector database initially.
- No full-featured RSS reader UI.
- No custom conversational LLM implementation.
- No agent orchestration framework.
- Avoid unnecessary dependencies and binaries.
- Follow current Bun, MCP and Resend SDK documentation.
- Keep configuration explicit and secrets outside source control.
- Provide useful diagnostics and actionable errors.
- Keep implementation changes incremental and testable.

## 15. Instructions for the coding agent

1. Inspect Newsweave and Horizon for relevant implementation ideas.
2. Validate any important library/API assumptions against current documentation.
3. Propose a minimal repository structure and initial SQLite schema.
4. Identify any genuinely blocking issues; otherwise use documented defaults.
5. Implement **M1 only**, with tests.
6. Run type checking, tests and an end-to-end RSS-to-MCP smoke test.
7. Document setup, operation, configuration and remaining limitations.
8. Keep future milestones documented but do not prematurely implement them.

Start with a working vertical slice rather than building all the infrastructure upfront.

## Definition of success

The first usable release should independently ingest RSS and newsletters, maintain an accessible knowledge collection, support conversation through MCP, and deliver a curated daily email.

The longer-term measure of success is whether the service consistently surfaces worthwhile ideas, developments and connections that the user wasn't already looking for.

**Build a personal discovery engine, not another feed reader.**