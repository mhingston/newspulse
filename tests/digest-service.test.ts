import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/http";
import { expect, test } from "bun:test";
import { Store } from "../src/db/store";
import { ProfileStore } from "../src/profiles";
import { ProcessingWorker } from "../src/worker";
import { scoringHandler } from "../src/scoring-service";
import {
  draftDigest,
  previewDigest,
  freezeDigest,
  digestDefaults,
} from "../src/digest-service";
import { DigestStore } from "../src/db/digest-store";

const today = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Europe/London",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(Date.now());

test("current scored item can be drafted and frozen without delivery, retaining a source identity", async () => {
  const store = new Store(":memory:");
  try {
    new ProfileStore(store.sqlite).import([
      {
        kind: "interest",
        id: "robots",
        version: 1,
        description: "Robotics",
        entities: [],
        keywords: ["robotics"],
        priority: 3,
        positive: [],
        negative: [],
        queries: [],
        lifetime: "persistent",
        feedbackRefs: [],
      },
    ]);
    store.addSource("https://example.com/feed");
    store.enqueueDue();
    store.complete(store.claim()!, {
      items: [
        {
          nativeId: "msg-1",
          title: "Robotics tool release",
          text: "Robotics release and practical implementation ".repeat(30),
        },
      ],
    });
    const itemId = store.search("robotics")[0]!.id;
    store.completeProcessing(store.claimProcessing("extract")!, "unavailable");
    const worker = new ProcessingWorker(store, {
      score: scoringHandler(store),
    });
    await worker.drain("score");
    const options = { ...digestDefaults(today), minScore: 0 };
    expect(draftDigest(store, options)).toMatchObject({
      status: "processing",
      reason: "grouping_or_scores_pending",
    });
    store.stories.reconcile();
    await worker.drain("score");
    const draft = draftDigest(store, options);
    expect(draft.status).toBe("ready");
    if (draft.status !== "ready") throw new Error("missing draft");
    expect(draft.selected[0]!.itemId).toBe(itemId);
    expect(draft.rendered!.text).toContain("msg-1");
    expect(() =>
      draftDigest(store, { ...options, date: "2000-01-01" }),
    ).toThrow("local date");
    store.sqlite
      .query(
        "UPDATE processing_jobs SET status='pending' WHERE stage='score' AND item_id=?",
      )
      .run(itemId);
    expect(draftDigest(store, options)).toMatchObject({
      status: "processing",
      reason: "scores_pending_or_unavailable",
    });
    await worker.drain("score");
    const preview = previewDigest(store, options);
    expect(() => freezeDigest(store, options, "bad")).toThrow();
    expect(() =>
      freezeDigest(
        store,
        options,
        preview.confirmation.hash,
        options.now + 300_001,
      ),
    ).toThrow("expired");
    expect(() =>
      freezeDigest(
        store,
        { ...options, maxItems: 2 },
        preview.confirmation.hash,
      ),
    ).toThrow("does not match");
    const frozen = freezeDigest(store, options, preview.confirmation.hash);
    expect(frozen.items[0]!.item_id).toBe(itemId);
    expect(new DigestStore(store.sqlite).get(today)).toEqual(frozen);
    expect(frozen.plain_text).toContain("msg-1");
    const app = createApp(store, {
      token: "a-long-private-token-with-24-characters",
      allowedHosts: ["127.0.0.1"],
      allowedOrigins: [],
    });
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: app.fetch,
    });
    const client = new Client({ name: "digest-test", version: "1" });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL("mcp", server.url), {
          requestInit: {
            headers: {
              authorization: "Bearer a-long-private-token-with-24-characters",
            },
          },
        }),
      );
      const response = await client.callTool({
        name: "get_digest",
        arguments: { date: today, view: "frozen" },
      });
      const edition = JSON.parse(
        (response.content as { text: string }[])[0]!.text,
      );
      expect(edition.id).toBe(frozen.id);
      const developing = await client.callTool({
        name: "get_digest",
        arguments: { date: today, view: "draft" },
      });
      expect(
        JSON.parse((developing.content as { text: string }[])[0]!.text).status,
      ).toBe("ready");
    } finally {
      await client.close();
      await server.stop(true);
    }
    store.sqlite
      .query("UPDATE items SET title='Corrected title' WHERE id=?")
      .run(itemId);
    expect(new DigestStore(store.sqlite).get(today)).toEqual(frozen);
    expect(store.search("robotics")).toHaveLength(1);
  } finally {
    store.close();
  }
});
