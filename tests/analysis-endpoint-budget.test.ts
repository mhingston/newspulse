import { describe, expect, test } from "bun:test";
import { Store } from "../src/db/store";
import { AnalysisBudget } from "../src/analysis-budget";
import {
  analysisConfig,
  analysisDailyLimitOrUndefined,
} from "../src/analysis-config";
import { OpenAICompatibleAnalysis } from "../src/adapters/analysis";

const DAY = 86_400_000;
const base = {
  ANALYSIS_KEY: "secret",
  ANALYSIS_MODEL: "m",
  ANALYSIS_TOTAL_TOKENS: "100000",
  ANALYSIS_TOTAL_MICROS: "100000",
  ANALYSIS_CALL_MICROS: "100",
};
const withEndpoint = (endpoint: string) =>
  analysisConfig({ ...base, ANALYSIS_ENDPOINT: endpoint });

describe("analysis endpoint scheme", () => {
  test("https is accepted for any host", () => {
    expect(
      withEndpoint("https://api.example.com/v1/chat/completions"),
    ).not.toBeNull();
  });
  test("plain HTTP is accepted only for loopback hosts", () => {
    expect(
      withEndpoint("http://127.0.0.1:8081/v1/chat/completions"),
    ).not.toBeNull();
    expect(
      withEndpoint("http://localhost:8081/v1/chat/completions"),
    ).not.toBeNull();
    expect(
      withEndpoint("http://[::1]:8081/v1/chat/completions"),
    ).not.toBeNull();
  });
  test("plain HTTP to non-loopback or private hosts is rejected", () => {
    expect(() =>
      withEndpoint("http://example.com/v1/chat/completions"),
    ).toThrow();
    expect(() => withEndpoint("http://10.0.0.5/v1/chat/completions")).toThrow();
  });
  test("loopback HTTP still rejects credentials, query and fragment", () => {
    expect(() => withEndpoint("http://user:pw@127.0.0.1/v1")).toThrow();
    expect(() => withEndpoint("http://127.0.0.1/v1?x=1")).toThrow();
    expect(() => withEndpoint("https://api.example.com/v1#frag")).toThrow();
  });
  test("https with a query is rejected", () => {
    expect(() =>
      withEndpoint("https://api.example.com/v1/chat/completions?key=1"),
    ).toThrow();
  });
  test("provider adapter applies the same loopback rule", () => {
    const settings = {
      model: "m",
      apiKey: "k",
      maxInputChars: 1000,
      maxOutputTokens: 200,
      timeoutMs: 1000,
    };
    expect(
      () =>
        new OpenAICompatibleAnalysis({
          ...settings,
          endpoint: "http://127.0.0.1:8081/v1/chat/completions",
        }),
    ).not.toThrow();
    expect(
      () =>
        new OpenAICompatibleAnalysis({
          ...settings,
          endpoint: "http://10.0.0.5/v1/chat/completions",
        }),
    ).toThrow();
  });
});

describe("analysis daily micros ceiling", () => {
  const dailyEnv = (daily: string | undefined) =>
    analysisConfig({
      ...base,
      ANALYSIS_ENDPOINT: "https://api.example.com/v1/chat/completions",
      ...(daily === undefined ? {} : { ANALYSIS_DAILY_MICROS: daily }),
    });

  test("unset leaves lifetime-only behaviour and no daily limit", () => {
    expect(dailyEnv(undefined)?.maxDailyMicros).toBeNull();
    expect(analysisDailyLimitOrUndefined({})).toBeUndefined();
  });

  test("daily ceiling below the per-call bound is rejected", () => {
    expect(() => dailyEnv("99")).toThrow();
    expect(dailyEnv("100")?.maxDailyMicros).toBe(100);
  });

  test("non-integer or non-positive daily ceiling is rejected", () => {
    expect(() => dailyEnv("1.5")).toThrow();
    expect(() => dailyEnv("0")).toThrow();
  });

  test("daily cap refuses once reached and resets on the next UTC day", () => {
    const store = new Store(":memory:");
    try {
      let now = 10 * DAY + 1000;
      const budget = new AnalysisBudget(
        store.sqlite,
        {
          maxTokens: 100_000,
          maxMicros: 100_000,
          maxDailyMicros: 200,
          maxConcurrent: 5,
        },
        () => now,
      );
      expect(budget.reserve("a", 1, 100)).toBe(true);
      expect(budget.reserve("b", 1, 100)).toBe(true);
      expect(budget.reserve("c", 1, 1)).toBe(false);
      expect(budget.dailyUsage()).toEqual({ day: 10, micros: 200 });
      now = 11 * DAY + 1;
      expect(budget.dailyUsage()).toEqual({ day: 11, micros: 0 });
      expect(budget.reserve("d", 1, 200)).toBe(true);
      expect(budget.reserve("e", 1, 1)).toBe(false);
    } finally {
      store.close();
    }
  });

  test("daily cap is atomic with the lifetime cap and charged reservations are never refunded", () => {
    const store = new Store(":memory:");
    try {
      const budget = new AnalysisBudget(
        store.sqlite,
        {
          maxTokens: 100_000,
          maxMicros: 1000,
          maxDailyMicros: 150,
          maxConcurrent: 5,
        },
        () => 5 * DAY,
      );
      expect(budget.reserve("a", 1, 100)).toBe(true);
      expect(budget.finish("a", "{}", null)).toBe(true);
      expect(budget.reserve("b", 1, 100)).toBe(false);
      expect(budget.dailyUsage().micros).toBe(100);
    } finally {
      store.close();
    }
  });

  test("lifetime cap is still enforced when no daily cap is set", () => {
    const store = new Store(":memory:");
    try {
      let now = 3 * DAY;
      const budget = new AnalysisBudget(
        store.sqlite,
        { maxTokens: 100_000, maxMicros: 300, maxConcurrent: 5 },
        () => now,
      );
      expect(budget.reserve("a", 1, 100)).toBe(true);
      expect(budget.reserve("b", 1, 100)).toBe(true);
      expect(budget.reserve("c", 1, 100)).toBe(true);
      expect(budget.reserve("d", 1, 1)).toBe(false);
      now = 4 * DAY;
      expect(budget.reserve("e", 1, 1)).toBe(false);
    } finally {
      store.close();
    }
  });

  test("invalid daily limit is rejected by the budget constructor", () => {
    const store = new Store(":memory:");
    try {
      expect(
        () =>
          new AnalysisBudget(store.sqlite, {
            maxTokens: 1,
            maxMicros: 1,
            maxDailyMicros: 0,
            maxConcurrent: 1,
          }),
      ).toThrow("Invalid budget limits");
    } finally {
      store.close();
    }
  });

  test("status reports today's analysis usage and configured daily limit", () => {
    const store = new Store(":memory:");
    try {
      const now = 7 * DAY + 5;
      store.sqlite
        .query(
          "INSERT INTO analysis_reservations(key,tokens,micros,status,budget_day) VALUES('x',1,40,'settled',7),('y',1,25,'settled',6)",
        )
        .run();
      const analysis = store.status({
        now,
        analysisDailyLimitMicros: 500,
      }).budgets.analysis;
      expect(analysis.day).toBe(7);
      expect(analysis.today_cost_micros).toBe(40);
      expect(analysis.daily_limit_micros).toBe(500);
      expect(analysis.cost_micros).toBe(65);
      const unlimited = store.status({ now }).budgets.analysis;
      expect(unlimited.daily_limit_micros).toBeNull();
    } finally {
      store.close();
    }
  });
});
