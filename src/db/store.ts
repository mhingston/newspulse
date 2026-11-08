import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalUrl,
  identity,
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
export type ProcessingStage = "extract" | "analyse" | "score";
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
  }
  close() {
    this.sqlite.close();
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
    this.sqlite
      .query(
        "INSERT INTO sources(id,url,title,poll_seconds) VALUES(?,?,?,?) ON CONFLICT(url) DO UPDATE SET enabled=CASE WHEN removed=1 THEN 1 ELSE enabled END,removed=0",
      )
      .run(crypto.randomUUID(), url, title, pollSeconds);
    return this.sqlite
      .query<Source, [string]>("SELECT * FROM sources WHERE url=?")
      .get(url)!;
  }
  sources(): Source[] {
    return this.sqlite
      .query<Source, []>(
        "SELECT * FROM sources WHERE removed=0 ORDER BY title,id",
      )
      .all();
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
              "UPDATE source_state SET etag=NULL,last_modified=NULL WHERE source_id=?",
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
  private cancelSourceJobs(id: string) {
    this.sqlite
      .query(
        "UPDATE jobs SET status='cancelled',lease_token=NULL,lease_until=NULL,finished_at=? WHERE source_id=? AND status IN ('pending','running')",
      )
      .run(Date.now(), id);
  }
  removeSource(id: string): void {
    this.sqlite
      .transaction(() => {
        if (
          !this.sqlite
            .query(
              "UPDATE sources SET removed=1,enabled=0 WHERE id=? AND removed=0",
            )
            .run(id).changes
        )
          throw new Error("Source not found");
        this.cancelSourceJobs(id);
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
          (s) => s.enabled && (force || s.next_poll <= now),
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
  claim(now = Date.now()): Job | null {
    return this.sqlite
      .transaction(() => {
        this.sqlite
          .query(
            "UPDATE jobs SET status=CASE WHEN attempts>=5 THEN 'failed' ELSE 'pending' END, lease_token=NULL, lease_until=NULL, last_error='Expired lease recovered' WHERE status='running' AND lease_until<=?",
          )
          .run(now);
        return this.sqlite
          .query<Job, [string, number, number]>(
            `UPDATE jobs SET status='running',attempts=attempts+1,lease_token=?,lease_until=?
        WHERE id=(SELECT j.id FROM jobs j JOIN sources s ON s.id=j.source_id WHERE j.status='pending' AND j.available_at<=? AND s.enabled=1 AND s.removed=0 ORDER BY j.available_at,j.created_at LIMIT 1)
        RETURNING id,source_id,attempts,lease_token`,
          )
          .get(crypto.randomUUID(), now + 60_000, now);
      })
      .immediate();
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
          "INSERT OR IGNORE INTO processing_jobs(id,stage,item_id,available_at,created_at,generation,origin_source_id,origin_url) VALUES(?,?,?,?,?,?,?,?)",
        )
        .run(
          crypto.randomUUID(),
          stage,
          itemId,
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
        this.sqlite
          .query(
            "UPDATE processing_jobs SET status=CASE WHEN attempts>=5 THEN 'failed' ELSE 'pending' END,lease_token=NULL,lease_until=NULL WHERE status='running' AND lease_until<=?",
          )
          .run(now);
        return this.sqlite
          .query<ProcessingJob, [string, number, string, number]>(
            `UPDATE processing_jobs SET status='running',attempts=attempts+1,lease_token=?,lease_until=? WHERE id=(SELECT id FROM processing_jobs WHERE stage=? AND status='pending' AND available_at<=? ORDER BY available_at,created_at LIMIT 1) RETURNING id,item_id,stage,generation,attempts,lease_token,origin_source_id,origin_url`,
          )
          .get(crypto.randomUUID(), now + 60_000, stage, now);
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
        if (next && (status !== "unavailable" || job.stage === "extract"))
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
          `UPDATE processing_jobs SET status='pending',attempts=0,available_at=?,last_error=NULL
      WHERE item_id=? AND stage='analyse' AND status='failed' AND generation=(SELECT max(generation) FROM processing_jobs WHERE item_id=? AND stage='extract')`,
        )
        .run(now, itemId, itemId).changes === 1
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
            "INSERT INTO processing_jobs(id,item_id,stage,generation,status,outcome,attempts,available_at,created_at,result) VALUES(?,?,'extract',?,'done',?,0,?,?,?)",
          )
          .run(
            crypto.randomUUID(),
            itemId,
            generation,
            previous.outcome,
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
        return true;
      })
      .immediate();
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
      .query("UPDATE content_versions SET item_id=? WHERE item_id=?")
      .run(winner, loser);
    this.sqlite
      .query("UPDATE item_sources SET parent_item_id=? WHERE parent_item_id=?")
      .run(winner, loser);
    this.sqlite
      .query("UPDATE item_sources SET item_id=? WHERE item_id=?")
      .run(winner, loser);
    this.sqlite
      .query("UPDATE item_url_aliases SET item_id=? WHERE item_id=?")
      .run(winner, loser);
    this.sqlite
      .query("UPDATE item_redirects SET item_id=? WHERE item_id=?")
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

  private canonicalOwner(url: string, priorId?: string): string | undefined {
    const alias = this.sqlite
      .query<{ item_id: string }, [string]>(
        "SELECT item_id FROM item_url_aliases WHERE canonical_url=?",
      )
      .get(url)?.item_id;
    const legacy = this.sqlite
      .query<{ id: string }, [string]>("SELECT id FROM items WHERE identity=?")
      .get(`url:${url}`)?.id;
    const owner = alias ?? legacy ?? priorId;
    if (!owner) return undefined;
    if (legacy && legacy !== owner) this.mergeItems(owner, legacy);
    if (priorId && priorId !== owner) this.mergeItems(owner, priorId);
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
    const previousRef = this.sqlite
      .query<{ item_id: string; url: string | null }, [string, string]>(
        "SELECT item_id,url FROM item_sources WHERE source_id=? AND native_id=?",
      )
      .get(sourceId, candidate.nativeId);
    const url = candidate.url ? canonicalUrl(candidate.url) : null;
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
            .run(canonicalUrl(candidate.url), prior.item_id);
        this.enqueueProcessing(
          "extract",
          prior.item_id,
          now,
          generation,
          sourceId,
          originalUrl,
        );
      } else this.enqueueProcessing("extract", prior.item_id, now);
      this.insertChildren(candidate, sourceId, now, prior.item_id);
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
      candidate.sourceUrl ?? candidate.url ?? null,
    );
    this.insertChildren(candidate, sourceId, now, item.id);
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
          number,
          number,
        ]
      >(
        `SELECT i.*,snippet(items_fts,1,'','', ' … ',32) AS text,
      CASE WHEN EXISTS(SELECT 1 FROM analyses a WHERE a.item_id=i.id AND a.generation=(SELECT max(p.generation) FROM processing_jobs p WHERE p.item_id=i.id AND p.stage='extract')) THEN 'source_and_model_summary' ELSE 'source_content' END AS snippet_provenance,
      coalesce((SELECT CASE WHEN j.status='done' AND j.outcome='unavailable' THEN 'unavailable' WHEN j.status='done' THEN 'analysed' WHEN j.status='pending' AND j.attempts>0 THEN 'retryable' ELSE j.status END FROM processing_jobs j WHERE j.item_id=i.id AND j.stage='analyse' AND j.generation=(SELECT max(p.generation) FROM processing_jobs p WHERE p.item_id=i.id AND p.stage='extract')), 'pending') AS analysis_status
      FROM items_fts JOIN items i ON i.rowid=items_fts.rowid WHERE items_fts MATCH ?
      AND (? IS NULL OR EXISTS(SELECT 1 FROM item_sources r WHERE r.item_id=i.id AND r.source_id=?))
      AND (? IS NULL OR i.ingested_at>=?) ORDER BY bm25(items_fts),i.id LIMIT ? OFFSET ?`,
      )
      .all(
        match,
        sourceId ?? null,
        sourceId ?? null,
        since ?? null,
        since ?? null,
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
    return {
      ...item,
      references: this.sqlite
        .query(
          "SELECT r.*,s.title AS source_title,s.url AS feed_url FROM item_sources r JOIN sources s ON s.id=r.source_id WHERE r.item_id=?",
        )
        .all(id),
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
      content_kind: analysis
        ? "untrusted_source_and_generated_content"
        : "untrusted_source_content",
    };
  }
  status() {
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
      processing_jobs: this.sqlite
        .query(
          "SELECT stage,status,count(*) AS count FROM processing_jobs GROUP BY stage,status ORDER BY stage,status",
        )
        .all(),
      items: this.sqlite.query("SELECT count(*) AS count FROM items").get(),
      milestone: "M2-in-progress",
      ai: "optional",
      analyses: this.sqlite
        .query("SELECT count(*) AS count FROM analyses")
        .get(),
      analysis_envelope_breach: !!this.sqlite
        .query(
          "SELECT 1 FROM analysis_control WHERE id=1 AND envelope_breach=1",
        )
        .get(),
    };
  }
  backup(path: string): void {
    if (path === ":memory:") throw new Error("Backup needs a file path");
    mkdirSync(dirname(path), { recursive: true });
    this.sqlite.query("VACUUM INTO ?").run(path);
  }
}
