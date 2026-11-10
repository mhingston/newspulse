import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/db/store";
import { acquireDiscoveryLock } from "../src/discovery-lock";
import { withDiscoveryDispatch } from "../src/discovery-dispatch";
import { markRestoredDiscovery } from "../src/discovery-restore-guard";
import {
  confirmTriggerDiscovery,
  previewTriggerDiscovery,
} from "../src/mutations";
import type { SearchProvider } from "../src/search-provider";

const env = {
  DISCOVERY_DAILY_QUERIES: "5",
  DISCOVERY_RUN_QUERIES: "1",
  DISCOVERY_DAILY_RESULTS: "20",
  DISCOVERY_RUN_RESULTS: "10",
  DISCOVERY_DAILY_MICROS: "5000",
  DISCOVERY_RUN_MICROS: "1000",
  DISCOVERY_QUERY_MICROS: "100",
};

function withTempPath(run: (path: string) => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), "newspulse-dispatch-"));
  return (async () => {
    try {
      await run(join(dir, "db.sqlite"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  })();
}

describe("confirmed discovery shares the process lock and restore guard", () => {
  test("holds the exclusive lock through provider work and releases it", async () => {
    await withTempPath(async (path) => {
      let ran = false;
      await withDiscoveryDispatch(path, () => {
        ran = true;
        // Another operator cannot acquire while the dispatch owns it.
        expect(() => acquireDiscoveryLock(path)).toThrow();
      });
      expect(ran).toBe(true);
      // Released afterwards, so a fresh acquisition succeeds.
      acquireDiscoveryLock(path).close();
    });
  });

  test("reuses the lock this process already holds without releasing it", async () => {
    await withTempPath(async (path) => {
      const held = acquireDiscoveryLock(path);
      try {
        let ran = false;
        await withDiscoveryDispatch(path, () => {
          ran = true;
        });
        expect(ran).toBe(true);
        // The service keeps exclusive ownership; a second acquire still fails.
        expect(() => acquireDiscoveryLock(path)).toThrow();
      } finally {
        held.close();
      }
    });
  });

  test("the restore guard blocks dispatch before any work runs", async () => {
    await withTempPath(async (path) => {
      markRestoredDiscovery(path, Date.now());
      let ran = false;
      await expect(
        withDiscoveryDispatch(path, () => {
          ran = true;
        }),
      ).rejects.toThrow(/restore/i);
      expect(ran).toBe(false);
    });
  });

  test("a confirmed trigger is refused under the restore guard without spending or consuming the token", async () => {
    await withTempPath(async (path) => {
      const store = new Store(path);
      try {
        const calls = { n: 0 };
        const provider: SearchProvider = {
          name: "fake",
          version: "1",
          async search() {
            calls.n++;
            // While the provider is contacted, the exclusive lock is held.
            expect(() => acquireDiscoveryLock(path)).toThrow();
            return { results: [], truncated: false };
          },
        };
        const preview = previewTriggerDiscovery(
          store,
          { query: "robotics" },
          env,
        );
        const token = preview.confirm_token as string;

        // A restore blocks the run before the approval is consumed or the
        // provider is contacted, so the token stays usable.
        markRestoredDiscovery(path, Date.now());
        await expect(
          confirmTriggerDiscovery(store, token, provider, env, path),
        ).rejects.toThrow(/restore/i);
        expect(calls.n).toBe(0);
        expect(
          store.sqlite
            .query<{ used_at: number | null }, [string]>(
              "SELECT used_at FROM mutation_confirmations WHERE id=?",
            )
            .get(token),
        ).toEqual({ used_at: null });
      } finally {
        store.close();
      }
    });
  });

  test("a confirmed trigger runs under the lock once the guard is clear", async () => {
    await withTempPath(async (path) => {
      const store = new Store(path);
      try {
        const calls = { n: 0 };
        const provider: SearchProvider = {
          name: "fake",
          version: "1",
          async search() {
            calls.n++;
            expect(() => acquireDiscoveryLock(path)).toThrow();
            return { results: [], truncated: false };
          },
        };
        const preview = previewTriggerDiscovery(
          store,
          { query: "robotics" },
          env,
        );
        const result = await confirmTriggerDiscovery(
          store,
          preview.confirm_token as string,
          provider,
          env,
          path,
        );
        expect(result.status).toBe("complete");
        expect(calls.n).toBeGreaterThan(0);
        // The lock is released after the run.
        acquireDiscoveryLock(path).close();
      } finally {
        store.close();
      }
    });
  });
});
