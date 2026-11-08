import { acquireAnalysisLock } from "./analysis-lock";
import { analysisConfig } from "./analysis-config";
import { OpenAICompatibleAnalysis } from "./adapters/analysis";
import { AnalysisBudget } from "./analysis-budget";
import { analysisHandler } from "./analysis-service";
import { stopServices } from "./lifecycle";
import { config } from "./config";
import { Store } from "./db/store";
import { RssAdapter } from "./adapters/rss";
import { Worker, ProcessingWorker, schedule, log } from "./worker";
import { HttpContentExtractor, extractionHandler } from "./adapters/extraction";
import { createApp } from "./http";
const cfg = config();
const analysis = analysisConfig();
// The OS releases this lock only when the process exits, including after a crash.
// Keep it for the process lifetime even if a timed-out provider ignores abort.
if (analysis) acquireAnalysisLock(cfg.DB_PATH);
const store = new Store(cfg.DB_PATH);
const app = createApp(store, {
  token: cfg.MCP_TOKEN,
  allowedHosts: cfg.ALLOWED_HOSTS.split(",").map((s) => s.trim()),
  allowedOrigins: cfg.ALLOWED_ORIGINS.split(",")
    .map((s) => s.trim())
    .filter(Boolean),
});
const server = Bun.serve({
  hostname: cfg.HOST,
  port: cfg.PORT,
  fetch: app.fetch,
  maxRequestBodySize: 65536,
});
const scheduler = schedule(
  store,
  new Worker(store, new RssAdapter()),
  new ProcessingWorker(store, {
    group: async () => {
      const result = store.stories.reconcile();
      if (result.stale) throw new Error("Story inputs changed during grouping");
      return { status: "grouped", result: JSON.stringify(result) };
    },
    analyse: analysis
      ? analysisHandler(
          store,
          new OpenAICompatibleAnalysis({
            endpoint: analysis.endpoint,
            model: analysis.model,
            apiKey: analysis.apiKey,
            maxInputChars: 16000,
            maxOutputTokens: 1000,
            timeoutMs: 45000,
          }),
          new AnalysisBudget(store.sqlite, {
            maxTokens: analysis.maxTokens,
            maxMicros: analysis.maxMicros,
            maxConcurrent: 1,
          }),
          {
            provider: analysis.endpoint,
            model: analysis.model,
            promptVersion: "1",
            reserveTokens: analysis.reserveTokens,
            reserveMicros: analysis.reserveMicros,
          },
        )
      : undefined,
    extract: extractionHandler(
      store,
      new HttpContentExtractor(),
      cfg.TRUSTED_PRIVATE_FEEDS.split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  }),
);
log("started", { host: cfg.HOST, port: cfg.PORT });
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await stopServices(server, scheduler, store);
}
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
