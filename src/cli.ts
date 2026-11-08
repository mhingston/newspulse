import { ProfileStore } from "./profiles";
import { Store } from "./db/store";
import { parseOpml, exportOpml } from "./adapters/opml";
import { RssAdapter } from "./adapters/rss";
import { Worker } from "./worker";
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
const [command, ...args] = process.argv.slice(2);
const path = process.env.DB_PATH ?? "./data/newspulse.sqlite";
function required(index: number, name: string): string {
  const arg = args[index];
  if (!arg) throw new Error(`Missing ${name}`);
  return arg;
}
async function main() {
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
  const store = new Store(path);
  try {
    switch (command) {
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
          "Usage: bun run cli <init|import-profiles FILE|export-profiles|list-profiles|add-source URL [TITLE] [POLL_SECONDS]|list-sources|update-source ID option=value...|enable-source ID|disable-source ID|remove-source ID|import-opml FILE|export-opml|poll [--force]|search QUERY|status|backup FILE|restore FILE>",
        );
    }
  } finally {
    store.close();
  }
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
