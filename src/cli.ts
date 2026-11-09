import { previewDigest, freezeDigest, digestDefaults } from "./digest-service";
import { acquireAnalysisLock } from "./analysis-lock";
import { AnalysisBudget } from "./analysis-budget";
import { ProfileStore } from "./profiles";
import { Store } from "./db/store";
import { parseOpml, exportOpml } from "./adapters/opml";
import { RssAdapter } from "./adapters/rss";
import { Worker } from "./worker";
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
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
    copyFileSync(backup, path);
    console.log(`Restored to ${path}`);
    return;
  }
  const analysisLock =
    command === "analysis-reconcile" ||
    command === "analysis-acknowledge-envelope"
      ? acquireAnalysisLock(path)
      : null;
  const store = new Store(path);
  try {
    switch (command) {
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
        console.log(exportOpml(store.sources()));
        break;
      case "poll":
        store.enqueueDue(Date.now(), args.includes("--force"));
        console.log(
          JSON.stringify({
            processed: await new Worker(store, new RssAdapter()).drain(100),
          }),
        );
        break;
      case "search":
        console.log(
          JSON.stringify(store.search(required(0, "query")), null, 2),
        );
        break;
      case "status":
        console.log(JSON.stringify(store.status(), null, 2));
        break;
      case "backup":
        store.backup(required(0, "destination (must not exist)"));
        console.log("Backup created");
        break;
      default:
        throw new Error(
          "Usage: bun run cli <digest-preview DATE|digest-freeze DATE AS_OF HASH|evaluate CORPUS [K] [--timing]|evaluate-compare BASELINE CURRENT [GATES]|init|analysis-reservations|analysis-reconcile KEY|analysis-acknowledge-envelope|analysis-retry ITEM_ID|analysis-reanalyse ITEM_ID|import-profiles FILE|export-profiles|list-profiles|add-source URL [TITLE] [POLL_SECONDS]|list-sources|update-source ID option=value...|enable-source ID|disable-source ID|remove-source ID|import-opml FILE|export-opml|poll [--force]|search QUERY|status|backup FILE|restore FILE>",
        );
    }
  } finally {
    store.close();
    analysisLock?.close();
  }
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
