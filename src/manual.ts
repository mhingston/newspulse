import type { Store } from "./db/store";
import { canonicalItemUrl, parseRedditDiscussion, resolvedUrl } from "./domain";

/** Manual, bookmark and email submissions share one idempotent intake path. */
export type SubmissionOrigin = "manual" | "bookmark" | "email" | "search";

export interface ManualSubmissionInput {
  /** Caller-supplied idempotency key; resubmitting it returns the same item. */
  submissionId: string;
  url: string;
  origin: SubmissionOrigin;
  title?: string;
  snippet?: string;
  /** Discovery/search provenance such as the provider and run that found it. */
  discoveredVia?: Record<string, string>;
  now?: number;
}

export interface ManualSubmission {
  submissionId: string;
  itemId: string;
  url: string;
  origin: SubmissionOrigin;
  title: string;
  snippet: string;
  reddit?: { postId: string; subreddit?: string; discussionUrl: string };
  /** The submission was already recorded; no new ingest happened. */
  duplicate: boolean;
  /** Stable item status; extraction continues asynchronously. */
  status: string;
}

const origins = new Set<SubmissionOrigin>([
  "manual",
  "bookmark",
  "email",
  "search",
]);
const maxUrlChars = 8192;
const maxTitleChars = 1000;
const maxSnippetChars = 10_000;

function bounded(
  value: string,
  max: number,
  label: string,
  allowEmpty = false,
): string {
  if (
    (!allowEmpty && !value.trim()) ||
    value.length > max ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)
  )
    throw new Error(`Invalid ${label}`);
  return value;
}

/**
 * Validate a user-supplied destination without contacting it. Extraction still
 * re-validates DNS, redirects and private ranges at fetch time; this rejects
 * malformed, credential-bearing and obviously private destinations early so a
 * bad submission never becomes an item.
 */
export function validateManualUrl(value: string): string {
  bounded(value, maxUrlChars, "URL");
  let url: URL;
  try {
    url = new URL(resolvedUrl(value));
  } catch {
    throw new Error("Expected an absolute HTTP(S) URL without credentials");
  }
  const host = url.hostname.toLowerCase();
  if (
    host.startsWith("[") ||
    /^\d+\.\d+\.\d+\.\d+$/.test(host) ||
    /^(?:localhost|.*\.localhost|.*\.local|.*\.internal|.*\.home\.arpa)$/.test(
      host,
    )
  )
    throw new Error("Destination is not a public host name");
  return url.href;
}

/** Title fallback derived from the URL without inventing publisher content. */
function fallbackTitle(url: string): string {
  const parsed = new URL(url);
  const reddit = parseRedditDiscussion(url);
  if (reddit)
    return reddit.subreddit
      ? `Reddit r/${reddit.subreddit} post ${reddit.postId}`
      : `Reddit post ${reddit.postId}`;
  const segment = (() => {
    try {
      return decodeURIComponent(
        parsed.pathname.split("/").filter(Boolean).pop() ?? "",
      );
    } catch {
      return parsed.pathname.split("/").filter(Boolean).pop() ?? "";
    }
  })()
    .replace(/[-_]+/g, " ")
    .trim();
  return (segment || parsed.hostname).slice(0, maxTitleChars);
}

function redditProvenance(url: string) {
  const reddit = parseRedditDiscussion(url);
  return reddit
    ? {
        postId: reddit.postId,
        subreddit: reddit.subreddit,
        discussionUrl: reddit.canonicalUrl,
        originalUrl: reddit.originalUrl,
      }
    : undefined;
}

/**
 * Record a submission durably and return its canonical item immediately.
 * Content fetching, cleaning and analysis stay in the normal extraction
 * pipeline, so a slow or blocked page never delays the caller.
 */
