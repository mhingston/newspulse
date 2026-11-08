import { expect, test } from "bun:test";
import { Store } from "../src/db/store";
import { ProfileStore, type Interest, type Profile } from "../src/profiles";

const interest: Interest = {
  kind: "interest",
  id: "robotics",
  version: 1,
  description: "Robotics",
  entities: ["robots"],
  keywords: ["automation"],
  priority: 3,
  positive: ["research"],
  negative: ["advertising"],
  queries: ["robot research"],
  lifetime: "temporary",
  expiresAt: 2000,
  feedbackRefs: [],
};
const editorial: Profile = {
  kind: "editorial",
  id: "papers",
  version: 1,
  description: "Papers",
  contentTypes: ["paper"],
  criteria: [{ dimension: "evidence", weight: 1 }],
  presentation: ["methods"],
};
test("versioned profiles round trip, retain history and filter expired interests", () => {
  const db = new Store(":memory:");
  const profiles = new ProfileStore(db.sqlite);
  expect(profiles.import([interest, editorial])).toHaveLength(2);
  expect(profiles.export()).toEqual([editorial, interest]);
  const updated = {
    ...interest,
    version: 2,
    description: "New interest",
    expiresAt: 3000,
  };
  profiles.import([updated]);
  expect(profiles.get("interest", "robotics", 1)).toEqual(interest);
  expect(profiles.get("interest", "robotics", 2)).toEqual(updated);
  expect(profiles.activeInterests(3000)).toEqual([]);
  expect(profiles.activeInterests(2999)).toEqual([updated]);
  db.close();
});
test("rejects malformed profiles and conflicting historical versions atomically", () => {
  const db = new Store(":memory:");
  const profiles = new ProfileStore(db.sqlite);
  profiles.import([interest]);
  expect(() =>
    profiles.import([{ ...interest, priority: 0, version: 2 }]),
  ).toThrow();
  expect(() =>
    profiles.import([{ ...interest, expiresAt: -1, version: 2 }]),
  ).toThrow();
  expect(() =>
    profiles.import([{ ...interest, version: 1, description: "changed" }]),
  ).toThrow();
  expect(() => profiles.import([{ ...editorial, secret: "no" }])).toThrow();
  expect(profiles.export()).toEqual([interest]);
  db.close();
});

test("exported version history imports into a fresh database", () => {
  const db = new Store(":memory:");
  const other = new Store(":memory:");
  try {
    const source = new ProfileStore(db.sqlite);
    source.import([interest, editorial]);
    source.import([{ ...interest, version: 2, description: "Updated" }]);
    const copy = new ProfileStore(other.sqlite);
    copy.import(JSON.parse(JSON.stringify(source.export())));
    expect(copy.export()).toEqual(source.export());
    expect(copy.get("interest", "robotics", 1)).toEqual(interest);
  } finally {
    db.close();
    other.close();
  }
});

test("CLI configures and exports profiles without secrets", async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "profiles-cli-"));
  try {
    const file = join(dir, "profiles.json");
    writeFileSync(file, JSON.stringify([interest, editorial]));
    const env = { ...process.env, DB_PATH: join(dir, "test.sqlite") };
    const run = (args: string[]) =>
      Bun.spawnSync({
        cmd: [process.execPath, "src/cli.ts", ...args],
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
    const imported = run(["import-profiles", file]);
    expect(imported.exitCode).toBe(0);
    const exported = run(["export-profiles"]);
    expect(exported.exitCode).toBe(0);
    expect(JSON.parse(exported.stdout.toString())).toEqual([
      editorial,
      interest,
    ]);
    expect(exported.stdout.toString()).not.toContain("MCP_TOKEN");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("conflict rolls back earlier valid versions in the same import", () => {
  const db = new Store(":memory:");
  try {
    const profiles = new ProfileStore(db.sqlite);
    profiles.import([interest]);
    expect(() =>
      profiles.import([
        { ...editorial },
        { ...interest, description: "conflict" },
      ]),
    ).toThrow();
    expect(profiles.get("editorial", "papers", 1)).toBeNull();
  } finally {
    db.close();
  }
});

test("M1 data and a pre-upgrade backup survive profile migrations", async () => {
  const { Database } = await import("bun:sqlite");
  const { drizzle } = await import("drizzle-orm/bun-sqlite");
  const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const dir = mkdtempSync(join(tmpdir(), "profiles-upgrade-"));
  const path = join(dir, "old.sqlite"),
    backup = join(dir, "backup.sqlite");
  const old = new Database(path);
  migrate(drizzle(old), {
    migrationsFolder: fileURLToPath(
      new URL("./fixtures/m1-migrations", import.meta.url),
    ),
  });
  old.exec(
    "INSERT INTO sources(id,url,title) VALUES('s','https://example.com','source'); INSERT INTO items(id,identity,title,ingested_at) VALUES('i','key','title',1); INSERT INTO content(item_id,text) VALUES('i','robotics finding'); INSERT INTO item_sources(item_id,source_id,native_id) VALUES('i','s','n');",
  );
  old.query("VACUUM INTO ?").run(backup);
  old.close();
  let migrated: Store | undefined, restored: Store | undefined;
  try {
    migrated = new Store(path);
    new ProfileStore(migrated.sqlite).import([interest]);
    expect(migrated.search("robotics")[0]?.id).toBe("i");
    expect(migrated.getItem("i")?.references).toHaveLength(1);
    restored = new Store(backup);
    expect(restored.search("robotics")[0]?.id).toBe("i");
    expect(new ProfileStore(restored.sqlite).export()).toEqual([]);
  } finally {
    migrated?.close();
    restored?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("optional editorial defaults cover each content type and activate no interests", async () => {
  const db = new Store(":memory:");
  try {
    const profiles = new ProfileStore(db.sqlite);
    profiles.import(await Bun.file("examples/editorial-profiles.json").json());
    expect(profiles.export()).toHaveLength(6);
    expect(profiles.activeInterests()).toEqual([]);
  } finally {
    db.close();
  }
});

test("export can be restored after more than 1000 historical versions", () => {
  const db = new Store(":memory:");
  const restored = new Store(":memory:");
  try {
    const profiles = new ProfileStore(db.sqlite);
    for (let version = 1; version <= 1001; version++)
      profiles.import([{ ...interest, version }]);
    const backup = profiles.export();
    const copy = new ProfileStore(restored.sqlite);
    copy.import(backup);
    expect(copy.export()).toEqual(backup);
  } finally {
    db.close();
    restored.close();
  }
});
