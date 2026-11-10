import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "../src/db/store";
import { DiscoveryStore } from "../src/db/discovery-store";

const limits = {
  dailyQueries: 1,
  dailyResults: 2,
  dailyCostMicros: 5,
  runQueries: 1,
  runResults: 2,
  runCostMicros: 5,
};
function run(store: DiscoveryStore, id: string) {
  store.createRun({
    id,
    query: "test",
    provider: "fake",
    providerVersion: "1",
    now: 100,
  });
}

test("reservations survive restart and competing connections, including failed requests", () => {
  const dir = mkdtempSync(join(tmpdir(), "discovery-budget-")),
    path = join(dir, "db.sqlite");
  let a: Store | undefined, b: Store | undefined;
  try {
    a = new Store(path);
    b = new Store(path);
    const one = new DiscoveryStore(a.sqlite),
      two = new DiscoveryStore(b.sqlite);
    run(one, "one");
    run(two, "two");
    expect(
      one.reservePage({
        id: "p1",
        runId: "one",
        now: 100,
        reservedResults: 2,
        reservedCostMicros: 5,
        limits,
      }),
    ).toBe(2);
    expect(
      two.reservePage({
        id: "p2",
        runId: "two",
        now: 100,
        reservedResults: 1,
        reservedCostMicros: 0,
        limits,
      }),
    ).toBe(0);
    expect(one.failPage("p1", 101, "timeout")).toBe(true);
    expect(one.failPage("p1", 102, "timeout")).toBe(false);
    a.close();
    a = undefined;
    b.close();
    b = undefined;
    a = new Store(path);
    expect(
      new DiscoveryStore(a.sqlite).reservePage({
        id: "p2",
        runId: "two",
        now: 103,
        reservedResults: 1,
        reservedCostMicros: 0,
        limits,
      }),
    ).toBe(0);
    expect(
      new DiscoveryStore(a.sqlite).reservePage({
        id: "p2",
        runId: "two",
        now: 86400100,
        reservedResults: 1,
        reservedCostMicros: 0,
        limits,
      }),
    ).toBe(1);
  } finally {
    a?.close();
    b?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("completion is atomic, single-use and classifies against snapshotted source IDs", () => {
  const store = new Store(":memory:"),
    db = store.sqlite,
    discovery = new DiscoveryStore(db);
  try {
    db.exec(
      "INSERT INTO sources(id,url,title) VALUES('sub','https://example.org/feed','sub'); INSERT INTO items(id,identity,title,ingested_at) VALUES('a','a','a',1),('b','b','b',1); INSERT INTO item_sources(item_id,source_id,native_id) VALUES('a','sub','a')",
    );
    discovery.createRun({
      id: "run",
      query: "test",
      provider: "fake",
      providerVersion: "1",
      now: 10,
    });
    // A later feed poll cannot be retroactively classified as subscribed at run start.
    db.exec(
      "INSERT INTO item_sources(item_id,source_id,native_id) VALUES('b','sub','b')",
    );
    discovery.reservePage({
      id: "page",
      runId: "run",
      now: 11,
      reservedResults: 2,
      reservedCostMicros: 5,
      limits,
    });
    const results = [
      { url: "https://example.org/a", title: "A" },
      { url: "https://outside.example/b", title: "B", observedAt: 9 },
    ];
    expect(() =>
      discovery.completePage({ id: "page", now: 12, results }, () => [
        "a",
        "missing",
      ]),
    ).toThrow();
    expect(
      db.query("SELECT count(*) AS n FROM discovery_results").get(),
    ).toEqual({ n: 0 });
    expect(
      discovery.completePage({ id: "page", now: 12, results }, () => [
        "a",
        "b",
      ]),
    ).toBe(true);
    expect(
      discovery.completePage({ id: "page", now: 13, results }, () => {
        throw new Error("must not run");
      }),
    ).toBe(false);
    expect(
      db
        .query(
          "SELECT item_id,origin,observed_at FROM discovery_results ORDER BY item_id",
        )
        .all(),
    ).toEqual([
      { item_id: "a", origin: "subscribed", observed_at: null },
      { item_id: "b", origin: "discovered", observed_at: 9 },
    ]);
    expect(
      db.query("SELECT actual_cost_micros FROM discovery_pages").get(),
    ).toEqual({ actual_cost_micros: null });
  } finally {
    store.close();
  }
});

test("GDELT reservations enforce a shared pacing interval across connections", () => {
  const dir = mkdtempSync(join(tmpdir(), "discovery-pace-"));
  const path = join(dir, "db.sqlite");
  const a = new Store(path),
    b = new Store(path);
  try {
    const one = new DiscoveryStore(a.sqlite),
      two = new DiscoveryStore(b.sqlite);
    for (const [repo, id] of [
      [one, "a"],
      [two, "b"],
    ] as const)
      repo.createRun({
        id,
        query: "test",
        provider: "gdelt",
        providerVersion: "1",
        now: 10000,
      });
    const unrestricted = {
      ...limits,
      dailyQueries: 10,
      dailyResults: 10,
      dailyCostMicros: 100,
    };
    expect(
      one.reservePage({
        id: "a",
        runId: "a",
        now: 10000,
        reservedResults: 1,
        reservedCostMicros: 0,
        limits: unrestricted,
      }),
    ).toBe(1);
    expect(
      two.reservePage({
        id: "b",
        runId: "b",
        now: 14999,
        reservedResults: 1,
        reservedCostMicros: 0,
        limits: unrestricted,
      }),
    ).toBe(0);
    // A paused request holds the slot even long after the initial reservation.
    expect(
      two.reservePage({
        id: "b",
        runId: "b",
        now: 90000,
        reservedResults: 1,
        reservedCostMicros: 0,
        limits: unrestricted,
      }),
    ).toBe(0);
    expect(one.failPage("a", 90000, "timeout")).toBe(true);
    expect(
      two.reservePage({
        id: "b",
        runId: "b",
        now: 94999,
        reservedResults: 1,
        reservedCostMicros: 0,
        limits: unrestricted,
      }),
    ).toBe(0);
    expect(
      two.reservePage({
        id: "b",
        runId: "b",
        now: 95000,
        reservedResults: 1,
        reservedCostMicros: 0,
        limits: unrestricted,
      }),
    ).toBe(1);
  } finally {
    a.close();
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reservations spanning UTC midnight consume both days and clock rollback cannot refund them", () => {
  const store = new Store(":memory:");
  try {
    const repo = new DiscoveryStore(store.sqlite);
    run(repo, "before");
    run(repo, "after");
    expect(
      repo.reservePage({
        id: "p1",
        runId: "before",
        now: 86399999,
        reservedResults: 2,
        reservedCostMicros: 5,
        limits,
      }),
    ).toBe(2);
    expect(
      repo.reservePage({
        id: "p2",
        runId: "after",
        now: 86400000,
        reservedResults: 1,
        reservedCostMicros: 0,
        limits,
      }),
    ).toBe(0);
    expect(repo.failPage("p1", 86400001, "timeout")).toBe(true);
    expect(
      repo.reservePage({
        id: "p2",
        runId: "after",
        now: 86400002,
        reservedResults: 1,
        reservedCostMicros: 0,
        limits,
      }),
    ).toBe(0);
    expect(
      repo.reservePage({
        id: "p2",
        runId: "after",
        now: 1,
        reservedResults: 1,
        reservedCostMicros: 0,
        limits,
      }),
    ).toBe(0);
    expect(
      repo.reservePage({
        id: "p2",
        runId: "after",
        now: 172800000,
        reservedResults: 1,
        reservedCostMicros: 0,
        limits,
      }),
    ).toBe(1);
  } finally {
    store.close();
  }
});

test("populated prior database migrates and discovery reservations survive backup", () => {
  const dir = mkdtempSync(join(tmpdir(), "discovery-migration-")),
    prior = join(dir, "prior"),
    path = join(dir, "db.sqlite"),
    backup = join(dir, "backup.sqlite");
  mkdirSync(join(prior, "meta"), { recursive: true });
  const root = fileURLToPath(new URL("../drizzle/", import.meta.url));
  for (const name of readdirSync(root))
    if (name.endsWith(".sql"))
      copyFileSync(join(root, name), join(prior, name));
  const journal = JSON.parse(
    readFileSync(join(root, "meta/_journal.json"), "utf8"),
  );
  journal.entries = journal.entries.filter(
    (entry: { idx: number }) => entry.idx < 39,
  );
  writeFileSync(join(prior, "meta/_journal.json"), JSON.stringify(journal));
  const old = new Database(path);
  migrate(drizzle(old), { migrationsFolder: prior });
  old.exec(
    "INSERT INTO items(id,identity,title,ingested_at) VALUES('prior','prior','Prior',1); INSERT INTO content(item_id,text) VALUES('prior','persistent searchable history')",
  );
  old.close();
  let store: Store | undefined, restored: Store | undefined;
  try {
    store = new Store(path);
    expect(store.search("searchable")[0]?.id).toBe("prior");
    const discovery = new DiscoveryStore(store.sqlite);
    run(discovery, "run");
    discovery.reservePage({
      id: "page",
      runId: "run",
      now: 100,
      reservedResults: 2,
      reservedCostMicros: 5,
      limits,
    });
    store.backup(backup);
    store.close();
    store = undefined;
    restored = new Store(backup);
    expect(restored.search("searchable")[0]?.id).toBe("prior");
    expect(restored.sqlite.query("PRAGMA integrity_check").get()).toEqual({
      integrity_check: "ok",
    });
    expect(restored.sqlite.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(
      restored.sqlite
        .query("SELECT status,reserved_cost_micros FROM discovery_pages")
        .get(),
    ).toEqual({ status: "reserved", reserved_cost_micros: 5 });
  } finally {
    store?.close();
    restored?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
