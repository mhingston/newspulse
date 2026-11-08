import { stopServices } from "./lifecycle";
import { config } from "./config";
import { Store } from "./db/store";
import { RssAdapter } from "./adapters/rss";
import { Worker, ProcessingWorker, schedule, log } from "./worker";
import { HttpContentExtractor, extractionHandler } from "./adapters/extraction";
import { createApp } from "./http";
const cfg = config();
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
