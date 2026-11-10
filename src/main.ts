import { assertDeliveryRestoreAcknowledged } from "./delivery-restore-guard";
import { deliveryConfig } from "./delivery-config";
import { acquireDeliveryLock } from "./delivery-lock";
import { DeliveryStore } from "./db/delivery-store";
import { DeliveryWorker } from "./delivery";
import { ResendDelivery } from "./adapters/resend-delivery";
import { PublicationWorker } from "./publication-worker";
import { acquireAnalysisLock } from "./analysis-lock";
import { analysisConfig } from "./analysis-config";
import { OpenAICompatibleAnalysis } from "./adapters/analysis";
import { AnalysisBudget } from "./analysis-budget";
import { analysisHandler } from "./analysis-service";
import { scoringHandler } from "./scoring-service";
import { stopServices } from "./lifecycle";
import { config } from "./config";
import { Store } from "./db/store";
import { RssAdapter } from "./adapters/rss";
import { Worker, ProcessingWorker, schedule, log } from "./worker";
import { HttpContentExtractor, extractionHandler } from "./adapters/extraction";
import { createApp } from "./http";
import { ResendInbound } from "./adapters/resend-inbound";
import { InboundStore } from "./db/inbound";
import { InboundWorker, inboundWebhook } from "./inbound-worker";
import { scheduledDiscoveryConfig } from "./scheduled-discovery-config";
import { acquireDiscoveryLock } from "./discovery-lock";
import { createScheduledDiscoveryTick } from "./scheduled-discovery";
import { githubDiscoveryConfig } from "./github-discovery-config";
import { createGithubDiscoveryTick } from "./github-discovery";
import { GitHubSourceAdapter } from "./adapters/github";
import { isGithubSourceUrl } from "./domain";
import { SourceRouter } from "./worker";
const cfg = config();
const analysis = analysisConfig();
const delivery = deliveryConfig();
const scheduledDiscovery = scheduledDiscoveryConfig();
const githubDiscovery = githubDiscoveryConfig();
// The OS releases this lock only when the process exits, including after a crash.
// Keep it for the process lifetime even if a timed-out provider ignores abort.
if (analysis) acquireAnalysisLock(cfg.DB_PATH);
// Retain exclusive ownership through shutdown and any in-flight send.
if (delivery) {
  acquireDeliveryLock(cfg.DB_PATH);
  assertDeliveryRestoreAcknowledged(cfg.DB_PATH);
}
if (scheduledDiscovery || githubDiscovery) {
  acquireDiscoveryLock(cfg.DB_PATH);
}
const store = new Store(cfg.DB_PATH);
const inboundStore =
  cfg.RESEND_API_KEY && cfg.RESEND_WEBHOOK_SECRET
    ? new InboundStore(store.sqlite)
    : undefined;
const inboundProvider =
  cfg.RESEND_API_KEY && cfg.RESEND_WEBHOOK_SECRET
    ? new ResendInbound(cfg.RESEND_API_KEY, cfg.RESEND_WEBHOOK_SECRET)
    : undefined;
const app = createApp(store, {
  token: cfg.MCP_TOKEN,
  allowedHosts: cfg.ALLOWED_HOSTS.split(",").map((s) => s.trim()),
  allowedOrigins: cfg.ALLOWED_ORIGINS.split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  inboundWebhook:
    inboundStore && inboundProvider
      ? inboundWebhook(inboundStore, inboundProvider)
      : undefined,
});
const server = Bun.serve({
  hostname: cfg.HOST,
  port: cfg.PORT,
  fetch: app.fetch,
  maxRequestBodySize: 65536,
});
const scheduler = schedule(
  store,
  new Worker(
    store,
    new SourceRouter(
      [
        {
          matches: isGithubSourceUrl,
          adapter: new GitHubSourceAdapter(cfg.GITHUB_TOKEN),
        },
      ],
      new RssAdapter(),
    ),
  ),
  new ProcessingWorker(store, {
    score: scoringHandler(store),
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
  inboundStore && inboundProvider
    ? new InboundWorker(inboundStore, inboundProvider)
    : undefined,
  delivery
    ? new PublicationWorker(
        store,
        new DeliveryStore(store.sqlite),
        new DeliveryWorker(
          new DeliveryStore(store.sqlite),
          new ResendDelivery(delivery.apiKey),
        ),
        {
          from: delivery.sender,
          to: delivery.recipient,
          timezone: delivery.timezone,
          hour: delivery.hour,
          minute: delivery.minute,
        },
      )
    : undefined,
  scheduledDiscovery
    ? {
        tick: createScheduledDiscoveryTick(
          cfg.DB_PATH,
          store,
          scheduledDiscovery,
        ),
      }
    : undefined,
  githubDiscovery
    ? {
        tick: createGithubDiscoveryTick(
          cfg.DB_PATH,
          store,
          githubDiscovery,
          cfg.GITHUB_TOKEN,
        ),
      }
    : undefined,
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