export function submitUrl(
  store: Store,
  input: ManualSubmissionInput,
): ManualSubmission {
  const submissionId = bounded(input.submissionId, 128, "submission ID");
  const url = validateManualUrl(input.url);
  if (!origins.has(input.origin)) throw new Error("Invalid submission origin");
  const title = bounded(
    input.title?.trim() || fallbackTitle(url),
    maxTitleChars,
    "title",
  );
  const snippet = bounded(
    input.snippet ?? "",
    maxSnippetChars,
    "snippet",
    true,
  );
  const now = input.now ?? Date.now();
  const reddit = redditProvenance(url);
  const canonical = canonicalItemUrl(url);
  const metadata = {
    schema: 1,
    retrieval: "pending",
    limitations: [
      "Destination validated without fetching; text depends on bounded extraction.",
      "Unavailable or restricted pages retain no body and are reported as unavailable.",
    ],
    ...(reddit ? { reddit } : {}),
    ...(input.discoveredVia ? { discoveredVia: input.discoveredVia } : {}),
  };
  const outcome = store.sqlite
    .transaction(() => {
      const previous = store.sqlite
        .query<
          {
            item_id: string;
            url: string;
            origin: string;
            title: string;
            snippet: string;
          },
          [string]
        >(
          "SELECT item_id,url,origin,title,snippet FROM manual_submissions WHERE id=?",
        )
        .get(submissionId);
      // One idempotency key always resolves to the same item, even when the
      // caller retries with a different URL spelling.
      if (previous)
        return {
          submissionId,
          itemId: previous.item_id,
          url: previous.url,
          origin: previous.origin as SubmissionOrigin,
          title: previous.title,
          snippet: previous.snippet,
          ...(reddit ? { reddit } : {}),
          duplicate: true,
        };
      // A manual source keeps subscriptions and discovery metrics
      // distinguishable, while identity still follows the URL so a page
      // already known from RSS gains a reference instead of a duplicate.
      const sourceId = `manual:${input.origin}`;
      store.sqlite
        .query(
          "INSERT OR IGNORE INTO sources(id,kind,url,title,enabled) VALUES(?, 'manual', ?, ?, 0)",
        )
        .run(sourceId, sourceId, `Manual submissions (${input.origin})`);
      const itemId = store.ingestManual(
        {
          nativeId: canonical,
          url: canonical,
          sourceUrl: url,
          title,
          text: "",
        },
        sourceId,
        now,
      );
      store.sqlite
        .query(
          "INSERT INTO manual_submissions(id,item_id,url,origin,title,snippet,metadata,submitted_at) VALUES(?,?,?,?,?,?,?,?)",
        )
        .run(
          submissionId,
          itemId,
          url,
          input.origin,
          title,
          snippet,
          JSON.stringify(metadata),
          now,
        );
      return {
        submissionId,
        itemId,
        url,
        origin: input.origin,
        title,
        snippet,
        ...(reddit ? { reddit } : {}),
        duplicate: false,
      };
    })
    .immediate();
  return {
    ...outcome,
    reddit: outcome.reddit && {
      postId: outcome.reddit.postId,
      subreddit: outcome.reddit.subreddit,
      discussionUrl: outcome.reddit.discussionUrl,
    },
    status: store.getItem(outcome.itemId)?.status ?? "ingested",
  };
}

/** Provenance and truthful retrieval status for one submitted item. */
export function submissionFor(
  store: Store,
  itemId: string,
): Record<string, unknown> | null {
  const rows = store.sqlite
    .query<
      {
        id: string;
        item_id: string;
        url: string;
        origin: string;
        title: string;
        snippet: string;
        metadata: string;
        submitted_at: number;
      },
      [string]
    >(
      // The first submission established identity and provenance; later
      // submissions of the same item are references, not replacements. All of
      // them are returned so no provenance is hidden.
      "SELECT id,item_id,url,origin,title,snippet,metadata,submitted_at FROM manual_submissions WHERE item_id=? ORDER BY submitted_at,rowid",
    )
    .all(itemId);
  const row = rows[0];
  if (!row) return null;
  const item = store.getItem(row.item_id);
  const extraction = item?.extraction as {
    status?: string;
    method?: string;
    reason?: string;
    text?: string;
  } | null;
  // A terminal extraction failure has no stored result, so read the job state
  // rather than reporting it as still pending.
  const job = store.sqlite
    .query<
      { status: string; outcome: string | null; last_error: string | null },
      [string]
    >(
      "SELECT status,outcome,last_error FROM processing_jobs WHERE item_id=? AND stage='extract' ORDER BY generation DESC LIMIT 1",
    )
    .get(row.item_id);
  const retrieval = extraction
    ? {
        status: extraction.status ?? "unknown",
        method: extraction.method ?? null,
        reason: extraction.reason ?? null,
        text_chars: extraction.text?.length ?? 0,
      }
    : job?.status === "failed"
      ? {
          status: "failed",
          method: null,
          reason: job.last_error ?? "Extraction failed",
          text_chars: 0,
        }
      : { status: "pending", method: null, reason: null, text_chars: 0 };
  return {
    submission_id: row.id,
    origin: row.origin,
    url: row.url,
    submitted_at: row.submitted_at,
    title: row.title,
    snippet: row.snippet,
    metadata: JSON.parse(row.metadata) as unknown,
    // Retrieval is reported from recorded evidence, never assumed.
    retrieval,
    submissions: rows.map((entry) => ({
      submission_id: entry.id,
      origin: entry.origin,
      url: entry.url,
      submitted_at: entry.submitted_at,
      title: entry.title,
      snippet: entry.snippet,
      metadata: JSON.parse(entry.metadata) as unknown,
    })),
  };
}
