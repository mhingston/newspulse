import type { Store } from "./db/store";
import { ProfileStore, interestSchema } from "./profiles";
import { DiscoveryPlannerStore } from "./db/discovery-planner-store";
import { consumeConfirmation, prepareMutation } from "./confirmations";
import { recordFeedback, type FeedbackAction } from "./feedback";
import { submitUrl, type SubmissionOrigin } from "./manual";
import { runDiscovery } from "./discovery-service";
import type { SearchProvider } from "./search-provider";
import { resolvedUrl } from "./domain";
import { discoveryConfig } from "./discovery-config";
import { withDiscoveryDispatch } from "./discovery-dispatch";

/**
 * Application services shared by MCP and CLI. Both transports call these; no
 * transport re-implements source, profile, feedback or discovery rules.
 * Consequential changes go through a preview → payload-bound confirmation.
 */
export const MUTATION_ACTIONS = {
  add_source: "add_source",
  remove_source: "remove_source",
  update_interest: "update_interest",
  submit_feedback: "submit_feedback",
  ingest_url: "ingest_url",
  trigger_discovery: "trigger_discovery",
} as const;

export class MutationError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function sourcePreview(store: Store, id: string) {
  const source = store.source(id);
  if (!source) return { source_id: id, exists: false };
  return {
    source_id: source.id,
    exists: true,
    removed: source.removed === 1,
    kind: source.kind,
    url: source.url,
    title: source.title,
    poll_seconds: source.poll_seconds,
    enabled: source.enabled === 1,
    items: store.sqlite
      .query<{ n: number }, [string]>(
        "SELECT count(*) AS n FROM item_sources WHERE source_id=?",
      )
      .get(id)!.n,
  };
}

/** Preview adding or restoring a subscription; apply creates/reactivates it. */
export function previewAddSource(
  store: Store,
  input: { url?: string; title?: string; poll_seconds?: number },
) {
  if (!input.url) throw new MutationError("missing_url");
  const url = new URL(resolvedUrl(input.url)).href;
  const title = (input.title ?? url).trim();
  const pollSeconds = input.poll_seconds ?? 1800;
  if (!title || title.length > 1000) throw new MutationError("invalid_title");
  if (
    !Number.isSafeInteger(pollSeconds) ||
    pollSeconds < 60 ||
    pollSeconds > 31536000
  )
    throw new MutationError("invalid_poll_seconds");
  const existing = store.sqlite
    .query<{ id: string; removed: number }, [string]>(
      "SELECT id,removed FROM sources WHERE url=?",
    )
    .get(url);
  const payload = { url, title, poll_seconds: pollSeconds };
  const prepared = prepareMutation(store.sqlite, {
    action: MUTATION_ACTIONS.add_source,
    payload,
    preview: {
      action: MUTATION_ACTIONS.add_source,
      effect: existing
        ? existing.removed
          ? "restore_removed_source"
          : "already_subscribed"
        : "create_source",
      ...payload,
    },
    apply: () => {
      // Rejects GitHub repository URLs that are neither releases, events nor
      // feeds before anything is stored.
      const source = store.addSource(url, title, pollSeconds);
      return { source_id: source.id, url: source.url, title: source.title };
    },
  });
  return prepared.preview;
}

export function confirmAddSource(store: Store, token: string) {
  // Rebuilding the payload from the stored preview keeps the hash binding
  // exact: the confirmed parameters are the ones the user saw.
  const row = store.sqlite
    .query<{ preview: string }, [string]>(
      "SELECT preview FROM mutation_confirmations WHERE id=?",
    )
    .get(token);
  if (!row) throw new MutationError("not_found");
  const preview = JSON.parse(row.preview) as {
    url: string;
    title: string;
    poll_seconds: number;
  };
  return consumeConfirmation(store.sqlite, {
    action: MUTATION_ACTIONS.add_source,
    token,
    payload: {
      url: preview.url,
      title: preview.title,
      poll_seconds: preview.poll_seconds,
    },
    apply: () => {
      const source = store.addSource(
        preview.url,
        preview.title,
        preview.poll_seconds,
      );
      return { source_id: source.id, url: source.url, title: source.title };
    },
  });
}

/**
 * Removal stops future polling and cancels queued polls while keeping the
 * source row, its items, references and history. A poll that is already
 * running cannot commit, because its job is cancelled and its lease fenced.
 */
export function previewRemoveSource(
  store: Store,
  input: { source_id?: string },
) {
  const sourceId = input.source_id;
  if (!sourceId) throw new MutationError("missing_source_id");
  const current = sourcePreview(store, sourceId);
  // An already-removed source is not a valid removal target.
  if (!current.exists || current.removed)
    throw new MutationError("source_not_found");
  const payload = { source_id: sourceId };
  const prepared = prepareMutation(store.sqlite, {
    action: MUTATION_ACTIONS.remove_source,
    payload,
    preview: {
      action: MUTATION_ACTIONS.remove_source,
      effect: "disable_future_polling_keep_history",
      source: current,
    },
    apply: () => {
      const cancelled_polls = store.removeSource(sourceId);
      return {
        source_id: sourceId,
        removed: true,
        history_retained: true,
        cancelled_polls,
      };
    },
  });
  return prepared.preview;
}

