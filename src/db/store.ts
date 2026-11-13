import { Database } from "bun:sqlite";
import { StoryStore } from "./story-store";
import { deliveryHistory, relatedDeliveryHistory } from "./delivery-history";
import { createHash } from "node:crypto";
import {
  currentObservedUpdate,
  type ObservedVersion,
} from "../observed-update";
import { ProfileStore } from "../profiles";
import { healthReport } from "../health";
import { advanceScoreInvalidation, invalidateScores } from "./score-queue";
import { SCORING_CRITERIA_VERSION, type ScoringInput } from "../scoring";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalItemUrl,
  canonicalUrl,
  identity,
  isGithubSourceUrl,
  isHackerNewsSourceUrl,
  parseRedditDiscussion,
  type Candidate,
  type PollResult,
} from "../domain";
export interface Source {
  id: string;
  kind: string;
  url: string;
  title: string;
  enabled: number;
  poll_seconds: number;
  next_poll: number;
  failures: number;
  last_error: string | null;
  last_success: number | null;
  removed: number;
  max_entries: number;
  max_bytes: number;
}
export interface Job {
  id: string;
  source_id: string;
  attempts: number;
  lease_token: string;
}
export type ProcessingStage = "extract" | "analyse" | "score" | "group";
export interface ProcessingJob {
  id: string;
  item_id: string;
  generation: number;
  stage: ProcessingStage;
  attempts: number;
  lease_token: string;
  origin_source_id: string | null;
  origin_url: string | null;
}
export interface AnalysisRecord {
  inputHash: string;
  provider: string;
  model: string;
  promptVersion: string;
  profiles: unknown[];
  analysis: { summary: string };
  usage: unknown;
  cost: number | null;
}
export interface ScoreRecord {
  inputHash: string;
  criteriaVersion: string;
  provenance: unknown;
  result: unknown;
  capturedAt: number;
}
function scoreDeadlines(input: ScoringInput): number[] {
  const deadlines = input.interests.flatMap((interest) =>
    interest.expiresAt === undefined ? [] : [interest.expiresAt],
  );
  if (input.publishedAt !== null)
    deadlines.push(
      input.publishedAt,
      input.publishedAt + 172800001,
      input.publishedAt + 604800001,
      input.publishedAt + 2592000001,
    );
  if (input.observedUpdateAt != null)
    deadlines.push(input.observedUpdateAt + 604800001);
  return deadlines.filter(Number.isSafeInteger);
}
export interface Item {
  id: string;
  identity: string;
  url: string | null;
  title: string;
  published_at: number | null;
  ingested_at: number;
  status: string;
  text?: string;
  snippet_provenance?: string;
  analysis_status?: string;
}
export class Store {
  readonly sqlite: Database;
  readonly stories: StoryStore;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.sqlite = new Database(path, { create: true, strict: true });
    this.sqlite.exec(
      "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;",
    );
    migrate(drizzle(this.sqlite), {
      migrationsFolder: fileURLToPath(
        new URL("../../drizzle", import.meta.url),
      ),
    });
    this.sqlite
      .transaction(() => {
        const invalidationPending = this.sqlite
          .query<{ pending: number }, []>(
            "SELECT pending FROM score_invalidation WHERE id=1",
          )
          .get()?.pending;
        const latestGlobalEvent = this.sqlite
          .query<{ kind: string }, []>(
            "SELECT kind FROM score_validity_events WHERE kind IN ('global_invalidation','global_pass_complete') ORDER BY event_at DESC,id DESC LIMIT 1",
          )
          .get()?.kind;
        if (
          invalidationPending === 0 &&
          latestGlobalEvent === "global_invalidation"
        )
          this.sqlite
            .query(
              "INSERT INTO score_validity_events(item_id,score_id,kind,event_at) VALUES(NULL,NULL,'global_pass_complete',?)",
            )
            .run(Date.now());
      })
      .immediate();
    this.stories = new StoryStore(this.sqlite);
  }
  close() {
    this.sqlite.close();
  }
  /** Called inside the discovery page transaction; uses the normal identity path. */
  ingestDiscovery(
    candidate: Candidate,
    now: number,
    provider = "gdelt",
  ): string {
    if (!/^[a-z][a-z0-9-]{0,19}$/.test(provider))
      throw new Error("Invalid discovery provider");
    const sourceId = `discovery:${provider}`;
    const label =
      provider === "gdelt"
        ? "GDELT discovery"
        : provider === "github"
          ? "GitHub discovery"
          : provider === "hackernews"
            ? "Hacker News discovery"
            : `${provider} discovery`;
    this.sqlite
      .query(
        "INSERT OR IGNORE INTO sources(id,kind,url,title,enabled) VALUES(?, 'discovery', ?, ?, 0)",
      )
      .run(sourceId, sourceId, label);
    // Search metadata is not a publisher correction. Keep later observations
    // in the discovery ledger without replacing the item's current title.
    const previous = this.sqlite
      .query<{ title: string; url: string | null }, [string, string]>(
        "SELECT title,url FROM content_versions WHERE source_id=? AND native_id=? ORDER BY id DESC LIMIT 1",
      )
      .get(sourceId, candidate.nativeId);
    return this.insert(
      previous
        ? {
            ...candidate,
            title: previous.title,
            sourceUrl: previous.url ?? undefined,
          }
        : candidate,
      sourceId,
      now,
    );
  }
  /**
   * Called inside the manual submission transaction. Uses the normal identity
   * path so an already-followed article gains a manual reference instead of a
   * duplicate item.
   */
  ingestManual(candidate: Candidate, sourceId: string, now: number): string {
    if (!/^manual:[a-z]{3,20}$/.test(sourceId))
      throw new Error("Invalid manual source");
    return this.insert(candidate, sourceId, now);
  }
  addSource(url: string, title = url, pollSeconds = 1800): Source {
    if (
      !Number.isSafeInteger(pollSeconds) ||
      pollSeconds < 60 ||
      pollSeconds > 31536000
    )
      throw new Error(
        "Polling interval must be an integer between 60 and 31536000 seconds",
      );
    if (!title.trim() || title.length > 1000)
      throw new Error("Invalid source title");
    url = canonicalUrl(url);
    const kind = this.sourceKind(url);
    this.sqlite
      .query(
        "INSERT INTO sources(id,url,title,poll_seconds,kind) VALUES(?,?,?,?,?) ON CONFLICT(url) DO UPDATE SET enabled=CASE WHEN removed=1 THEN 1 ELSE enabled END,removed=0",
      )
      .run(crypto.randomUUID(), url, title, pollSeconds, kind);
    return this.sqlite
      .query<Source, [string]>("SELECT * FROM sources WHERE url=?")
      .get(url)!;
  }
  private sourceKind(url: string): string {
    if (isGithubSourceUrl(url)) return "github";
    if (isHackerNewsSourceUrl(url)) return "hackernews";
    const parsed = new URL(url);
    if (parsed.hostname.toLowerCase() === "github.com") {
      const path = parsed.pathname.toLowerCase();
      if (!/\.(atom|xml|rss)$/.test(path))
        throw new Error(
          "GitHub sources must point at /releases or /events, or an Atom/RSS file path such as /releases.atom",
        );
    }
    return "rss";
  }
  sources(page?: { limit: number; offset: number }): Source[] {
    // Manual intake bookkeeping is not a polled subscription.
    if (!page)
      return this.sqlite
        .query<Source, []>(
          "SELECT * FROM sources WHERE removed=0 AND kind<>'manual' ORDER BY title,id",
        )
        .all();
    return this.sqlite
      .query<Source, [number, number]>(
        "SELECT * FROM sources WHERE removed=0 AND kind<>'manual' ORDER BY title,id LIMIT ? OFFSET ?",
      )
      .all(page.limit, page.offset);
  }
  updateSource(
    id: string,
    changes: {
      title?: string;
      pollSeconds?: number;
      enabled?: boolean;
      maxEntries?: number;
      maxBytes?: number;
    },
  ): Source {
    return this.sqlite
      .transaction(() => {
        const source = this.source(id);
        if (!source || source.removed) throw new Error("Source not found");
        if (
          source.kind !== "rss" &&
          source.kind !== "github" &&
          source.kind !== "hackernews"
        )
          throw new Error(
            "Only RSS, GitHub or Hacker News sources can be managed here",
          );
        const title = changes.title ?? source.title;
        if (!title.trim() || title.length > 1000)
          throw new Error("Invalid source title");
        const interval = changes.pollSeconds ?? source.poll_seconds;
        if (
          !Number.isSafeInteger(interval) ||
          interval < 60 ||
          interval > 31536000
        )
          throw new Error("Invalid polling interval");
        const maxEntries = changes.maxEntries ?? source.max_entries;
        const maxBytes = changes.maxBytes ?? source.max_bytes;
        if (
          !Number.isSafeInteger(maxEntries) ||
          maxEntries < 1 ||
          maxEntries > 10000 ||
          !Number.isSafeInteger(maxBytes) ||
          maxBytes < 1 ||
          maxBytes > 20000000
        )
          throw new Error("Invalid feed budget");
        this.sqlite
          .query(
            "UPDATE sources SET title=?,poll_seconds=?,enabled=?,max_entries=?,max_bytes=? WHERE id=?",
          )
          .run(
            title,
            interval,
            changes.enabled === undefined
              ? source.enabled
              : Number(changes.enabled),
            maxEntries,
            maxBytes,
            id,
          );
        if (changes.enabled === false) this.cancelSourceJobs(id);
        if (
          changes.pollSeconds !== undefined &&
          interval !== source.poll_seconds
        ) {
          const now = Date.now();
          this.sqlite
            .query("UPDATE sources SET next_poll=? WHERE id=?")
            .run(
              source.last_success === null
                ? 0
                : Math.max(now, source.last_success + interval * 1000),
              id,
            );
        }
        if (
          maxEntries !== source.max_entries ||
          maxBytes !== source.max_bytes
        ) {
          // A running request uses the old budget and could restore old validators.
          this.cancelSourceJobs(id);
          this.sqlite
            .query(
              "UPDATE source_state SET etag=NULL,last_modified=NULL,cursor=NULL WHERE source_id=?",
            )
            .run(id);
          this.sqlite
            .query("UPDATE sources SET next_poll=0 WHERE id=?")
            .run(id);
        }
        return this.source(id)!;
      })
      .immediate();
  }
  private cancelSourceJobs(id: string): number {
    return this.sqlite
      .query(
        "UPDATE jobs SET status='cancelled',lease_token=NULL,lease_until=NULL,finished_at=? WHERE source_id=? AND status IN ('pending','running')",
      )
      .run(Date.now(), id).changes;
  }
  /**
   * Soft-removes a subscription. The row, its items, references and content
   * versions stay so historical citations keep resolving; queued and running
   * polls are cancelled, and a running lease is cleared so a late completion
   * is rejected. Returns the number of cancelled jobs.
   */
  removeSource(id: string): number {
    return this.sqlite
      .transaction(() => {
        if (
          !this.sqlite
            .query(
              "UPDATE sources SET removed=1,enabled=0 WHERE id=? AND removed=0 AND kind IN ('rss','github','hackernews')",
            )
            .run(id).changes
        )
          throw new Error("Source not found");
        return this.cancelSourceJobs(id);
      })
      .immediate();
  }
  source(id: string): Source | null {
    return this.sqlite
      .query<Source, [string]>("SELECT * FROM sources WHERE id=?")
      .get(id);
  }
  state(id: string): { etag?: string; lastModified?: string; cursor?: string } {
    const row = this.sqlite
      .query<
        {
          etag: string | null;
          last_modified: string | null;
          cursor: string | null;
        },
        [string]
      >("SELECT * FROM source_state WHERE source_id=?")
      .get(id);
    return {
      etag: row?.etag ?? undefined,
      lastModified: row?.last_modified ?? undefined,
      cursor: row?.cursor ?? undefined,
    };
  }
  enqueueDue(now = Date.now(), force = false): number {
    return this.sqlite
      .transaction(() => {
        let count = 0;
        for (const s of this.sources().filter(
          (s) =>
            (s.kind === "rss" ||
              s.kind === "github" ||
              s.kind === "hackernews") &&
            s.enabled &&
            (force || s.next_poll <= now),
        )) {
          count += this.sqlite
            .query(
              "INSERT OR IGNORE INTO jobs(id,source_id,available_at,created_at) VALUES(?,?,?,?)",
            )
            .run(crypto.randomUUID(), s.id, now, now).changes;
        }
        return count;
      })
      .immediate();
  }
  /**
   * Claims the next due poll. `excludeHosts` lists hosts already at their
   * concurrency ceiling; the query skips their jobs so one slow or failing host
   * cannot take every worker slot. Running leases are the only in-flight state,
   * so reclaimed or restarted jobs are not double counted.
   */
  claim(
    now = Date.now(),
    options: {
      hostLimit?: number;
      hostOf?: (sourceUrl: string) => string;
    } = {},
  ): Job | null {
    return this.sqlite
      .transaction(() => {
        this.sqlite
          .query(
            "UPDATE jobs SET status=CASE WHEN attempts>=5 THEN 'failed' ELSE 'pending' END, lease_token=NULL, lease_until=NULL, last_error='Expired lease recovered' WHERE status='running' AND lease_until<=?",
          )
          .run(now);
        const hostLimit = options.hostLimit;
        if (hostLimit === undefined || !options.hostOf) {
          return this.sqlite
            .query<Job, [string, number, number]>(
              `UPDATE jobs SET status='running',attempts=attempts+1,lease_token=?,lease_until=?
        WHERE id=(SELECT j.id FROM jobs j JOIN sources s ON s.id=j.source_id WHERE j.status='pending' AND j.available_at<=? AND s.kind IN ('rss','github','hackernews') AND s.enabled=1 AND s.removed=0 ORDER BY j.available_at,j.created_at LIMIT 1)
        RETURNING id,source_id,attempts,lease_token`,
            )
            .get(crypto.randomUUID(), now + 60_000, now);
        }
        const hostOf = options.hostOf;
        const running = new Map<string, number>();
        for (const row of this.sqlite
          .query<{ url: string }, []>(
            "SELECT s.url FROM jobs j JOIN sources s ON s.id=j.source_id WHERE j.status='running'",
          )
          .all()) {
          const host = hostOf(row.url);
          running.set(host, (running.get(host) ?? 0) + 1);
        }
        // Page through due jobs until one belongs to a host with capacity, so a
        // long backlog for a saturated host cannot hide a healthy feed.
        let pick: { id: string } | undefined;
        let cursor:
          { available: number; created: number; id: string } | undefined;
        for (;;) {
          const page = this.sqlite
            .query<
              { id: string; url: string; available: number; created: number },
              [number, number, number, number, number, string]
            >(
              "SELECT j.id,s.url,j.available_at AS available,j.created_at AS created FROM jobs j JOIN sources s ON s.id=j.source_id WHERE j.status='pending' AND j.available_at<=? AND s.kind IN ('rss','github','hackernews') AND s.enabled=1 AND s.removed=0 AND (j.available_at>? OR (j.available_at=? AND (j.created_at>? OR (j.created_at=? AND j.id>?)))) ORDER BY j.available_at,j.created_at,j.id LIMIT 200",
            )
            .all(
              now,
              cursor?.available ?? -1,
              cursor?.available ?? -1,
              cursor?.created ?? -1,
              cursor?.created ?? -1,
              cursor?.id ?? "",
            );
          if (page.length === 0) break;
          pick = page.find(
            (job) => (running.get(hostOf(job.url)) ?? 0) < hostLimit,
          );
          if (pick) break;
          const last = page[page.length - 1]!;
          cursor = {
            available: last.available,
            created: last.created,
            id: last.id,
          };
        }
        if (!pick) return null;
        return this.sqlite
          .query<Job, [string, number, string]>(
            `UPDATE jobs SET status='running',attempts=attempts+1,lease_token=?,lease_until=? WHERE id=? AND status='pending'
        RETURNING id,source_id,attempts,lease_token`,
          )
          .get(crypto.randomUUID(), now + 60_000, pick.id);
      })
      .immediate();
  }
  private markGroupingDirty(itemId: string, now: number): void {
    // Invalidate before reusing an already-pending grouping job: the queued
    // job must observe new evidence rather than reusing a cached snapshot.
    this.sqlite
      .query("UPDATE story_grouping_state SET fingerprint='dirty' WHERE id=1")
      .run();
    const groupingState = this.sqlite
      .query<{ state: string }, []>(
        "SELECT state FROM story_grouping_events ORDER BY event_at DESC,id DESC LIMIT 1",
      )
      .get()?.state;
    if (groupingState !== "dirty")
      this.sqlite
        .query(
          "INSERT INTO story_grouping_events(state,event_at) VALUES('dirty',?)",
        )
        .run(now);
    const last = this.sqlite
      .query<{ generation: number; status: string }, [string]>(
        "SELECT generation,status FROM processing_jobs WHERE stage='group' AND item_id=? ORDER BY generation DESC LIMIT 1",
      )
      .get(itemId);
    // A pending job will see the latest snapshot. If a job is already running,
    // a new generation ensures that an intervening correction is replayed.
    if (last?.status === "pending") return;
    this.enqueueProcessing("group", itemId, now, (last?.generation ?? 0) + 1);
  }
  enqueueProcessing(
    stage: ProcessingStage,
    itemId: string,
    now = Date.now(),
    generation = 1,
    originSourceId: string | null = null,
    originUrl: string | null = null,
  ): boolean {
    return (
      this.sqlite
        .query(
          "INSERT OR IGNORE INTO processing_jobs(id,stage,item_id,available_at,queued_at,created_at,generation,origin_source_id,origin_url) VALUES(?,?,?,?,?,?,?,?,?)",
        )
        .run(
          crypto.randomUUID(),
          stage,
          itemId,
          now,
          now,
          now,
          generation,
          originSourceId,
          originUrl,
        ).changes === 1
    );
  }
  claimProcessing(
    stage: ProcessingStage,
    now = Date.now(),
  ): ProcessingJob | null {
    return this.sqlite
      .transaction(() => {
        if (stage === "score") {
          advanceScoreInvalidation(this.sqlite, now);
          // Move at most one indexed refresh into the work queue per claim.
          const refresh = this.sqlite
            .query<{ job_id: string }, [number, string, string]>(
              `SELECT job_id FROM score_refresh WHERE due_at<=?
             UNION ALL SELECT job_id FROM score_refresh WHERE criteria_version<?
             UNION ALL SELECT job_id FROM score_refresh WHERE criteria_version>?
             LIMIT 1`,
            )
            .get(now, SCORING_CRITERIA_VERSION, SCORING_CRITERIA_VERSION);
          if (refresh) {
            this.sqlite
              .query("DELETE FROM score_refresh WHERE job_id=?")
              .run(refresh.job_id);
            this.sqlite
              .query(
                "UPDATE processing_jobs SET status='pending',attempts=0,available_at=?,queued_at=?,last_error=NULL WHERE id=? AND status='done' AND outcome='scored'",
              )
              .run(now, now, refresh.job_id);
          }
        }
        this.sqlite
          .query(
            "UPDATE processing_jobs SET status=CASE WHEN attempts>=5 THEN 'failed' ELSE 'pending' END,lease_token=NULL,lease_until=NULL WHERE status='running' AND lease_until<=?",
          )
          .run(now);
        const claimed = this.sqlite
          .query<ProcessingJob, [string, number, string, number]>(
            `UPDATE processing_jobs SET status='running',attempts=attempts+1,lease_token=?,lease_until=? WHERE id=(SELECT id FROM processing_jobs WHERE stage=? AND status='pending' AND available_at<=? ORDER BY available_at,created_at LIMIT 1) RETURNING id,item_id,stage,generation,attempts,lease_token,origin_source_id,origin_url`,
          )
          .get(crypto.randomUUID(), now + 60_000, stage, now);
        if (claimed && stage === "score") {
          const latest = this.sqlite
            .query<{ n: number }, [string]>(
              "SELECT max(generation) AS n FROM processing_jobs WHERE stage='extract' AND item_id=?",
            )
            .get(claimed.item_id)?.n;
          if (latest !== claimed.generation) {
            this.sqlite
              .query(
                "UPDATE processing_jobs SET status='done',outcome='superseded',lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=?",
              )
              .run(claimed.id, claimed.lease_token);
            return null;
          }
        }
        return claimed;
      })
      .immediate();
  }
  renewProcessing(
    job: ProcessingJob,
    duration: number,
    now = Date.now(),
  ): boolean {
    if (!Number.isSafeInteger(duration) || duration <= 0)
      throw new Error("Invalid lease duration");
    return (
      this.sqlite
        .query(
          "UPDATE processing_jobs SET lease_until=? WHERE id=? AND status='running' AND lease_token=? AND lease_until>?",
        )
        .run(now + duration, job.id, job.lease_token, now).changes === 1
    );
  }
  completeProcessing(
    job: ProcessingJob,
    status: string,
    now = Date.now(),
    result: string | null = null,
  ): boolean {
    const expected = {
      extract: "extracted",
      analyse: "analysed",
      score: "scored",
      group: "grouped",
    } as const;
    if (status !== expected[job.stage] && status !== "unavailable")
      throw new Error("Invalid processing transition");
    return this.sqlite
      .transaction(() => {
        const changed = this.sqlite
          .query(
            "UPDATE processing_jobs SET status='done',result=?,outcome=?,lease_token=NULL,lease_until=NULL WHERE id=? AND status='running' AND lease_token=? AND lease_until>? AND item_id=? AND stage=? AND generation=?",
          )
          .run(
            result,
            status,
            job.id,
            job.lease_token,
            now,
            job.item_id,
            job.stage,
            job.generation,
          ).changes;
        if (!changed) return false;
        if (job.stage === "group") return true;
        const latest = this.sqlite
          .query<{ n: number }, [string]>(
            "SELECT max(generation) AS n FROM processing_jobs WHERE item_id=? AND stage='extract'",
          )
          .get(job.item_id)!.n;
        if (job.generation !== latest) return true;
        this.sqlite
          .query("UPDATE items SET status=? WHERE id=?")
          .run(status === "scored" ? "available" : status, job.item_id);
        const next =
          job.stage === "extract"
            ? "analyse"
            : job.stage === "analyse"
              ? "score"
              : null;
        if (job.stage === "extract") {
          this.markGroupingDirty(job.item_id, now);
          this.enqueueProcessing("score", job.item_id, now, job.generation);
        }
        if (job.stage === "analyse" && status === "unavailable")
          invalidateScores(this.sqlite, now, job.item_id);
        if (next)
          this.enqueueProcessing(
            next,
            job.item_id,
            now,
            job.generation,
            job.origin_source_id,
            job.origin_url,
          );
        return true;
      })
      .immediate();
  }
  retryFailedAnalysis(itemId: string, now = Date.now()): boolean {
    return (
      this.sqlite
        .query(
          `UPDATE processing_jobs SET status='pending',attempts=0,available_at=?,queued_at=?,last_error=NULL
      WHERE item_id=? AND stage='analyse' AND status='failed' AND generation=(SELECT max(generation) FROM processing_jobs WHERE item_id=? AND stage='extract')`,
        )
        .run(now, now, itemId, itemId).changes === 1
    );
  }
  requestReanalysis(itemId: string, now = Date.now()): boolean {
    return this.sqlite
      .transaction(() => {
        const previous = this.sqlite
          .query<
            { generation: number; result: string | null; outcome: string },
            [string]
          >(
            "SELECT generation,result,outcome FROM processing_jobs WHERE item_id=? AND stage='extract' AND status='done' AND outcome IN ('extracted','unavailable') ORDER BY generation DESC LIMIT 1",
          )
          .get(itemId);
        if (!previous) return false;
        const newest = this.sqlite
          .query<{ n: number }, [string]>(
            "SELECT max(generation) AS n FROM processing_jobs WHERE item_id=? AND stage='extract'",
          )
          .get(itemId);
        if (newest?.n !== previous.generation) return false;
        const completed = this.sqlite
          .query(
            "SELECT 1 FROM processing_jobs WHERE item_id=? AND stage='analyse' AND generation=? AND status='done'",
          )
          .get(itemId, previous.generation);
        if (!completed) return false;
        const generation = previous.generation + 1;
        this.sqlite
          .query(
            "INSERT INTO processing_jobs(id,item_id,stage,generation,status,outcome,attempts,available_at,queued_at,created_at,result) VALUES(?,?,'extract',?,'done',?,0,?,?,?,?)",
          )
          .run(
            crypto.randomUUID(),
            itemId,
            generation,
            previous.outcome,
            now,
            now,
            now,
            previous.result,
          );
        this.sqlite
          .query("UPDATE items SET status='extracted' WHERE id=?")
          .run(itemId);
        this.enqueueProcessing("analyse", itemId, now, generation);
        return true;
      })
      .immediate();
  }
  completeAnalysis(
    job: ProcessingJob,
    record: AnalysisRecord,
    now = Date.now(),
  ): boolean {
    if (job.stage !== "analyse") throw new Error("Expected analysis job");
    return this.sqlite
      .transaction(() => {
        if (
          !this.completeProcessing(job, "analysed", now, JSON.stringify(record))
        )
          return false;
        this.sqlite
          .query(
            "INSERT OR IGNORE INTO analyses(id,item_id,generation,input_hash,provider,model,prompt_version,profiles,result,usage,cost,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
          )
          .run(
            crypto.randomUUID(),
            job.item_id,
            job.generation,
            record.inputHash,
            record.provider,
            record.model,
            record.promptVersion,
            JSON.stringify(record.profiles),
            JSON.stringify(record.analysis),
            JSON.stringify(record.usage),
            record.cost,
            now,
          );
        invalidateScores(this.sqlite, now, job.item_id);
        return true;
      })
      .immediate();
  }
  scoringSnapshot(job: ProcessingJob, now = Date.now()) {
    const item = this.sqlite
      .query<Item, [string]>(
        "SELECT i.*,c.text FROM items i LEFT JOIN content c ON c.item_id=i.id WHERE i.id=?",
      )
      .get(job.item_id);
    if (!item || job.stage !== "score") return null;
    const latest = this.sqlite
      .query<{ n: number }, [string]>(
        "SELECT max(generation) AS n FROM processing_jobs WHERE item_id=? AND stage='extract'",
      )
      .get(job.item_id)?.n;
    if (latest !== job.generation) return null;
    const profiles = new ProfileStore(this.sqlite);
    const interests = profiles.activeInterests(now);
    const editorial = profiles.latestEditorial();
    const versions = this.sqlite
      .query<ObservedVersion & { observed_at: number }, [string, number]>(
        `WITH recent AS (SELECT id,source_id,native_id,title,text,backfilled,observed_at FROM content_versions WHERE item_id=? AND observed_at>=?),
        anchors AS (SELECT DISTINCT (SELECT max(p.id) FROM content_versions p WHERE p.source_id=r.source_id AND p.native_id=r.native_id AND p.id<r.id) AS id FROM recent r
          WHERE r.id=(SELECT min(q.id) FROM recent q WHERE q.source_id=r.source_id AND q.native_id=r.native_id))
        SELECT id,source_id,native_id,title,text,backfilled,observed_at FROM recent
        UNION ALL SELECT v.id,v.source_id,v.native_id,v.title,v.text,v.backfilled,v.observed_at FROM content_versions v JOIN anchors a ON a.id=v.id ORDER BY id`,
      )
      .all(job.item_id, now - 7 * 86_400_000);
    const update = currentObservedUpdate(versions);
    const extractionRaw = this.processingResult(
      "extract",
      job.item_id,
      job.generation,
    );
    let extraction: { text?: string; status?: string } | null = null;
    if (extractionRaw) {
      try {
        extraction = JSON.parse(extractionRaw) as {
          text?: string;
          status?: string;
        };
      } catch {
        /* Historical opaque extraction. */
      }
    }
    const analysisRow = this.sqlite
      .query<
        {
          id: string;
          result: string;
          profiles: string;
          provider: string;
          model: string;
          prompt_version: string;
          input_hash: string;
        },
        [string, number]
      >(
        "SELECT id,result,profiles,provider,model,prompt_version,input_hash FROM analyses WHERE item_id=? AND generation=? ORDER BY created_at DESC,rowid DESC LIMIT 1",
      )
      .get(job.item_id, job.generation);
    const analysis = analysisRow
      ? {
          ...analysisRow,
          result: JSON.parse(analysisRow.result) as ScoringInput["analysis"],
          profiles: JSON.parse(analysisRow.profiles) as unknown,
        }
      : null;
    const story = this.sqlite
      .query<
        {
          group_id: string;
          evidence: string;
          rule_version: string;
          started_at: number;
        },
        [string]
      >(
        "SELECT group_id,evidence,rule_version,started_at FROM story_memberships WHERE item_id=? AND ended_at IS NULL",
      )
      .get(job.item_id);
    const currentText = extraction?.text?.trim() || item.text || "";
    let history: {
      input: ScoringInput["history"] | null;
      evidence: unknown;
    } = deliveryHistory(
      this.sqlite,
      item.id,
      story?.group_id ?? null,
      item.title,
      currentText,
      update,
      now,
      job.generation,
    );
    // A directional relation is only an advisory cross-development comparison.
    // It never turns a distinct story into a duplicate or verified update.
    const directEvidence = history.evidence as {
      state?: string;
      reason?: string;
    };
    if (
      history.input === null &&
      directEvidence.state === "unknown" &&
      directEvidence.reason === "no_confirmed_delivery"
    ) {
      const related = relatedDeliveryHistory(
        this.sqlite,
        item.id,
        story?.group_id ?? null,
        item.title,
        currentText,
        item.published_at,
        now,
        job.generation,
      );
      if (related)
        history = {
          input: null,
          evidence: {
            ...directEvidence,
            relatedComparison: related.evidence,
          },
        };
    }
    const feedbackRow = this.sqlite
      .query<{ useful: number; created_at: number }, [string]>(
        // Newest first; rowid breaks same-millisecond ties deterministically.
        "SELECT useful,created_at FROM item_feedback WHERE item_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1",
      )
      .get(item.id);
    const input: ScoringInput = {
      itemId: item.id,
      title: item.title,
      text: currentText,
      publishedAt: item.published_at,
      now,
      interests,
      editorialProfiles: editorial,
      analysis: analysis?.result ?? null,
      history: history.input,
      observedUpdateAt: update?.observedAt ?? null,
      feedback: feedbackRow
        ? { useful: feedbackRow.useful === 1, at: feedbackRow.created_at }
        : null,
    };
    const provenance = {
      input,
      invalidationGeneration:
        this.sqlite
          .query<{ generation: number }, []>(
            "SELECT generation FROM score_invalidation WHERE id=1",
          )
          .get()?.generation ?? 0,
      interests,
      editorial,
      analysis,
      extraction,
      story,
      generation: job.generation,
      history: history.evidence,
      observedUpdate: update,
    };
    const inputHash = createHash("sha256")
      .update(
        JSON.stringify({
          criteriaVersion: SCORING_CRITERIA_VERSION,
          input,
          provenance,
        }),
      )
      .digest("hex");
    return { input, inputHash, provenance };
  }
  completeScore(
    job: ProcessingJob,
    record: ScoreRecord,
    now = Date.now(),
  ): boolean {
    if (job.stage !== "score") throw new Error("Expected score job");
    return this.sqlite
      .transaction(() => {
        const captured = this.scoringSnapshot(job, record.capturedAt);
        if (
          !captured ||
          captured.inputHash !== record.inputHash ||
          scoreDeadlines(captured.input).some(
            (deadline) => deadline > record.capturedAt && deadline <= now,
          )
        ) {
          if (!captured) {
            this.sqlite
              .query(
                "UPDATE processing_jobs SET status='done',outcome='superseded',lease_token=NULL,lease_until=NULL WHERE id=? AND status='running' AND lease_token=? AND lease_until>?",
              )
              .run(job.id, job.lease_token, now);
            return false;
          }
          this.sqlite
            .query(
              "UPDATE processing_jobs SET status='pending',attempts=0,available_at=?,queued_at=?,lease_token=NULL,lease_until=NULL WHERE id=? AND status='running' AND lease_token=? AND lease_until>?",
            )
            .run(now, now, job.id, job.lease_token, now);
          return false;
        }
        if (
          !this.completeProcessing(job, "scored", now, JSON.stringify(record))
        )
          return false;
        const scoreId = crypto.randomUUID();
        this.sqlite
          .query(
            "INSERT OR IGNORE INTO item_scores(id,item_id,generation,input_hash,criteria_version,provenance,result,created_at) VALUES(?,?,?,?,?,?,?,?)",
          )
          .run(
            scoreId,
            job.item_id,
            job.generation,
            record.inputHash,
            record.criteriaVersion,
            JSON.stringify(record.provenance),
            JSON.stringify(record.result),
            now,
          );
        const persistedScore = this.sqlite
          .query<{ id: string }, [string, number, string]>(
            "SELECT id FROM item_scores WHERE item_id=? AND generation=? AND input_hash=?",
          )
          .get(job.item_id, job.generation, record.inputHash);
        const future = scoreDeadlines(captured.input).filter(
          (deadline) => deadline > now,
        );
        this.sqlite
          .query(
            "INSERT INTO score_validity_events(item_id,score_id,kind,event_at,valid_until) VALUES(?,?,'score_valid',?,?)",
          )
          .run(
            job.item_id,
            persistedScore?.id ?? scoreId,
            now,
            future.length ? Math.min(...future) : null,
          );
        this.sqlite
          .query(
            "INSERT INTO score_refresh(job_id,criteria_version,due_at) VALUES(?,?,?) ON CONFLICT(job_id) DO UPDATE SET criteria_version=excluded.criteria_version,due_at=excluded.due_at",
          )
          .run(
            job.id,
            record.criteriaVersion,
            future.length ? Math.min(...future) : null,
          );
        return true;
      })
      .immediate();
  }
  scoreReferences(itemId: string) {
    const id =
      this.sqlite
        .query<{ item_id: string }, [string]>(
          "SELECT item_id FROM item_redirects WHERE old_id=?",
        )
        .get(itemId)?.item_id ?? itemId;
    if (!this.sqlite.query("SELECT 1 FROM items WHERE id=?").get(id))
      return null;
    return this.sqlite
      .query(
        `SELECT r.*,s.title AS source_title,s.url AS feed_url,
          json_extract(m.body,'$.metadata.from') AS newsletter_sender,
          m.received_at AS newsletter_received_at,
          m.provider AS newsletter_provider,
          m.provider_id AS newsletter_message_id,
          m.index_diagnostics AS newsletter_diagnostics
         FROM item_sources r JOIN sources s ON s.id=r.source_id
         LEFT JOIN inbound_messages m ON s.kind='inbound' AND m.item_id=coalesce(r.parent_item_id,r.item_id)
         WHERE r.item_id=?`,
      )
      .all(id);
  }
  scoreHistory(itemId: string, limit = 20, before?: number) {
    const resolved =
      this.sqlite
        .query<{ item_id: string }, [string]>(
          "SELECT item_id FROM item_redirects WHERE old_id=?",
        )
        .get(itemId)?.item_id ?? itemId;
    return this.sqlite
      .query<
        {
          id: string;
          item_id: string;
          generation: number;
          input_hash: string;
          criteria_version: string;
          provenance: string;
          result: string;
          created_at: number;
          cursor: number;
        },
        [string, number, number]
      >(
        "SELECT rowid AS cursor, * FROM item_scores WHERE item_id=? AND rowid<? ORDER BY rowid DESC LIMIT ?",
      )
      .all(resolved, before ?? Number.MAX_SAFE_INTEGER, limit)
      .map((row) => ({
        ...row,
        provenance: JSON.parse(row.provenance) as unknown,
        result: JSON.parse(row.result) as unknown,
      }));
  }
  processingResult(
    stage: ProcessingStage,
    itemId: string,
    generation?: number,
  ): string | null {
    return (
      this.sqlite
        .query<
          { result: string | null },
          [string, string, number | null, string]
        >(
          "SELECT result FROM processing_jobs WHERE stage=? AND item_id=? AND generation=coalesce(?,(SELECT max(generation) FROM processing_jobs WHERE stage='extract' AND item_id=?)) AND status='done'",
        )
        .get(stage, itemId, generation ?? null, itemId)?.result ?? null
    );
  }
  failProcessing(job: ProcessingJob, error: string, now = Date.now()): boolean {
    const next = now + Math.min(3600000, 30000 * 2 ** (job.attempts - 1));
    return (
      this.sqlite
        .query(
          "UPDATE processing_jobs SET status=?,available_at=?,last_error=?,lease_token=NULL,lease_until=NULL WHERE id=? AND status='running' AND lease_token=? AND lease_until>?",
        )
        .run(
          job.attempts >= 5 ? "failed" : "pending",
          next,
          error.slice(0, 2000),
          job.id,
          job.lease_token,
          now,
        ).changes === 1
    );
  }
  // A URL can outlive a feed's native ID, so resolve it separately from items.identity.
  // All calls occur inside the ingestion transaction.
  private mergeItems(winner: string, loser: string): void {
    if (winner === loser) return;
    const destination = this.sqlite
      .query<{ url: string | null; published_at: number | null }, [string]>(
        "SELECT url,published_at FROM items WHERE id=?",
      )
      .get(winner);
    if (!destination) throw new Error("Canonical item is missing");
    const source = this.sqlite
      .query<{ url: string | null; published_at: number | null }, [string]>(
        "SELECT url,published_at FROM items WHERE id=?",
      )
      .get(loser);
    if (!source) throw new Error("Alias source item is missing");

    const offset = this.sqlite
      .query<{ n: number }, [string]>(
        "SELECT coalesce(max(generation),0) AS n FROM processing_jobs WHERE item_id=?",
      )
      .get(winner)!.n;
    // Distinct generations prevent unique stage/item/generation collisions, and
    // preserve analysis-to-extraction generation relationships after the move.
    this.sqlite
      .query(
        "UPDATE processing_jobs SET item_id=?,generation=generation+? WHERE item_id=?",
      )
      .run(winner, offset, loser);
    this.sqlite
      .query(
        "UPDATE analyses SET item_id=?,generation=generation+? WHERE item_id=?",
      )
      .run(winner, offset, loser);
    this.sqlite
      .query(
        "UPDATE item_scores SET item_id=?,generation=generation+? WHERE item_id=?",
      )
      .run(winner, offset, loser);
    this.sqlite
      .query("UPDATE content_versions SET item_id=? WHERE item_id=?")
      .run(winner, loser);
    this.sqlite
      .query("UPDATE item_sources SET parent_item_id=? WHERE parent_item_id=?")
      .run(winner, loser);
    this.sqlite
      .query("UPDATE item_sources SET item_id=? WHERE item_id=?")
      .run(winner, loser);
    this.sqlite
      .query("UPDATE inbound_messages SET item_id=? WHERE item_id=?")
      .run(winner, loser);
    this.sqlite
      .query("UPDATE discovery_results SET item_id=? WHERE item_id=?")
      .run(winner, loser);
    // Submission provenance is durable history; repoint it before the loser
    // is deleted so the foreign key never dangles.
    this.sqlite
      .query("UPDATE manual_submissions SET item_id=? WHERE item_id=?")
      .run(winner, loser);
    // Explicit feedback follows the surviving item so later scoring sees it.
    this.sqlite
      .query("UPDATE item_feedback SET item_id=? WHERE item_id=?")
      .run(winner, loser);
    this.sqlite
      .query("UPDATE item_url_aliases SET item_id=? WHERE item_id=?")
      .run(winner, loser);
    // Preserve the membership trail when an exact-identity alias is reconciled.
    // The former ID remains resolvable through item_redirects.
    this.sqlite
      .query(
        "UPDATE story_memberships SET ended_at=coalesce(ended_at,?) WHERE item_id=?",
      )
      .run(Date.now(), loser);
    this.sqlite
      .query(
        "UPDATE story_memberships SET item_id=?,original_item_id=coalesce(original_item_id,?) WHERE item_id=?",
      )
      .run(winner, loser, loser);
    this.sqlite
      .query("UPDATE item_redirects SET item_id=? WHERE item_id=?")
      .run(winner, loser);
    // Activity rows are historical facts. Repoint their canonical owner before
    // deleting the loser; the redirect event retains the old ID for detecting
    // dates whose identity changed after their historical cutoff.
    this.sqlite
      .query("UPDATE digest_activity_events SET item_id=? WHERE item_id=?")
      .run(winner, loser);
    const body = this.sqlite
      .query<{ text: string; format: string }, [string]>(
        "SELECT text,format FROM content WHERE item_id=?",
      )
      .get(loser);
    if (body)
      this.sqlite
        .query(
          "INSERT INTO content(item_id,text,format) VALUES(?,?,?) ON CONFLICT(item_id) DO UPDATE SET text=excluded.text,format=excluded.format WHERE content.text=''",
        )
        .run(winner, body.text, body.format);
    this.sqlite.query("DELETE FROM content WHERE item_id=?").run(loser);
    this.sqlite
      .query(
        "UPDATE items SET url=coalesce(url,?),published_at=coalesce(published_at,?) WHERE id=?",
      )
      .run(source.url, source.published_at, winner);
    this.sqlite
      .query("INSERT INTO item_redirects(old_id,item_id) VALUES(?,?)")
      .run(loser, winner);
    this.sqlite.query("DELETE FROM items WHERE id=?").run(loser);
  }

  /**
   * Before Reddit identity was keyed by post ID, an item's identity was the
   * full canonical URL of whichever host/slug first saw it. Find such a
   * historical item so a new canonical submission merges into it instead of
   * creating a duplicate. The post ID is a bounded alphanumeric token, so the
   * LIKE narrows the scan and each candidate is re-parsed before merging.
   */
  private legacyRedditOwners(url: string): string[] {
    const reddit = parseRedditDiscussion(url);
    if (!reddit) return [];
    const rows = this.sqlite
      .query<{ id: string; identity: string }, [string]>(
        "SELECT id,identity FROM items WHERE identity LIKE ?",
      )
      .all(`url:%${reddit.postId}%`);
    const owners: string[] = [];
    for (const row of rows) {
      if (!row.identity.startsWith("url:")) continue;
      const legacy = parseRedditDiscussion(row.identity.slice(4));
      if (legacy?.postId === reddit.postId) owners.push(row.id);
    }
    return owners;
  }

  private canonicalOwner(url: string, priorId?: string): string | undefined {
    const alias = this.sqlite
      .query<{ item_id: string }, [string]>(
        "SELECT item_id FROM item_url_aliases WHERE canonical_url=?",
      )
      .get(url)?.item_id;
    const legacy = this.sqlite
      .query<{ id: string }, [string]>("SELECT id FROM items WHERE identity=?")
      .get(`url:${url}`)?.id;
    const legacyReddit = this.legacyRedditOwners(url);
    const owner = alias ?? legacy ?? legacyReddit[0] ?? priorId;
    if (!owner) return undefined;
    const losers = new Set<string>();
    if (legacy) losers.add(legacy);
    for (const duplicate of legacyReddit) losers.add(duplicate);
    if (priorId) losers.add(priorId);
    losers.delete(owner);
    for (const loser of losers) this.mergeItems(owner, loser);
    this.sqlite
      .query(
        "INSERT INTO item_url_aliases(canonical_url,item_id) VALUES(?,?) ON CONFLICT(canonical_url) DO UPDATE SET item_id=excluded.item_id",
      )
      .run(url, owner);
    return owner;
  }

  private insert(
    candidate: Candidate,
    sourceId: string,
    now: number,
    parentId?: string,
  ): string {
    const inbound =
      this.sqlite
        .query<{ kind: string }, [string]>(
          "SELECT kind FROM sources WHERE id=?",
        )
        .get(sourceId)?.kind === "inbound";
    const previousRef = this.sqlite
      .query<{ item_id: string; url: string | null }, [string, string]>(
        "SELECT item_id,url FROM item_sources WHERE source_id=? AND native_id=?",
      )
      .get(sourceId, candidate.nativeId);
    const url = candidate.url ? canonicalItemUrl(candidate.url) : null;
    const owner = url
      ? this.canonicalOwner(url, previousRef?.item_id)
      : previousRef?.item_id;
    const prior =
      previousRef && owner ? { ...previousRef, item_id: owner } : previousRef;
    if (prior) {
      const previous = this.sqlite
        .query<
          {
            text: string;
            title: string;
            backfilled: number;
            url: string | null;
          },
          [string, string]
        >(
          "SELECT text,title,backfilled,url FROM content_versions WHERE source_id=? AND native_id=? ORDER BY id DESC LIMIT 1",
        )
        .get(sourceId, candidate.nativeId);
      const originalUrl = candidate.sourceUrl ?? candidate.url ?? prior.url;
      const lastBody = this.sqlite
        .query<{ text: string }, [string, string]>(
          "SELECT text FROM content_versions WHERE source_id=? AND native_id=? AND text<>'' ORDER BY id DESC LIMIT 1",
        )
        .get(sourceId, candidate.nativeId)?.text;
      const changed =
        !previous ||
        previous.title !== candidate.title ||
        (candidate.text !== "" && lastBody !== candidate.text) ||
        previous.url !== originalUrl;
      if (changed || previous?.backfilled) {
        this.sqlite
          .query(
            "INSERT INTO content_versions(item_id,source_id,native_id,title,text,url,observed_at) VALUES(?,?,?,?,?,?,?)",
          )
          .run(
            prior.item_id,
            sourceId,
            candidate.nativeId,
            candidate.title,
            candidate.text,
            originalUrl,
            now,
          );
      }
      if (changed) {
        if (candidate.text)
          this.sqlite
            .query("UPDATE content SET text=? WHERE item_id=?")
            .run(candidate.text, prior.item_id);
        this.sqlite
          .query(
            "UPDATE item_sources SET url=? WHERE source_id=? AND native_id=?",
          )
          .run(originalUrl, sourceId, candidate.nativeId);
        const generation = this.sqlite
          .query<{ n: number }, [string]>(
            "SELECT coalesce(max(generation),0)+1 AS n FROM processing_jobs WHERE item_id=? AND stage='extract'",
          )
          .get(prior.item_id)!.n;
        this.sqlite
          .query("UPDATE items SET status='ingested',title=? WHERE id=?")
          .run(candidate.title, prior.item_id);
        if (candidate.url)
          this.sqlite
            .query("UPDATE items SET url=coalesce(url,?) WHERE id=?")
            .run(canonicalItemUrl(candidate.url), prior.item_id);
        this.enqueueProcessing(
          "extract",
          prior.item_id,
          now,
          generation,
          sourceId,
          inbound ? (candidate.url ?? null) : originalUrl,
        );
      } else this.enqueueProcessing("extract", prior.item_id, now);
      this.insertChildren(candidate, sourceId, now, prior.item_id);
      if (changed || (owner && owner !== previousRef?.item_id))
        this.markGroupingDirty(prior.item_id, now);
      return prior.item_id;
    }
    const key = identity(candidate, sourceId);
    if (!owner)
      this.sqlite
        .query(
          "INSERT INTO items(id,identity,url,title,published_at,ingested_at) VALUES(?,?,?,?,?,?) ON CONFLICT(identity) DO UPDATE SET published_at=coalesce(items.published_at,excluded.published_at)",
        )
        .run(
          crypto.randomUUID(),
          key,
          url,
          candidate.title,
          candidate.publishedAt ?? null,
          now,
        );
    const item = owner
      ? { id: owner }
      : this.sqlite
          .query<{ id: string }, [string]>(
            "SELECT id FROM items WHERE identity=?",
          )
          .get(key)!;
    if (url) this.canonicalOwner(url, item.id);
    this.sqlite
      .query(
        "UPDATE items SET published_at=coalesce(published_at,?) WHERE id=?",
      )
      .run(candidate.publishedAt ?? null, item.id);
    this.sqlite
      .query(
        "INSERT INTO item_sources(item_id,source_id,native_id,url,parent_item_id) VALUES(?,?,?,?,?)",
      )
      .run(
        item.id,
        sourceId,
        candidate.nativeId,
        candidate.sourceUrl ?? candidate.url ?? null,
        parentId ?? null,
      );
    this.sqlite
      .query(
        "INSERT INTO content_versions(item_id,source_id,native_id,title,text,url,observed_at) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        item.id,
        sourceId,
        candidate.nativeId,
        candidate.title,
        candidate.text,
        candidate.sourceUrl ?? candidate.url ?? null,
        now,
      );
    // Digest candidates can arrive before a feed supplies the actual body.
    if (candidate.text) {
      this.sqlite
        .query(
          `UPDATE items SET title=? WHERE id=? AND EXISTS
        (SELECT 1 FROM content WHERE item_id=? AND text='')`,
        )
        .run(candidate.title, item.id, item.id);
    }
    const existing = this.sqlite
      .query<{ text: string }, [string]>(
        "SELECT text FROM content WHERE item_id=?",
      )
      .get(item.id);
    this.sqlite
      .query(
        "INSERT INTO content(item_id,text) VALUES(?,?) ON CONFLICT(item_id) DO UPDATE SET text=excluded.text WHERE content.text=''",
      )
      .run(item.id, candidate.text);
    const generation =
      existing && !existing.text && candidate.text
        ? this.sqlite
            .query<{ n: number }, [string]>(
              "SELECT coalesce(max(generation),0)+1 AS n FROM processing_jobs WHERE item_id=? AND stage='extract'",
            )
            .get(item.id)!.n
        : 1;
    if (generation > 1)
      this.sqlite
        .query("UPDATE items SET status='ingested' WHERE id=?")
        .run(item.id);
    this.enqueueProcessing(
      "extract",
      item.id,
      now,
      generation,
      sourceId,
      inbound
        ? (candidate.url ?? null)
        : (candidate.sourceUrl ?? candidate.url ?? null),
    );
    this.insertChildren(candidate, sourceId, now, item.id);
    this.markGroupingDirty(item.id, now);
    return item.id;
  }
  private insertChildren(
    candidate: Candidate,
    sourceId: string,
    now: number,
    parentId: string,
  ): void {
    for (const child of candidate.children ?? [])
      this.insert(
        {
          nativeId: `child:${candidate.nativeId}:${child.url}`,
          url: child.url,
          sourceUrl: child.sourceUrl,
          title: child.title,
          text: "",
        },
        sourceId,
        now,
        parentId,
      );
  }
  /** Normalize outside the transaction, then atomically index the unchanged body. */
  indexNextNewsletter(
    normalize: (email: import("../inbound").ReceivedEmail) => {
      candidate: Candidate;
      bodyUnavailable: boolean;
      linksTruncated: boolean;
    },
    now = Date.now(),
  ): boolean {
    const row = this.sqlite
      .query<
        { id: string; provider: string; provider_id: string; body: string },
        []
      >(
        "SELECT id,provider,provider_id,body FROM inbound_messages WHERE status='complete' AND item_id IS NULL AND index_diagnostics IS NULL AND body IS NOT NULL ORDER BY id LIMIT 1",
      )
      .get();
    if (!row) return false;
    let normalized: ReturnType<typeof normalize>;
    try {
      const email = JSON.parse(row.body) as import("../inbound").ReceivedEmail;
      if (email.metadata.providerId !== row.provider_id)
        throw new Error("Inbound message identity mismatch");
      normalized = normalize(email);
    } catch {
      this.sqlite
        .query(
          "UPDATE inbound_messages SET index_diagnostics=? WHERE id=? AND status='complete' AND item_id IS NULL AND index_diagnostics IS NULL AND body=?",
        )
        .run(
          JSON.stringify({ error: "normalization_failed" }),
          row.id,
          row.body,
        );
      return true;
    }
    return this.sqlite
      .transaction(() => {
        const current = this.sqlite
          .query(
            "SELECT 1 FROM inbound_messages WHERE id=? AND status='complete' AND item_id IS NULL AND index_diagnostics IS NULL AND body=?",
          )
          .get(row.id, row.body);
        if (!current) return false;
        const url = `inbound:${row.provider}`;
        this.sqlite
          .query(
            "INSERT OR IGNORE INTO sources(id,kind,url,title,enabled) VALUES(?,'inbound',?,?,0)",
          )
          .run(crypto.randomUUID(), url, `Incoming email (${row.provider})`);
        const source = this.sqlite
          .query<{ id: string }, [string]>(
            "SELECT id FROM sources WHERE url=? AND kind='inbound'",
          )
          .get(url);
        if (!source) throw new Error("Inbound source identity conflict");
        const itemId = this.insert(normalized.candidate, source.id, now);
        this.sqlite
          .query(
            "UPDATE inbound_messages SET item_id=?,index_diagnostics=? WHERE id=?",
          )
          .run(
            itemId,
            JSON.stringify({
              bodyUnavailable: normalized.bodyUnavailable,
              linksTruncated: normalized.linksTruncated,
              attachments: "unsupported",
            }),
            row.id,
          );
        return true;
      })
      .immediate();
  }
  complete(job: Job, result: PollResult, now = Date.now()): boolean {
    return this.sqlite
      .transaction(() => {
        if (!this.owns(job, now)) return false;
        for (const item of result.items) this.insert(item, job.source_id, now);
        this.sqlite
          .query(
            "INSERT INTO source_state(source_id,etag,last_modified,last_checked,cursor,entry_count,truncated) VALUES(?,?,?,?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET etag=excluded.etag,last_modified=excluded.last_modified,last_checked=excluded.last_checked,cursor=excluded.cursor,entry_count=coalesce(excluded.entry_count,source_state.entry_count),truncated=coalesce(excluded.truncated,source_state.truncated)",
          )
          .run(
            job.source_id,
            result.etag ?? null,
            result.lastModified ?? null,
            now,
            result.cursor ??
              (result.notModified
                ? this.state(job.source_id).cursor
                : undefined) ??
              null,
            result.entryCount ?? null,
            result.truncated === undefined ? null : Number(result.truncated),
          );
        this.sqlite
          .query(
            "UPDATE sources SET failures=0,last_error=NULL,last_success=?,next_poll=?+poll_seconds*1000 WHERE id=?",
          )
          .run(now, now, job.source_id);
        this.sqlite
          .query(
            "UPDATE jobs SET status='done',finished_at=?,lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=?",
          )
          .run(now, job.id, job.lease_token);
        return true;
      })
      .immediate();
  }
  private owns(job: Job, now: number): boolean {
    return !!this.sqlite
      .query(
        "SELECT 1 FROM jobs WHERE id=? AND status='running' AND lease_token=? AND lease_until>?",
      )
      .get(job.id, job.lease_token, now);
  }
  fail(job: Job, error: string, retryAfterMs = 0, now = Date.now()): void {
    this.sqlite
      .transaction(() => {
        if (!this.owns(job, now)) return;
        const next =
          now +
          Math.max(
            retryAfterMs,
            Math.min(3600_000, 30_000 * 2 ** (job.attempts - 1)),
          );
        this.sqlite
          .query(
            "UPDATE jobs SET status=?,available_at=?,last_error=?,lease_token=NULL,lease_until=NULL,finished_at=? WHERE id=?",
          )
          .run(
            job.attempts >= 5 ? "failed" : "pending",
            next,
            error.slice(0, 2000),
            job.attempts >= 5 ? now : null,
            job.id,
          );
        this.sqlite
          .query(
            "UPDATE sources SET failures=failures+1,last_error=?,next_poll=? WHERE id=?",
          )
          .run(error.slice(0, 2000), next, job.source_id);
      })
      .immediate();
  }
  search(
    query: string,
    limit = 20,
    sourceId?: string,
    since?: number,
    offset = 0,
    filters: {
      until?: number;
      contentKind?: string;
      analysisStatus?: string;
    } = {},
  ): Item[] {
    const terms = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
    if (!terms.length) return [];
    const match = terms
      .slice(0, 30)
      .map((x) => '"' + x + '"')
      .join(" AND ");
    return this.sqlite
      .query<
        Item,
        [
          string,
          string | null,
          string | null,
          number | null,
          number | null,
          number | null,
          number | null,
          string | null,
          string | null,
          string | null,
          string | null,
          number,
          number,
        ]
      >(
        `SELECT i.*,snippet(items_fts,1,'','', ' … ',32) AS text,
      CASE WHEN EXISTS(SELECT 1 FROM analyses a WHERE a.item_id=i.id AND a.generation=(SELECT max(p.generation) FROM processing_jobs p WHERE p.item_id=i.id AND p.stage='extract')) THEN 'source_and_model_summary' ELSE 'source_content' END AS snippet_provenance,
      coalesce((SELECT CASE WHEN j.status='done' AND j.outcome='unavailable' THEN 'unavailable' WHEN j.status='done' THEN 'analysed' WHEN j.status='pending' AND j.attempts>0 THEN 'retryable' ELSE j.status END FROM processing_jobs j WHERE j.item_id=i.id AND j.stage='analyse' AND j.generation=(SELECT max(p.generation) FROM processing_jobs p WHERE p.item_id=i.id AND p.stage='extract')), 'pending') AS analysis_status
      FROM items_fts JOIN items i ON i.rowid=items_fts.rowid WHERE items_fts MATCH ?
      AND (? IS NULL OR EXISTS(SELECT 1 FROM item_sources r WHERE r.item_id=i.id AND r.source_id=?))
      AND (? IS NULL OR i.ingested_at>=?)
      AND (? IS NULL OR i.ingested_at<?)
      AND (? IS NULL OR EXISTS(SELECT 1 FROM item_sources r JOIN sources s ON s.id=r.source_id WHERE r.item_id=i.id AND s.kind=?))
      AND (? IS NULL OR coalesce((SELECT CASE WHEN j.status='done' AND j.outcome='unavailable' THEN 'unavailable' WHEN j.status='done' THEN 'analysed' WHEN j.status='pending' AND j.attempts>0 THEN 'retryable' ELSE j.status END FROM processing_jobs j WHERE j.item_id=i.id AND j.stage='analyse' AND j.generation=(SELECT max(p.generation) FROM processing_jobs p WHERE p.item_id=i.id AND p.stage='extract')), 'pending')=?)
      ORDER BY bm25(items_fts),i.id LIMIT ? OFFSET ?`,
      )
      .all(
        match,
        sourceId ?? null,
        sourceId ?? null,
        since ?? null,
        since ?? null,
        filters.until ?? null,
        filters.until ?? null,
        filters.contentKind ?? null,
        filters.contentKind ?? null,
        filters.analysisStatus ?? null,
        filters.analysisStatus ?? null,
        Math.max(1, Math.min(100, limit)),
        offset,
      );
  }
  getItem(id: string) {
    id =
      this.sqlite
        .query<{ item_id: string }, [string]>(
          "SELECT item_id FROM item_redirects WHERE old_id=?",
        )
        .get(id)?.item_id ?? id;
    const item = this.sqlite
      .query<Item, [string]>(
        "SELECT i.*,c.text FROM items i LEFT JOIN content c ON c.item_id=i.id WHERE i.id=?",
      )
      .get(id);
    if (!item) return null;
    const analysisRow = this.sqlite
      .query<
        {
          provider: string;
          model: string;
          prompt_version: string;
          input_hash: string;
          profiles: string;
          result: string;
          usage: string | null;
          cost: number | null;
          created_at: number;
        },
        [string]
      >(
        "SELECT provider,model,prompt_version,input_hash,profiles,result,usage,cost,created_at FROM analyses WHERE item_id=? AND generation=(SELECT max(generation) FROM processing_jobs WHERE item_id=analyses.item_id AND stage='extract') ORDER BY created_at DESC LIMIT 1",
      )
      .get(id);
    const analysis = analysisRow
      ? {
          ...analysisRow,
          profiles: JSON.parse(analysisRow.profiles),
          result: JSON.parse(analysisRow.result) as { summary: string },
          usage: analysisRow.usage ? JSON.parse(analysisRow.usage) : null,
        }
      : null;
    const latestScore = this.scoreHistory(id, 1)[0] ?? null;
    return {
      ...item,
      latest_score: latestScore,
      references: this.scoreReferences(id)!,
      content_versions: this.sqlite
        .query<
          {
            id: number;
            source_id: string;
            native_id: string;
            title: string;
            text: string;
            url: string | null;
            observed_at: number;
            backfilled: number;
          },
          [string]
        >(
          "SELECT id,source_id,native_id,title,text,url,observed_at,backfilled FROM content_versions WHERE item_id=? ORDER BY id",
        )
        .all(id),
      processing: this.sqlite
        .query<
          {
            stage: string;
            generation: number;
            status: string;
            outcome: string | null;
            attempts: number;
            last_error: string | null;
            available_at: number;
          },
          [string]
        >(
          "SELECT stage,generation,status,outcome,attempts,last_error,available_at FROM processing_jobs WHERE item_id=? ORDER BY created_at,stage",
        )
        .all(id),
      extraction: (() => {
        const value = this.processingResult("extract", id);
        if (!value) return null;
        try {
          return JSON.parse(value) as { text?: string; status?: string };
        } catch {
          return null;
        }
      })(),
      analysis,
      summary: analysis?.result.summary ?? null,
      analysis_status: (() => {
        const job = this.sqlite
          .query<
            { status: string; outcome: string | null; attempts: number },
            [string, string]
          >(
            "SELECT status,outcome,attempts FROM processing_jobs WHERE item_id=? AND stage='analyse' AND generation=(SELECT max(generation) FROM processing_jobs WHERE item_id=? AND stage='extract')",
          )
          .get(id, id);
        if (!job) return "pending";
        if (job.status === "done")
          return job.outcome === "unavailable" ? "unavailable" : "analysed";
        if (job.status === "pending" && job.attempts > 0) return "retryable";
        return job.status;
      })(),
      story: this.stories.forItem(id),
      content_kind: analysis
        ? "untrusted_source_and_generated_content"
        : "untrusted_source_content",
    };
  }
  getStoryGroup(id: string) {
    const group = this.stories.group(id);
    if (!group) return null;
    return {
      ...group,
      members: group.members.map((member) => ({
        ...member,
        item: this.getItem(member.item_id),
      })),
    };
  }
  status(
    options: {
      enabledStages?: readonly string[];
      discoveryLimits?: {
        maxQueriesPerDay: number;
        maxCostMicrosPerDay: number;
        maxResultsPerDay: number;
      };
      now?: number;
    } = {},
  ) {
    return {
      sources: this.sources().map((source) => ({
        ...source,
        feed_diagnostics:
          this.sqlite
            .query(
              "SELECT entry_count,truncated FROM source_state WHERE source_id=?",
            )
            .get(source.id) ?? null,
      })),
      jobs: this.sqlite
        .query("SELECT status,count(*) AS count FROM jobs GROUP BY status")
        .all(),
      inbound_indexing: this.sqlite
        .query(
          "SELECT count(*) AS total, coalesce(sum(CASE WHEN item_id IS NULL AND index_diagnostics IS NULL THEN 1 ELSE 0 END),0) AS pending, coalesce(sum(CASE WHEN item_id IS NULL AND index_diagnostics IS NOT NULL THEN 1 ELSE 0 END),0) AS failed FROM inbound_messages WHERE status='complete'",
        )
        .get(),
      processing_jobs: this.sqlite
        .query(
          "SELECT stage,status,count(*) AS count FROM processing_jobs GROUP BY stage,status ORDER BY stage,status",
        )
        .all(),
      publication_history: this.sqlite
        .query(
          "SELECT date,due_at,status,details,recorded_at FROM publication_schedule_history ORDER BY date DESC LIMIT 31",
        )
        .all(),
      digest_history_evidence_from:
        this.sqlite
          .query("SELECT evidence_from FROM digest_history_state WHERE id=1")
          .get() ?? null,
      items: this.sqlite.query("SELECT count(*) AS count FROM items").get(),
      // Manual submissions stay separate from subscription and discovery
      // counts so discovery yield is not inflated by operator intake.
      manual_submissions: this.sqlite
        .query(
          "SELECT origin,count(*) AS count FROM manual_submissions GROUP BY origin ORDER BY origin",
        )
        .all(),
      health: healthReport(this.sqlite, Date.now(), options),
      grouping: this.stories.status(),
      ai: "optional",
      analyses: this.sqlite
        .query("SELECT count(*) AS count FROM analyses")
        .get(),
      analysis_envelope_breach: !!this.sqlite
        .query(
          "SELECT 1 FROM analysis_control WHERE id=1 AND envelope_breach=1",
        )
        .get(),
      budgets: this.budgetStatus(
        options.now ?? Date.now(),
        options.discoveryLimits,
      ),
    };
  }
  /**
   * Read-only usage against configured ceilings. Discovery uses the same
   * rolling-day window as the reserver, so status and reservations agree.
   */
  private budgetStatus(
    now: number,
    limits?: {
      maxQueriesPerDay: number;
      maxCostMicrosPerDay: number;
      maxResultsPerDay: number;
    },
  ) {
    const day = Math.floor(now / 86_400_000);
    const discovery = this.sqlite
      .query<
        { queries: number; results: number; micros: number },
        [number, number]
      >(
        "SELECT count(*) AS queries,coalesce(sum(reserved_results),0) AS results,coalesce(sum(reserved_cost_micros),0) AS micros FROM discovery_pages WHERE budget_day>=? OR status='reserved' OR finished_at>=?",
      )
      .get(day, day * 86_400_000)!;
    const analysis = this.sqlite
      .query<{ tokens: number; micros: number; reservations: number }, []>(
        "SELECT coalesce(sum(tokens),0) AS tokens,coalesce(sum(micros),0) AS micros,count(*) AS reservations FROM analysis_reservations",
      )
      .get()!;
    return {
      discovery: {
        day,
        queries: discovery.queries,
        results: discovery.results,
        cost_micros: discovery.micros,
        limits: limits ?? null,
      },
      analysis: {
        tokens: analysis.tokens,
        cost_micros: analysis.micros,
        reservations: analysis.reservations,
        envelope_breach: !!this.sqlite
          .query(
            "SELECT 1 FROM analysis_control WHERE id=1 AND envelope_breach=1",
          )
          .get(),
      },
    };
  }
  backup(path: string): void {
    if (path === ":memory:") throw new Error("Backup needs a file path");
    mkdirSync(dirname(path), { recursive: true });
    this.sqlite.query("VACUUM INTO ?").run(path);
  }
}
