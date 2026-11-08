import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "../src/db/store";

test("populated M1 migration retains poll lease, validators, provenance and search; backup remains restorable", () => {
  const dir = mkdtempSync(join(tmpdir(), "newspulse-m1-"));
  const path = join(dir, "old.sqlite");
  const backup = join(dir, "backup.sqlite");
  const db = new Database(path);
  migrate(drizzle(db), {
    migrationsFolder: fileURLToPath(
      new URL("./fixtures/m1-migrations", import.meta.url),
    ),
  });
  db.exec(`INSERT INTO sources(id,url,title) VALUES('s','https://example.com/feed','Feed');
    INSERT INTO source_state(source_id,etag,last_modified,last_checked) VALUES('s','v1','yesterday',123);
    INSERT INTO items(id,identity,title,ingested_at) VALUES('i','source:s:original','Original',100);
    INSERT INTO content(item_id,text) VALUES('i','migration searchable content');
    INSERT INTO item_sources(item_id,source_id,native_id,url) VALUES('i','s','original','https://example.com/item');
    INSERT INTO jobs(id,source_id,status,attempts,available_at,created_at,lease_until,lease_token) VALUES('j','s','running',1,100,100,60100,'old-token');`);
  db.query("VACUUM INTO ?").run(backup);
  db.close();
  let store: Store | undefined;
  let restored: Store | undefined;
  try {
    store = new Store(path);
    expect(store.state("s")).toEqual({ etag: "v1", lastModified: "yesterday" });
    expect(store.search("searchable").map((item) => item.id)).toEqual(["i"]);
    expect(store.claimProcessing("extract", Date.now())?.item_id).toBe("i");
    expect(store.getItem("i")!.references).toHaveLength(1);
    expect(store.claim(60099)).toBeNull();
    const recovered = store.claim(60100)!;
    expect(recovered.id).toBe("j");
    expect(recovered.attempts).toBe(2);
    expect(
      store.complete(
        { ...recovered, lease_token: "old-token" },
        { items: [] },
        60101,
      ),
    ).toBe(false);
    restored = new Store(backup);
    expect(restored.search("searchable").map((item) => item.id)).toEqual(["i"]);
    expect(restored.state("s").etag).toBe("v1");
    expect(restored.sqlite.query("PRAGMA integrity_check").get()).toEqual({
      integrity_check: "ok",
    });
  } finally {
    store?.close();
    restored?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("processing lease renewal and reclaim fence stale writes across restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "newspulse-fence-"));
  const path = join(dir, "db.sqlite");
  let store = new Store(path);
  try {
    store.addSource("https://example.com/feed");
    store.enqueueDue(100);
    store.complete(
      store.claim(100)!,
      { items: [{ nativeId: "1", title: "item", text: "searchable" }] },
      101,
    );
    const itemId = store.search("searchable")[0]!.id;
    store.enqueueProcessing("analyse", itemId, 102);
    const old = store.claimProcessing("analyse", 102)!;
    expect(store.renewProcessing(old, 100000, 103)).toBe(true);
    store.close();
    store = new Store(path);
    expect(store.claimProcessing("analyse", 100102)).toBeNull();
    expect(store.renewProcessing(old, 1000, 100103)).toBe(false);
    expect(store.completeProcessing(old, "analysed", 100103)).toBe(false);
    const replacement = store.claimProcessing("analyse", 100103)!;
    expect(replacement.attempts).toBe(2);
    expect(store.renewProcessing(old, 1000, 100104)).toBe(false);
    expect(store.completeProcessing(old, "analysed", 100104)).toBe(false);
    expect(store.completeProcessing(replacement, "analysed", 100104)).toBe(
      true,
    );
    expect(store.getItem(itemId)!.status).toBe("analysed");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
