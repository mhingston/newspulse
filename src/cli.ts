import { discoveryConfig } from "./discovery-config";
import { pollConfig } from "./poll-config";
import { enabledProcessingStages } from "./analysis-config";
import { runDiscovery } from "./discovery-service";
import { GdeltSearchProvider } from "./adapters/gdelt";
import { GithubSearchProvider } from "./adapters/github";
import { planGithubQueries } from "./github-discovery";
import { HackerNewsSearchProvider } from "./adapters/hackernews";
import { HackerNewsAdapter } from "./adapters/hackernews";
import { planHnQueries } from "./hn-discovery";
import { submissionFor, submitUrl } from "./manual";
import {
  confirmAddSource,
  confirmRemoveSource,
  confirmSubmitFeedback,
  confirmTriggerDiscovery,
  confirmUpdateInterest,
  previewAddSource,
  previewRemoveSource,
  previewSubmitFeedback,
  previewTriggerDiscovery,
  previewUpdateInterest,
} from "./mutations";
import {
  markRestoredDiscovery,
  assertDiscoveryRestoreElapsed,
} from "./discovery-restore-guard";
import { acquireDiscoveryLock } from "./discovery-lock";
import {
  previewDiscoveryReconciliation,
  confirmDiscoveryReconciliation,
  previewInterruptedDiscoveryRun,
  confirmInterruptedDiscoveryRun,
} from "./discovery-reconcile";
import {
  markRestoredDelivery,
  previewDeliveryRestoreAcknowledgment,
  confirmDeliveryRestoreAcknowledgment,
} from "./delivery-restore-guard";
import { DeliveryStore } from "./db/delivery-store";
import { acquireDeliveryLock } from "./delivery-lock";
import {
  confirmDeliveryReconciliation,
  previewDeliveryReconciliation,
  type Reconciliation,
} from "./delivery-reconcile";
import { previewDigest, freezeDigest, digestDefaults } from "./digest-service";
import { acquireAnalysisLock } from "./analysis-lock";
import { AnalysisBudget } from "./analysis-budget";
import { ProfileStore } from "./profiles";
import { planDiscoveryQueries } from "./discovery-planner";
import { DiscoveryPlannerStore } from "./db/discovery-planner-store";
import { Store } from "./db/store";
import { parseOpml, exportOpml } from "./adapters/opml";
import { RssAdapter } from "./adapters/rss";
import { GitHubSourceAdapter } from "./adapters/github";
import { isGithubSourceUrl, isHackerNewsSourceUrl } from "./domain";
import { SourceRouter, Worker } from "./worker";
import { Database } from "bun:sqlite";
import { constants, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  compareEvaluations,
  evaluateCorpus,
  type EvaluationReport,
  type Gate,
} from "./evaluation";
const [command, ...args] = process.argv.slice(2);
const path = process.env.DB_PATH ?? "./data/newspulse.sqlite";
function required(index: number, name: string): string {
  const arg = args[index];
  if (!arg) throw new Error(`Missing ${name}`);
  return arg;
}
async function main() {
  if (command === "evaluate-compare") {
    const baseline = JSON.parse(
      await Bun.file(required(0, "baseline report")).text(),
    ) as EvaluationReport;
    const current = JSON.parse(
      await Bun.file(required(1, "current report")).text(),
    ) as EvaluationReport;
    const gates = args[2]
      ? (JSON.parse(await Bun.file(args[2]).text()) as Gate[])
      : [];
    if (!Array.isArray(gates)) throw new Error("Gates must be an array");
    const comparison = compareEvaluations(baseline, current, gates);
    console.log(JSON.stringify(comparison, null, 2));
    if (comparison.passed === false) process.exitCode = 1;
    return;
  }
  if (command === "evaluate") {
    const input: unknown = JSON.parse(
      await Bun.file(required(0, "evaluation corpus JSON path")).text(),
    );
    const kArg = args.slice(1).find((arg) => arg !== "--timing");
    const k = kArg === undefined ? 10 : Number(kArg);
    const start = performance.now();
    const report = evaluateCorpus(input, { k });
    const elapsed = performance.now() - start;
    console.log(JSON.stringify(report, null, 2));
    if (args.includes("--timing"))
      console.error(
        JSON.stringify({
          elapsedMs: elapsed,
          scope: "offline in-process replay",
          deterministic: false,
        }),
      );
    return;
  }
  if (command === "restore") {
    const backup = required(0, "backup path");
    if (existsSync(path))
      throw new Error(
        "Restore requires a new DB_PATH; stop service and choose an unused path",
      );
    if (resolve(backup) === resolve(path))
      throw new Error("Restore path equals backup");
    const check = new Database(backup, { readonly: true });
    try {
      const result = check
        .query<{ integrity_check: string }, []>("PRAGMA integrity_check")
        .get();
      if (result?.integrity_check !== "ok")
        throw new Error("Backup integrity check failed");
      if (
        !check.query("SELECT name FROM sqlite_master WHERE name='items'").get()
      )
        throw new Error("Not a Newspulse backup");
    } finally {
      check.close();
    }
    mkdirSync(dirname(path), { recursive: true });
    const restoreLock =
      process.platform === "linux" ? acquireDeliveryLock(path) : null;
    const discoveryRestoreLock =
      process.platform === "linux" ? acquireDiscoveryLock(path) : null;
    try {
      markRestoredDelivery(path);
      markRestoredDiscovery(path);
      copyFileSync(backup, path, constants.COPYFILE_EXCL);
    } finally {
      discoveryRestoreLock?.close();
      restoreLock?.close();
    }
    console.log(`Restored to ${path}`);
    return;
  }
  const analysisLock =
    command === "analysis-reconcile" ||
    command === "analysis-acknowledge-envelope"
      ? acquireAnalysisLock(path)
      : null;
  const deliveryLock =
    command === "delivery-reconcile" ||
    command === "delivery-reconcile-preview" ||
    command === "delivery-restore-preview" ||
    command === "delivery-restore-confirm"
      ? acquireDeliveryLock(path)
      : null;
  const discoveryLock = [
    "discover",
    "discover-github",
    "discover-hn",
    "discovery-reconcile-preview",
    "discovery-reconcile",
    "discovery-run-reconcile-preview",
    "discovery-run-reconcile",
  ].includes(command ?? "")
    ? acquireDiscoveryLock(path)
    : null;
  const store = new Store(path);
  try {
    switch (command) {
      case "discovery-run-reconcile-preview":
        console.log(
          JSON.stringify(
            previewInterruptedDiscoveryRun(store.sqlite, required(0, "run ID")),
            null,
            2,
          ),
        );
        break;
      case "discovery-run-reconcile":
        confirmInterruptedDiscoveryRun(
          store.sqlite,
          required(0, "run ID"),
          Number(required(1, "preview asOf")),
          required(2, "preview hash"),
        );
        console.log(
          "Discovery run marked interrupted; reservations remain charged",
        );
        break;
      case "discovery-reconcile-preview":
        console.log(
          JSON.stringify(
            previewDiscoveryReconciliation(
              store.sqlite,
              required(0, "page ID"),
            ),
            null,
            2,
          ),
        );
        break;
      case "discovery-reconcile":
        confirmDiscoveryReconciliation(
          store.sqlite,
          required(0, "page ID"),
          Number(required(1, "preview asOf")),
          required(2, "preview hash"),
        );
        console.log(
          "Discovery page reconciled; its reservation remains charged",
        );
        break;
      case "discover":
        assertDiscoveryRestoreElapsed(path);
        {
          const query = required(0, "query");
          const planned = new DiscoveryPlannerStore(store.sqlite).matchingQuery(
            query,
          );
          console.log(
            JSON.stringify(
              await runDiscovery(
                store,
                new GdeltSearchProvider(),
                query,
                discoveryConfig(),
                Date.now,
                {
                  queryKind: "manual",
                  scheduleKey: planned?.key,
                  interestLineage: planned?.interestLineage,
                },
              ),
              null,
              2,
            ),
          );
          break;
        }
      case "discover-github":
        assertDiscoveryRestoreElapsed(path);
        {
          const query = required(0, "query");
          console.log(
            JSON.stringify(
              await runDiscovery(
                store,
                new GithubSearchProvider(process.env.GITHUB_TOKEN),
                query,
                discoveryConfig(),
                Date.now,
                { queryKind: "manual" },
              ),
              null,
              2,
            ),
          );
          break;
        }
      case "github-discovery-plan": {
        const asOf = Number(required(0, "as-of epoch milliseconds"));
        const days = Number(process.env.GITHUB_DISCOVERY_WINDOW_DAYS ?? "");
        console.log(
          JSON.stringify(
            planGithubQueries(
              new ProfileStore(store.sqlite).activeInterests(asOf),
              asOf,
              Number.isSafeInteger(days) && days >= 1 && days <= 365
                ? days
                : 90,
            ),
            null,
            2,
          ),
        );
        break;
      }
      case "discover-hn":
        assertDiscoveryRestoreElapsed(path);
        {
          const query = required(0, "query");
          console.log(
            JSON.stringify(
              await runDiscovery(
                store,
                new HackerNewsSearchProvider(),
                query,
                discoveryConfig(),
                Date.now,
                { queryKind: "manual" },
              ),
              null,
              2,
            ),
          );
          break;
        }
      case "hn-discovery-plan":
        console.log(
          JSON.stringify(
            planHnQueries(
              new ProfileStore(store.sqlite).activeInterests(
                Number(required(0, "as-of epoch milliseconds")),
              ),
            ),
            null,
            2,
          ),
        );
        break;
      case "discovery-plan":
        console.log(
          JSON.stringify(
            planDiscoveryQueries(
              new ProfileStore(store.sqlite).activeInterests(
                Number(required(0, "as-of epoch milliseconds")),
              ),
            ),
            null,
            2,
          ),
        );
        break;
      case "discovery-schedule":
        console.log(
          JSON.stringify(
            new DiscoveryPlannerStore(store.sqlite).history(),
            null,
            2,
          ),
        );
        break;
      case "discovery-feedback": {
        const useful = required(1, "useful or not-useful feedback");
        if (useful !== "useful" && useful !== "not-useful")
          throw new Error("Feedback must be useful or not-useful");
        const count = new DiscoveryPlannerStore(store.sqlite).feedbackForQuery(
          required(0, "scheduled query"),
          useful === "useful",
          Date.now(),
        );
        console.log(
          `Recorded explicit feedback for ${count} scheduled query${count === 1 ? "" : "ies"}`,
        );
        break;
      }
      case "discovery-item-feedback": {
        const useful = required(1, "useful or not-useful feedback");
        if (useful !== "useful" && useful !== "not-useful")
          throw new Error("Feedback must be useful or not-useful");
        new DiscoveryPlannerStore(store.sqlite).feedbackForLatestItemResult(
          required(0, "item ID"),
          useful === "useful",
          Date.now(),
        );
        console.log(
          "Recorded explicit feedback for the latest discovery result of that item",
        );
        break;
      }
      case "ingest-url": {
        const url = required(0, "URL");
        const originArg = args[1] ?? "manual";
        if (!["manual", "bookmark", "email", "search"].includes(originArg))
          throw new Error("Origin must be manual, bookmark, email or search");
        let submissionId = args[2];
        if (!submissionId) {
          const { createHash } = await import("node:crypto");
          submissionId = `cli-${createHash("sha256").update(url).digest("hex").slice(0, 32)}`;
        }
        console.log(
          JSON.stringify(
            submitUrl(store, {
              submissionId,
              url,
              origin: originArg as "manual" | "bookmark" | "email" | "search",
            }),
            null,
            2,
          ),
        );
        break;
      }
      case "submission": {
        const submission = submissionFor(store, required(0, "item ID"));
        if (!submission)
          throw new Error("No submission recorded for that item");
        console.log(JSON.stringify(submission, null, 2));
        break;
      }
      case "add-source-preview": {
        console.log(
          JSON.stringify(
            previewAddSource(store, {
              url: required(0, "URL"),
              title: args[1],
              poll_seconds: args[2] ? Number(args[2]) : undefined,
            }),
            null,
            2,
          ),
        );
        break;
      }
      case "add-source-confirm": {
        console.log(
          JSON.stringify(
            confirmAddSource(store, required(0, "token")),
            null,
            2,
          ),
        );
        break;
      }
      case "remove-source-preview": {
        console.log(
          JSON.stringify(
            previewRemoveSource(store, { source_id: required(0, "source ID") }),
            null,
            2,
          ),
        );
        break;
      }
      case "remove-source-confirm": {
        console.log(
          JSON.stringify(
            confirmRemoveSource(store, required(0, "token")),
            null,
            2,
          ),
        );
        break;
      }
      case "interest-preview": {
        console.log(
          JSON.stringify(
            previewUpdateInterest(
              store,
              JSON.parse(required(0, "interest JSON")),
            ),
            null,
            2,
          ),
        );
        break;
      }
      case "interest-confirm": {
        console.log(
          JSON.stringify(
            confirmUpdateInterest(store, required(0, "token")),
            null,
            2,
          ),
        );
        break;
      }
      case "feedback-preview": {
        const action = required(1, "useful or not-useful");
        if (action !== "useful" && action !== "not-useful")
          throw new Error("Feedback must be useful or not-useful");
        console.log(
          JSON.stringify(
            previewSubmitFeedback(store, {
              item_id: required(0, "item ID"),
              action: action === "useful" ? "useful" : "not_useful",
              edition_date: args[2],
            }),
            null,
            2,
          ),
        );
        break;
      }
      case "feedback-confirm": {
        console.log(
          JSON.stringify(
            confirmSubmitFeedback(store, required(0, "token")),
            null,
            2,
          ),
        );
        break;
      }
      case "discovery-trigger-preview": {
        console.log(
          JSON.stringify(
            previewTriggerDiscovery(store, { query: required(0, "query") }),
            null,
            2,
          ),
        );
        break;
      }
      case "discovery-trigger-confirm": {
        const result = await confirmTriggerDiscovery(
          store,
          required(0, "token"),
          new GdeltSearchProvider(),
          process.env,
          path,
        );
        console.log(JSON.stringify(result, null, 2));
        break;
      }
      case "discovery-runs":
        console.log(
          JSON.stringify(
            store.sqlite
              .query(
                "SELECT id,query,provider,provider_version,status,query_kind,schedule_key,interest_lineage,started_at,finished_at,last_error FROM discovery_runs ORDER BY started_at DESC LIMIT 100",
              )
              .all(),
            null,
            2,
          ),
        );
        break;
      case "discovery-pages":
        console.log(
          JSON.stringify(
            store.sqlite
              .query(
                "SELECT id,run_id,cursor,status,started_at,finished_at,reserved_results,reserved_cost_micros,actual_cost_micros,last_error FROM discovery_pages ORDER BY started_at DESC LIMIT 100",
              )
              .all(),
            null,
            2,
          ),
        );
        break;
      case "delivery-restore-preview": {
        console.log(
          JSON.stringify(previewDeliveryRestoreAcknowledgment(path), null, 2),
        );
        break;
      }
      case "delivery-restore-confirm": {
        confirmDeliveryRestoreAcknowledgment(
          path,
          Number(required(0, "preview asOf")),
          required(1, "preview hash"),
        );
        console.log("Delivery restore reconciliation acknowledged");
        break;
      }
      case "delivery-list": {
        console.log(
          JSON.stringify(new DeliveryStore(store.sqlite).list(), null, 2),
        );
        break;
      }
      case "delivery-reconcile-preview":
      case "delivery-reconcile": {
        const id = required(0, "delivery ID");
        const resolution = required(1, "accepted or not_sent");
        if (resolution !== "accepted" && resolution !== "not_sent")
          throw new Error("Resolution must be accepted or not_sent");
        const providerArg = required(2, "provider ID, or - for not_sent");
        const action: Reconciliation = {
          id,
          resolution,
          providerId: providerArg === "-" ? null : providerArg,
        };
        if (command === "delivery-reconcile-preview") {
          console.log(
            JSON.stringify(
              previewDeliveryReconciliation(store.sqlite, action),
              null,
              2,
            ),
          );
        } else {
          confirmDeliveryReconciliation(
            store.sqlite,
            action,
            Number(required(3, "preview asOf")),
            required(4, "preview hash"),
          );
          console.log("Delivery reconciled");
        }
        break;
      }
      case "digest-preview": {
        const options = digestDefaults(required(0, "edition date"));
        console.log(JSON.stringify(previewDigest(store, options), null, 2));
        break;
      }
      case "digest-freeze": {
        const date = required(0, "edition date");
        const asOf = Number(required(1, "preview asOf"));
        const hash = required(2, "preview confirmation hash");
        console.log(
          JSON.stringify(
            freezeDigest(store, digestDefaults(date, asOf), hash),
            null,
            2,
          ),
        );
        break;
      }

      case "import-profiles": {
        const input: unknown = JSON.parse(
          await Bun.file(required(0, "profile JSON path")).text(),
        );
        console.log(
          JSON.stringify(new ProfileStore(store.sqlite).import(input), null, 2),
        );
        break;
      }
      case "export-profiles":
      case "list-profiles":
        console.log(
          JSON.stringify(new ProfileStore(store.sqlite).export(), null, 2),
        );
        break;
      case "analysis-reservations":
        console.log(
          JSON.stringify(
            store.sqlite
              .query(
                "SELECT key,tokens,micros,status FROM analysis_reservations ORDER BY key",
              )
              .all(),
            null,
            2,
          ),
        );
        break;
      case "analysis-retry":
        if (!store.retryFailedAnalysis(required(0, "item ID")))
          throw new Error("No failed current analysis job found");
        console.log("Failed analysis requeued");
        break;
      case "analysis-reanalyse":
        if (!store.requestReanalysis(required(0, "item ID")))
          throw new Error("Item is not eligible for reanalysis");
        console.log("Reanalysis queued");
        break;
      case "analysis-reconcile": {
        const budget = new AnalysisBudget(store.sqlite, {
          maxTokens: 1,
          maxMicros: 1,
          maxConcurrent: 1,
        });
        if (!budget.reconcile(required(0, "reservation key")))
          throw new Error("Reserved attempt not found");
        console.log(
          "Reservation reconciled; worst-case spend remains charged to the budget",
        );
        break;
      }
      case "analysis-acknowledge-envelope": {
        const budget = new AnalysisBudget(store.sqlite, {
          maxTokens: 1,
          maxMicros: 1,
          maxConcurrent: 1,
        });
        if (!budget.acknowledgeEnvelopeBreach())
          throw new Error("No envelope breach pending review");
        console.log(
          "Envelope breach acknowledged; verify provider limits and budget configuration before restarting",
        );
        break;
      }
      case "init":
        console.log("Database migrated");
        break;
      case "add-source":
        console.log(
          JSON.stringify(
            store.addSource(
              required(0, "URL"),
              args[1],
              args[2] ? Number(args[2]) : 1800,
            ),
            null,
            2,
          ),
        );
        break;
      case "list-sources":
        console.log(JSON.stringify(store.sources(), null, 2));
        break;
      case "update-source": {
        const id = required(0, "source ID");
        const changes: {
          title?: string;
          pollSeconds?: number;
          maxEntries?: number;
          maxBytes?: number;
        } = {};
        for (const arg of args.slice(1)) {
          const pos = arg.indexOf("=");
          if (pos < 1) throw new Error("Expected option=value");
          const key = arg.slice(0, pos),
            value = arg.slice(pos + 1);
          if (key === "title") changes.title = value;
          else if (key === "poll-seconds") changes.pollSeconds = Number(value);
          else if (key === "max-entries") changes.maxEntries = Number(value);
          else if (key === "max-bytes") changes.maxBytes = Number(value);
          else throw new Error(`Unknown source option: ${key}`);
        }
        if (!Object.keys(changes).length)
          throw new Error("No source changes supplied");
        console.log(JSON.stringify(store.updateSource(id, changes), null, 2));
        break;
      }
      case "enable-source":
      case "disable-source":
        console.log(
          JSON.stringify(
            store.updateSource(required(0, "source ID"), {
              enabled: command === "enable-source",
            }),
            null,
            2,
          ),
        );
        break;
      case "remove-source":
        store.removeSource(required(0, "source ID"));
        console.log("Source removed; history retained");
        break;
      case "import-opml": {
        const feeds = parseOpml(
          await Bun.file(required(0, "OPML path")).text(),
        );
        store.sqlite
          .transaction(() => {
            for (const f of feeds) store.addSource(f.url, f.title);
          })
          .immediate();
        console.log(`Imported ${feeds.length} feeds`);
        break;
      }
      case "export-opml":
        console.log(
          exportOpml(store.sources().filter((source) => source.kind === "rss")),
        );
        break;
      case "poll": {
        const pollLimits = pollConfig();
        store.enqueueDue(Date.now(), args.includes("--force"));
        console.log(
          JSON.stringify({
            processed: await new Worker(
              store,
              new SourceRouter(
                [
                  {
                    matches: isGithubSourceUrl,
                    adapter: new GitHubSourceAdapter(
                      process.env.GITHUB_TOKEN || undefined,
                    ),
                  },
                  {
                    matches: isHackerNewsSourceUrl,
                    adapter: new HackerNewsAdapter(),
                  },
                ],
                new RssAdapter(),
              ),
              {
                concurrency: pollLimits.concurrency,
                perHost: pollLimits.perHost,
              },
            ).drain(100),
          }),
        );
        break;
      }
      case "search":
        console.log(
          JSON.stringify(store.search(required(0, "query")), null, 2),
        );
        break;
      case "status":
        console.log(
          JSON.stringify(
            store.status({ enabledStages: enabledProcessingStages() }),
            null,
            2,
          ),
        );
        break;
      case "backup":
        store.backup(required(0, "destination (must not exist)"));
        console.log("Backup created");
        break;
      default:
        throw new Error(
          "Usage: bun run cli <discover QUERY|discover-github QUERY|discover-hn QUERY|ingest-url URL [ORIGIN] [SUBMISSION_ID]|submission ITEM_ID|add-source-preview URL [TITLE] [POLL_SECONDS]|add-source-confirm TOKEN|remove-source-preview SOURCE_ID|remove-source-confirm TOKEN|interest-preview JSON|interest-confirm TOKEN|feedback-preview ITEM_ID useful|not-useful [EDITION_DATE]|feedback-confirm TOKEN|discovery-trigger-preview QUERY|discovery-trigger-confirm TOKEN|github-discovery-plan AS_OF|hn-discovery-plan AS_OF|discovery-plan AS_OF|discovery-schedule|discovery-feedback QUERY useful|not-useful|discovery-item-feedback ITEM_ID useful|not-useful|discovery-runs|discovery-pages|discovery-reconcile-preview PAGE_ID|discovery-reconcile PAGE_ID AS_OF HASH|discovery-run-reconcile-preview RUN_ID|discovery-run-reconcile RUN_ID AS_OF HASH|delivery-restore-preview|delivery-restore-confirm AS_OF HASH|delivery-list|delivery-reconcile-preview ID accepted|not_sent PROVIDER_ID|-|delivery-reconcile ID accepted|not_sent PROVIDER_ID|- AS_OF HASH|digest-preview DATE|digest-freeze DATE AS_OF HASH|evaluate CORPUS [K] [--timing]|evaluate-compare BASELINE CURRENT [GATES]|init|analysis-reservations|analysis-reconcile KEY|analysis-acknowledge-envelope|analysis-retry ITEM_ID|analysis-reanalyse ITEM_ID|import-profiles FILE|export-profiles|list-profiles|add-source URL [TITLE] [POLL_SECONDS]|list-sources|update-source ID option=value...|enable-source ID|disable-source ID|remove-source ID|import-opml FILE|export-opml|poll [--force]|search QUERY|status|backup FILE|restore FILE>",
        );
    }
  } finally {
    store.close();
    analysisLock?.close();
    deliveryLock?.close();
    discoveryLock?.close();
  }
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
