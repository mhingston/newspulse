import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Store } from "../src/db/store";
import { createApp } from "../src/http";
import { healthReport, HEALTH_THRESHOLDS } from "../src/health";

const token = "health-test-token-at-least-24-characters";

async function withMcp(
  store: Store,
  run: (
    call: (name: string, args?: Record<string, unknown>) => Promise<any>,
  ) => Promise<void>,
) {
  const app = createApp(store, {
    token,
    allowedHosts: ["127.0.0.1"],
    allowedOrigins: [],
    mcp: {},
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: app.fetch,
  });
  const client = new Client({ name: "health-test", version: "1" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL("mcp", server.url), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
    await run(async (name, args = {}) => {
      const result = await client.callTool({ name, arguments: args });
      const text = (result.content as Array<{ text: string }>)[0]!.text;
      return { isError: result.isError === true, data: JSON.parse(text) };
    });
  } finally {
    await client.close();
    server.stop(true);
  }
}

describe("healthReport", () => {
  test("a fresh store is ready with no warnings", () => {
    const store = new Store(":memory:");
    try {
      const report = healthReport(store.sqlite, 1000);
      expect(report.ready).toBe(true);
      expect(report.warnings).toEqual([]);
      expect(report.analysis_cost).toEqual({
        analyses: 0,
        known_cost_micros: 0,
        unknown_cost_count: 0,
      });
    } finally {
      store.close();
    }
  });

  test("flags failing sources and reports them by id without credentials", () => {
    const store = new Store(":memory:");
    try {
      const source = store.addSource(
        "https://example.com/feed.xml",
        "Failing feed",
      );
      store.sqlite
        .query("UPDATE sources SET failures=?,last_error=? WHERE id=?")
        .run(HEALTH_THRESHOLDS.failingSourceFailures, "HTTP 503", source.id);
      const report = healthReport(store.sqlite, 1000);
      expect(report.ready).toBe(false);
      expect(report.warnings).toContain("failing_sources");
      expect(report.failing_sources).toEqual([
        {
          source_id: source.id,
          title: "Failing feed",
          failures: HEALTH_THRESHOLDS.failingSourceFailures,
          last_error: "HTTP 503",
        },
      ]);
    } finally {
      store.close();
    }
  });

  test("disabled sources do not keep readiness false after failures", () => {
    const store = new Store(":memory:");
    try {
      const source = store.addSource("https://example.com/old.xml", "Old feed");
      store.sqlite
        .query(
          "UPDATE sources SET failures=3,last_error='HTTP 503',enabled=0 WHERE id=?",
        )
        .run(source.id);
      const report = healthReport(store.sqlite, 1000);
      expect(report.failing_sources).toEqual([]);
      expect(report.warnings).not.toContain("failing_sources");
      expect(report.ready).toBe(true);
    } finally {
      store.close();
    }
  });

  test("failing source titles never expose feed tokens", () => {
    const store = new Store(":memory:");
    try {
      const secretUrl = "https://example.com/feed.xml?token=supersecret123";
      const source = store.addSource(secretUrl);
      store.sqlite
        .query("UPDATE sources SET failures=3,last_error=? WHERE id=?")
        .run(`fetch ${secretUrl} failed`, source.id);
      const report = healthReport(store.sqlite, 1000);
      const serialized = JSON.stringify(report.failing_sources);
      expect(serialized).not.toContain("supersecret123");
      expect(report.failing_sources[0]!.title).toBe(
        "https://example.com/feed.xml",
      );
    } finally {
      store.close();
    }
  });

  test("queue age uses queue entry time, not the retry deadline", () => {
    const store = new Store(":memory:");
    try {
      store.sqlite
        .query(
          "INSERT INTO items(id,identity,title,ingested_at) VALUES('q1','qid1','t',1)",
        )
        .run();
      const queuedAt = 0;
      store.sqlite
        .query(
          "INSERT INTO processing_jobs(id,stage,item_id,generation,status,attempts,available_at,queued_at,created_at) VALUES('j1','extract','q1',1,'pending',3,?,?,0)",
        )
        .run(10 * 60 * 60_000 - 5_000, queuedAt);
      const extract = healthReport(store.sqlite, 10 * 60 * 60_000).queue.find(
        (q) => q.stage === "extract",
      )!;
      expect(extract.oldest_age_ms).toBe(10 * 60 * 60_000);
      expect(healthReport(store.sqlite, 10 * 60 * 60_000).warnings).toContain(
        "queue_age",
      );
    } finally {
      store.close();
    }
  });

  test("an idle analysis queue is not a readiness warning when analysis is disabled", () => {
    const store = new Store(":memory:");
    try {
      store.sqlite
        .query(
          "INSERT INTO items(id,identity,title,ingested_at) VALUES('a1','aid1','t',1)",
        )
        .run();
      store.sqlite
        .query(
          "INSERT INTO processing_jobs(id,stage,item_id,generation,status,attempts,available_at,queued_at,created_at) VALUES('ja','analyse','a1',1,'pending',0,0,0,0)",
        )
        .run();
      const hour = 60 * 60_000 + 1;
      expect(
        healthReport(store.sqlite, hour, {
          enabledStages: ["extract", "score", "group"],
        }).warnings,
      ).not.toContain("queue_age");
      const enabled = healthReport(store.sqlite, hour, {
        enabledStages: ["analyse"],
      });
      expect(enabled.warnings).toContain("queue_age");
      // Idle stages stay visible in the queue counts.
      expect(
        healthReport(store.sqlite, hour, {
          enabledStages: ["extract"],
        }).queue.map((q) => q.stage),
      ).toContain("analyse");
    } finally {
      store.close();
    }
  });

  test("reused analysis rows do not double count known cost", () => {
    const store = new Store(":memory:");
    try {
      store.sqlite
        .query(
          "INSERT INTO items(id,identity,title,ingested_at) VALUES('r1','rid1','t',1)",
        )
        .run();
      const insert = (id: string, generation: number, createdAt: number) =>
        store.sqlite
          .query(
            "INSERT INTO analyses(id,item_id,generation,input_hash,provider,model,prompt_version,profiles,result,usage,cost,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
          )
          .run(
            id,
            "r1",
            generation,
            "same",
            "p",
            "m",
            "v",
            "{}",
            "{}",
            null,
            70,
            createdAt,
          );
      insert("c1", 1, 1);
      // Identical reanalysis in a new generation copies the earlier billed cost without another request.
      insert("c2", 2, 2);
      const cost = healthReport(store.sqlite, 1000).analysis_cost;
      expect(cost.analyses).toBe(2);
      expect(cost.known_cost_micros).toBe(70);
    } finally {
      store.close();
    }
  });

  test("counts ambiguous deliveries as a warning", () => {
    const store = new Store(":memory:");
    try {
      store.sqlite
        .query(
          "INSERT INTO digests(id,edition_date,timezone,subject,html,plain_text,decisions,fingerprint,frozen_at,sealed) VALUES('d1','2026-01-01','Europe/London','s','h','t','{}','f',1,1)",
        )
        .run();
      store.sqlite
        .query(
          "INSERT INTO deliveries(id,digest_id,edition_date,recipient,sender,idempotency_key,status,attempts,available_at,created_at,updated_at) VALUES('x','d1','2026-01-01','r','s','k','ambiguous',1,0,1,1)",
        )
        .run();
      const report = healthReport(store.sqlite, 1000);
      expect(report.ambiguous_deliveries.count).toBe(1);
      expect(report.warnings).toContain("ambiguous_deliveries");
    } finally {
      store.close();
    }
  });

  test("unknown analysis cost is counted as unknown, not zero-cost", () => {
    const store = new Store(":memory:");
    try {
      store.sqlite
        .query(
          "INSERT INTO items(id,identity,title,ingested_at) VALUES('i1','id1','t',1)",
        )
        .run();
      const insert = (id: string, generation: number, hash: string) =>
        store.sqlite
          .query(
            "INSERT INTO analyses(id,item_id,generation,input_hash,provider,model,prompt_version,profiles,result,usage,cost,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
          )
          .run(
            id,
            "i1",
            generation,
            hash,
            "p",
            "m",
            "v",
            "{}",
            "{}",
            null,
            null,
            1,
          );
      insert("a1", 1, "h1");
      insert("a2", 2, "h2");
      const cost = healthReport(store.sqlite, 1000).analysis_cost;
      expect(cost.analyses).toBe(2);
      expect(cost.unknown_cost_count).toBe(2);
      expect(cost.known_cost_micros).toBe(0);
    } finally {
      store.close();
    }
  });

  test("get_status exposes the health block over the real SDK and omits secrets", async () => {
    const store = new Store(":memory:");
    try {
      store.addSource("https://example.com/ok.xml", "Healthy feed");
      await withMcp(store, async (call) => {
        const { isError, data } = await call("get_status");
        expect(isError).toBe(false);
        expect(data.health.ready).toBe(true);
        expect(data.health.checked_at).toBeGreaterThan(0);
        expect(JSON.stringify(data)).not.toContain(token);
      });
    } finally {
      store.close();
    }
  });
});