export function confirmRemoveSource(store: Store, token: string) {
  const preview = confirmationPreview(
    store,
    token,
    MUTATION_ACTIONS.remove_source,
  );
  const source = preview.source as { source_id: string };
  return consumeConfirmation(store.sqlite, {
    action: MUTATION_ACTIONS.remove_source,
    token,
    payload: { source_id: source.source_id },
    apply: () => {
      const cancelled_polls = store.removeSource(source.source_id);
      return {
        source_id: source.source_id,
        removed: true,
        history_retained: true,
        cancelled_polls,
      };
    },
  });
}

function confirmationPreview(store: Store, token: string, action: string) {
  const row = store.sqlite
    .query<{ preview: string; action: string }, [string]>(
      "SELECT preview,action FROM mutation_confirmations WHERE id=?",
    )
    .get(token);
  if (!row || row.action !== action) throw new MutationError("not_found");
  return JSON.parse(row.preview) as Record<string, unknown>;
}

/**
 * A new interest profile version. Versions stay consecutive and immutable, so
 * updates append a version and never rewrite history.
 */
export function previewUpdateInterest(store: Store, input: unknown) {
  const profiles = new ProfileStore(store.sqlite);
  const latest = store.sqlite
    .query<{ version: number }, [string]>(
      "SELECT max(version) AS version FROM profiles WHERE kind='interest' AND id=?",
    )
    .get((input as { id?: string })?.id ?? "")?.version;
  const candidate = {
    ...(input as Record<string, unknown>),
    kind: "interest" as const,
    version: (latest ?? 0) + 1,
  };
  const parsed = interestSchema.safeParse(candidate);
  if (!parsed.success)
    throw new MutationError(
      `invalid_interest: ${parsed.error.issues[0]?.message ?? "invalid"}`,
    );
  const payload = parsed.data;
  const prepared = prepareMutation(store.sqlite, {
    action: MUTATION_ACTIONS.update_interest,
    payload,
    preview: {
      action: MUTATION_ACTIONS.update_interest,
      effect: latest ? "append_version" : "create_interest",
      previous_version: latest ?? null,
      interest: payload,
      note: "Scores are invalidated and re-derived; frozen editions are unchanged.",
    },
    apply: () => {
      const saved = profiles.import([payload]);
      return { interest: saved[0], version: payload.version };
    },
  });
  return prepared.preview;
}

export function confirmUpdateInterest(store: Store, token: string) {
  const preview = confirmationPreview(
    store,
    token,
    MUTATION_ACTIONS.update_interest,
  );
  const payload = preview.interest;
  return consumeConfirmation(store.sqlite, {
    action: MUTATION_ACTIONS.update_interest,
    token,
    payload,
    apply: () => {
      const saved = new ProfileStore(store.sqlite).import([payload]);
      return { interest: saved[0] };
    },
  });
}

/**
 * Explicit item feedback with optional delivery context. Feedback changes
 * later scoring of the item; it never touches a frozen edition.
 */
export function previewSubmitFeedback(
  store: Store,
  input: {
    item_id?: string;
    action?: FeedbackAction;
    edition_date?: string;
  },
) {
  const itemId = input.item_id;
  const action = input.action;
  if (!itemId) throw new MutationError("missing_item_id");
  if (action !== "useful" && action !== "not_useful")
    throw new MutationError("invalid_action");
  const item = store.getItem(itemId);
  if (!item) throw new MutationError("item_not_found");
  let digestId: string | null = null;
  if (input.edition_date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.edition_date))
      throw new MutationError("invalid_edition_date");
    const digest = store.sqlite
      .query<{ id: string }, [string, string]>(
        "SELECT d.id FROM digests d JOIN digest_items i ON i.digest_id=d.id WHERE d.edition_date=? AND i.item_id=?",
      )
      .get(input.edition_date, itemId);
    if (!digest) throw new MutationError("item_not_in_edition");
    digestId = digest.id;
  }
  const payload = {
    item_id: itemId,
    action,
    edition_date: input.edition_date ?? null,
  };
  const prepared = prepareMutation(store.sqlite, {
    action: MUTATION_ACTIONS.submit_feedback,
    payload,
    preview: {
      action: MUTATION_ACTIONS.submit_feedback,
      effect: "record_explicit_feedback",
      item_id: payload.item_id,
      feedback_action: payload.action,
      edition_date: payload.edition_date,
      item_title: item.title,
      note: "Only explicit feedback is recorded; frozen editions are immutable.",
    },
    apply: () =>
      recordFeedback(store.sqlite, {
        itemId,
        action,
        source: "mcp",
        editionDate: input.edition_date ?? null,
        digestId,
      }),
  });
  return prepared.preview;
}

