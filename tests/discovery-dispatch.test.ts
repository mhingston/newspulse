import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/db/store";
import { acquireDiscoveryLock } from "../src/discovery-lock";
import {
  withDiscoveryDispatch,
  type DiscoveryDispatchBoundary,
} from "../src/discovery-dispatch";
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

  test("re-checks the guard under the lock so a restore that lands while waiting still blocks work", async () => {
    const order: string[] = [];
    let checks = 0;
    let closed = false;
    const boundary: DiscoveryDispatchBoundary = {
      assertElapsed: () => {
        checks++;
        order.push(`check:${checks}`);
        // The first check passes; the restore completes while this dispatch
        // waits for the lock, so the under-lock check must fail.
        if (checks === 2) throw new Error("restore pending");
      },
      held: () => null,
      acquire: () => {
        order.push("acquire");
        return {
          close() {
            closed = true;
            order.push("release");
          },
        };
      },
    };
    let ran = false;
    await expect(
      withDiscoveryDispatch(
        "/tmp/dispatch-ordering.sqlite",
        () => {
          ran = true;
        },
        boundary,
      ),
    ).rejects.toThrow(/restore/i);
    // The guard is checked before contending, then again under the lock, and
    // the lock is always released even though work never ran.
    expect(order).toEqual(["check:1", "acquire", "check:2", "release"]);
    expect(ran).toBe(false);
    expect(closed).toBe(true);
  });

  test("re-checks the guard when this process already holds the lock", async () => {
    const order: string[] = [];
    let checks = 0;
    const boundary: DiscoveryDispatchBoundary = {
      assertElapsed: () => {
        checks++;
        order.push(`check:${checks}`);
        if (checks === 2) throw new Error("restore pending");
      },
      held: () => {
        order.push("held");
        return { close() {} };
      },
      acquire: () => {
        throw new Error("must not acquire a held lock");
      },
    };
    let ran = false;
    await expect(
      withDiscoveryDispatch(
        "/tmp/dispatch-held.sqlite",
        () => {
          ran = true;
        },
        boundary,
      ),
    ).rejects.toThrow(/restore/i);
    expect(order).toEqual(["check:1", "held", "check:2"]);
    expect(ran).toBe(false);
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