export function confirmSubmitFeedback(store: Store, token: string) {
  const preview = confirmationPreview(
    store,
    token,
    MUTATION_ACTIONS.submit_feedback,
  );
  const payload = {
    item_id: preview.item_id as string,
    action: preview.feedback_action as FeedbackAction,
    edition_date: (preview.edition_date as string | null) ?? null,
  };
  return consumeConfirmation(store.sqlite, {
    action: MUTATION_ACTIONS.submit_feedback,
    token,
    payload,
    apply: () => {
      let digestId: string | null = null;
      if (payload.edition_date)
        digestId =
          store.sqlite
            .query<{ id: string }, [string, string]>(
              "SELECT d.id FROM digests d JOIN digest_items i ON i.digest_id=d.id WHERE d.edition_date=? AND i.item_id=?",
            )
            .get(payload.edition_date, payload.item_id)?.id ?? null;
      return recordFeedback(store.sqlite, {
        itemId: payload.item_id,
        action: payload.action,
        source: "mcp",
        editionDate: payload.edition_date,
        digestId,
      });
    },
  });
}

/** Preview an idempotent manual submission; apply ingests and queues work. */
export function previewIngestUrl(
  store: Store,
  input: {
    submission_id?: string;
    url?: string;
    origin?: SubmissionOrigin;
  },
) {
  if (!input.submission_id) throw new MutationError("missing_submission_id");
  if (!input.url) throw new MutationError("missing_url");
  if (!input.origin) throw new MutationError("missing_origin");
  const payload = {
    submission_id: input.submission_id,
    url: new URL(resolvedUrl(input.url)).href,
    origin: input.origin,
  };
  const prepared = prepareMutation(store.sqlite, {
    action: MUTATION_ACTIONS.ingest_url,
    payload,
    preview: {
      action: MUTATION_ACTIONS.ingest_url,
      effect: "ingest_and_queue_extraction",
      ...payload,
      note: "No network request occurs before confirmation.",
    },
    apply: () =>
      submitUrl(store, {
        submissionId: payload.submission_id,
        url: payload.url,
        origin: payload.origin,
      }),
  });
  return prepared.preview;
}

export function confirmIngestUrl(store: Store, token: string) {
  const preview = confirmationPreview(
    store,
    token,
    MUTATION_ACTIONS.ingest_url,
  );
  const payload = {
    submission_id: preview.submission_id as string,
    url: preview.url as string,
    origin: preview.origin as SubmissionOrigin,
  };
  return consumeConfirmation(store.sqlite, {
    action: MUTATION_ACTIONS.ingest_url,
    token,
    payload,
    apply: () =>
      submitUrl(store, {
        submissionId: payload.submission_id,
        url: payload.url,
        origin: payload.origin,
      }),
  });
}

/** Shared provider factory keeps the default provider out of the CLI/MCP. */
export type DiscoveryProviderFactory = () => SearchProvider;

/**
 * Preview one bounded discovery run. Budgets are not read at preview time:
 * the run re-checks the persisted daily budget, reservations and 5s pacing
 * when it executes, so repeated or concurrent triggers stay within limits.
 */
export function previewTriggerDiscovery(
  store: Store,
  input: { query?: string },
  env: Record<string, string | undefined> = process.env,
) {
  const query = input.query?.trim() ?? "";
  if (!query || query.length > 500) throw new MutationError("invalid_query");
  const limits = discoveryConfig(env);
  const prepared = prepareMutation(store.sqlite, {
    action: MUTATION_ACTIONS.trigger_discovery,
    payload: { query },
    preview: {
      action: MUTATION_ACTIONS.trigger_discovery,
      effect: "run_one_budgeted_query",
      query,
      max_results: limits.maxResultsPerRun,
      reserved_cost_micros: limits.reservedCostMicrosPerQuery,
      note: "Persisted daily budgets, reservations and provider pacing still apply.",
    },
    apply: () => ({ query }),
  });
  return prepared.preview;
}

/**
 * Execute the confirmed run. Budget checks happen inside `runDiscovery` using
 * the same persisted ledger as scheduled discovery, so two concurrent
 * confirmations cannot both spend a slot. The run also holds the exclusive
 * discovery lock and re-checks the restore guard through the shared dispatch
 * boundary, so an MCP trigger cannot race reconciliation or spend after a
 * restore. The guard runs before the approval is consumed, so a blocked run
 * leaves the token usable once discovery is permitted again.
 */
export async function confirmTriggerDiscovery(
  store: Store,
  token: string,
  provider: SearchProvider,
  env: Record<string, string | undefined> = process.env,
  dbPath?: string,
) {
  const limits = discoveryConfig(env);
  return withDiscoveryDispatch(dbPath, () => {
    const preview = confirmationPreview(
      store,
      token,
      MUTATION_ACTIONS.trigger_discovery,
    );
    // Consume the approval in its own short transaction; network work never
    // runs inside one.
    const { query } = consumeConfirmation(store.sqlite, {
      action: MUTATION_ACTIONS.trigger_discovery,
      token,
      payload: { query: preview.query },
      apply: () => ({ query: preview.query as string }),
    });
    return runDiscovery(store, provider, query, limits);
  });
}
