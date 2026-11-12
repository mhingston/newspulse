import { expect, test } from "bun:test";
import { HttpContentExtractor } from "../src/adapters/extraction";

test("extracts article text, strips boilerplate and decodes entities", async () => {
  const extractor = new HttpContentExtractor(
    async () => ["93.184.216.34"],
    async () => ({
      status: 200,
      headers: { "content-type": "text/html" },
      body: "<html><nav>Menu</nav><article><h1>Heading</h1><p>Fish &amp; chips</p><pre>const x = 1;</pre></article></html>",
    }),
  );
  const result = await extractor.extract("https://example.com/a");
  expect(result.status).toBe("extracted");
  expect(result.text).toContain("Fish & chips");
  expect(result.text).toContain("const x = 1;");
  expect(result.text).not.toContain("Menu");
});

test("blocks private destinations and redirect changes before transport", async () => {
  let requests = 0;
  const extractor = new HttpContentExtractor(
    async (host) =>
      host === "example.com" ? ["93.184.216.34"] : ["127.0.0.1"],
    async () => {
      requests++;
      return {
        status: 302,
        headers: { location: "http://localhost/" },
        body: "",
      };
    },
  );
  const result = await extractor.extract("https://example.com/a");
  expect(result.status).toBe("unavailable");
  expect(requests).toBe(1);
  expect((await extractor.extract("http://169.254.169.254/")).status).toBe(
    "unavailable",
  );
  expect(requests).toBe(1);
});

test("completed extraction keeps feed content and makes full text searchable", async () => {
  const { Store } = await import("../src/db/store");
  const { ProcessingWorker } = await import("../src/worker");
  const { extractionHandler } = await import("../src/adapters/extraction");
  const store = new Store(":memory:");
  store.addSource("https://example.com/feed");
  store.enqueueDue(1);
  store.complete(
    store.claim(1)!,
    {
      items: [
        {
          nativeId: "a",
          url: "https://example.com/a",
          title: "Alpha",
          text: "feed summary",
        },
      ],
    },
    2,
  );
  const item = store.search("summary")[0]!;
  const extractor = new HttpContentExtractor(
    async () => ["93.184.216.34"],
    async () => ({
      status: 200,
      headers: { "content-type": "text/html" },
      body: "<article>distinctive article details</article>",
    }),
  );
  await new ProcessingWorker(store, {
    extract: extractionHandler(store, extractor),
  }).drain("extract");
  expect(store.search("distinctive")[0]?.id).toBe(item.id);
  expect(store.search("summary")[0]?.id).toBe(item.id);
  expect(store.getItem(item.id)?.text).toBe("feed summary");
  expect(store.getItem(item.id)?.extraction?.text).toContain("distinctive");
  store.close();
});

test("rejects mixed DNS, loopback mappings, oversized, compressed and unsupported pages", async () => {
  let calls = 0;
  const mixed = new HttpContentExtractor(
    async () => ["93.184.216.34", "10.0.0.1"],
    async () => {
      calls++;
      throw Error("must not fetch");
    },
  );
  expect((await mixed.extract("https://example.com")).status).toBe(
    "unavailable",
  );
  expect((await mixed.extract("http://[::ffff:127.0.0.1]/")).status).toBe(
    "unavailable",
  );
  expect(calls).toBe(0);
  const oversized = new HttpContentExtractor(
    async () => ["93.184.216.34"],
    async () => ({
      status: 200,
      headers: { "content-type": "text/html" },
      body: "x".repeat(2_000_001),
    }),
  );
  expect((await oversized.extract("https://example.com")).status).toBe(
    "unavailable",
  );
  const binary = new HttpContentExtractor(
    async () => ["93.184.216.34"],
    async () => ({
      status: 200,
      headers: { "content-type": "application/pdf" },
      body: "pdf",
    }),
  );
  expect((await binary.extract("https://example.com")).status).toBe(
    "unavailable",
  );
});

test("redirect loops and paywall pages are labeled unavailable", async () => {
  let calls = 0;
  const loop = new HttpContentExtractor(
    async () => ["93.184.216.34"],
    async () => {
      calls++;
      return { status: 302, headers: { location: "/again" }, body: "" };
    },
  );
  expect((await loop.extract("https://example.com")).status).toBe(
    "unavailable",
  );
  expect(calls).toBe(6);
  const paywall = new HttpContentExtractor(
    async () => ["93.184.216.34"],
    async () => ({
      status: 200,
      headers: { "content-type": "text/html" },
      body: "<article>Subscribe to continue</article>",
    }),
  );
  expect((await paywall.extract("https://example.com")).status).toBe(
    "unavailable",
  );
});

test("aborts DNS resolution when the request is cancelled", async () => {
  const extractor = new HttpContentExtractor(
    () => new Promise(() => {}),
    async () => {
      throw Error("unexpected");
    },
  );
  const controller = new AbortController();
  const work = extractor.extract("https://example.com", controller.signal);
  controller.abort();
  const result = await work;
  expect(result.status).toBe("unavailable");
});

test("transient provider failures remain retryable", async () => {
  const { Store } = await import("../src/db/store");
  const { ProcessingWorker } = await import("../src/worker");
  const { extractionHandler } = await import("../src/adapters/extraction");
  const store = new Store(":memory:");
  store.addSource("https://example.com/feed");
  store.enqueueDue(1);
  store.complete(
    store.claim(1)!,
    {
      items: [
        {
          nativeId: "a",
          url: "https://example.com/a",
          title: "Alpha",
          text: "feed",
        },
      ],
    },
    2,
  );
  const id = store.search("feed")[0]!.id;
  const extractor = new HttpContentExtractor(
    async () => ["93.184.216.34"],
    async () => ({ status: 503, headers: {}, body: "" }),
  );
  await new ProcessingWorker(store, {
    extract: extractionHandler(store, extractor),
  }).drain("extract");
  expect(store.getItem(id)?.processing[0]?.status).toBe("pending");
  expect(store.getItem(id)?.processing[0]?.last_error).toContain("503");
  store.close();
});

test("FTS follows current extraction through content changes and generation updates", async () => {
  const { Store } = await import("../src/db/store");
  const store = new Store(":memory:");
  store.addSource("https://example.com/feed");
  store.enqueueDue(1);
  store.complete(
    store.claim(1)!,
    { items: [{ nativeId: "a", title: "Alpha", text: "" }] },
    2,
  );
  const id = store.search("Alpha")[0]!.id;
  const job = store.claimProcessing("extract", 3)!;
  store.completeProcessing(
    job,
    "extracted",
    4,
    JSON.stringify({ text: "old extracted" }),
  );
  expect(store.search("extracted")[0]?.id).toBe(id);
  store.sqlite
    .query("UPDATE content SET text=? WHERE item_id=?")
    .run("changed feed", id);
  expect(store.search("extracted")[0]?.id).toBe(id);
  store.enqueueProcessing("extract", id, 5, 2);
  expect(store.search("extracted")).toHaveLength(0);
  expect(store.search("changed")[0]?.id).toBe(id);
  store.close();
});

test("a timed-out resolver cannot accumulate further DNS work", async () => {
  let calls = 0;
  let release!: (addresses: string[]) => void;
  const pending = new Promise<string[]>((resolve) => {
    release = resolve;
  });
  const extractor = new HttpContentExtractor(
    (host) => {
      calls++;
      return host === "first.example"
        ? pending
        : Promise.resolve(["93.184.216.34"]);
    },
    async () => ({
      status: 200,
      headers: { "content-type": "text/plain" },
      body: "healthy",
    }),
  );
  const controller = new AbortController();
  const first = extractor.extract("https://first.example", controller.signal);
  controller.abort();
  await first;
  // A caller arriving while the lookup is still pending shares it rather than
  // starting new DNS work; once it settles the host resolves normally.
  const second = extractor.extract("https://first.example");
  release(["93.184.216.34"]);
  expect((await second).text).toBe("healthy");
  expect((await extractor.extract("https://second.example")).text).toBe(
    "healthy",
  );
  expect(calls).toBe(2);
});

test("concurrent extractions for one host share a single DNS lookup", async () => {
  let calls = 0;
  let release!: (addresses: string[]) => void;
  const pending = new Promise<string[]>((resolve) => {
    release = resolve;
  });
  const extractor = new HttpContentExtractor(
    () => {
      calls++;
      return pending;
    },
    async () => ({
      status: 200,
      headers: { "content-type": "text/plain" },
      body: "shared",
    }),
  );
  const first = extractor.extract("https://same.example/a");
  const second = extractor.extract("https://same.example/b");
  release(["93.184.216.34"]);
  expect((await first).text).toBe("shared");
  expect((await second).text).toBe("shared");
  expect(calls).toBe(1);
});

test("transport connects to the validated address while retaining the original host", async () => {
  const { pinnedTransport } = await import("../src/adapters/extraction");
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) =>
      new Response(req.headers.get("host") ?? "", {
        headers: { "content-type": "text/plain" },
      }),
  });
  try {
    const response = await pinnedTransport(
      new URL(`http://unresolvable.invalid:${server.port}/`),
      "127.0.0.1",
    );
    expect(new TextDecoder().decode(response.body as Uint8Array)).toBe(
      `unresolvable.invalid:${server.port}`,
    );
  } finally {
    server.stop(true);
  }
});

test("transport enforces byte and encoding limits", async () => {
  const { pinnedTransport } = await import("../src/adapters/extraction");
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) =>
      new URL(req.url).pathname === "/compressed"
        ? new Response("compressed", {
            headers: { "content-encoding": "gzip" },
          })
        : new Response("x".repeat(2_000_001)),
  });
  try {
    await expect(
      pinnedTransport(
        new URL(`http://invalid.test:${server.port}/compressed`),
        "127.0.0.1",
      ),
    ).rejects.toThrow("Unsupported content encoding");
    await expect(
      pinnedTransport(
        new URL(`http://invalid.test:${server.port}/large`),
        "127.0.0.1",
      ),
    ).rejects.toThrow("Response too large");
  } finally {
    server.stop(true);
  }
});

test("real transport cancels a stalled response", async () => {
  const { pinnedTransport } = await import("../src/adapters/extraction");
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async () => {
      await blocked;
      return new Response("late");
    },
  });
  try {
    await expect(
      pinnedTransport(
        new URL(`http://invalid.test:${server.port}/`),
        "127.0.0.1",
        AbortSignal.timeout(25),
      ),
    ).rejects.toThrow();
  } finally {
    release();
    server.stop(true);
  }
});

test("private extraction requires an explicitly trusted source feed and matching host", async () => {
  const { Store } = await import("../src/db/store");
  const { ProcessingWorker } = await import("../src/worker");
  const { extractionHandler } = await import("../src/adapters/extraction");
  const store = new Store(":memory:");
  store.addSource("http://intranet.example/feed");
  store.enqueueDue(1);
  store.complete(
    store.claim(1)!,
    {
      items: [
        {
          nativeId: "a",
          url: "http://intranet.example/article",
          title: "Alpha",
          text: "feed",
        },
      ],
    },
    2,
  );
  let calls = 0;
  const extractor = new HttpContentExtractor(
    async () => ["10.0.0.5"],
    async () => {
      calls++;
      return {
        status: 200,
        headers: { "content-type": "text/plain" },
        body: "private article",
      };
    },
  );
  await new ProcessingWorker(store, {
    extract: extractionHandler(store, extractor, [
      "http://intranet.example/feed",
    ]),
  }).drain("extract");
  expect(calls).toBe(1);
  expect(store.search("private article")).toHaveLength(1);
  expect(
    (await extractor.extract("http://intranet.example/article")).status,
  ).toBe("unavailable");
  expect(
    (
      await extractor.extract(
        "http://169.254.169.254/",
        undefined,
        "169.254.169.254",
      )
    ).status,
  ).toBe("unavailable");
  store.close();
});

test("private feed trust does not follow redirects to other origins or grant unrelated feeds", async () => {
  let calls = 0;
  const extractor = new HttpContentExtractor(
    async () => ["10.0.0.5"],
    async () => {
      calls++;
      return {
        status: 302,
        headers: { location: "http://other.example/private" },
        body: "",
      };
    },
  );
  const result = await extractor.extract(
    "http://intranet.example/start",
    undefined,
    "http://intranet.example",
  );
  expect(result.status).toBe("unavailable");
  expect(calls).toBe(1);
  expect(
    (
      await extractor.extract(
        "http://intranet.example:8080/",
        undefined,
        "http://intranet.example",
      )
    ).status,
  ).toBe("unavailable");
  expect(
    (
      await extractor.extract(
        "http://127.0.0.1/",
        undefined,
        "http://127.0.0.1",
      )
    ).status,
  ).toBe("unavailable");
});

test("backup and restore preserve extracted search and provenance", async () => {
  const { Store } = await import("../src/db/store");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "extraction-restore-"));
  const store = new Store(join(dir, "db"));
  try {
    store.addSource("https://example.com/feed");
    store.enqueueDue(1);
    store.complete(
      store.claim(1)!,
      {
        items: [
          {
            nativeId: "a",
            url: "https://example.com/a",
            title: "Alpha",
            text: "feed",
          },
        ],
      },
      2,
    );
    const item = store.search("feed")[0]!;
    store.completeProcessing(
      store.claimProcessing("extract", 3)!,
      "extracted",
      4,
      JSON.stringify({ text: "restored extraction" }),
    );
    const backup = join(dir, "backup");
    store.backup(backup);
    const restored = new Store(backup);
    try {
      expect(restored.search("restored")[0]?.id).toBe(item.id);
      expect(restored.getItem(item.id)?.references).toHaveLength(1);
    } finally {
      restored.close();
    }
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("preserves code indentation and paragraph boundaries", async () => {
  const extractor = new HttpContentExtractor(
    async () => ["93.184.216.34"],
    async () => ({
      status: 200,
      headers: { "content-type": "text/html" },
      body: "<article><h1>Heading</h1><p>Paragraph</p><pre>if (x) {\n  call();\n}</pre></article>",
    }),
  );
  const result = await extractor.extract("https://example.com/");
  expect(result.text).toContain("Heading\n");
  expect(result.text).toContain("\n  call();\n");
});

test("decodes declared charsets and rejects malformed or unsupported bytes", async () => {
  const resolver = async () => ["93.184.216.34"];
  const page = new HttpContentExtractor(resolver, async () => ({
    status: 200,
    headers: { "content-type": "text/html; charset=windows-1252" },
    body: Uint8Array.from([
      ...Buffer.from("<article>caf"),
      0xe9,
      ...Buffer.from("</article>"),
    ]),
  }));
  expect((await page.extract("https://example.com")).text).toBe("café");
  const invalid = new HttpContentExtractor(resolver, async () => ({
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8" },
    body: Uint8Array.from([0xff]),
  }));
  expect((await invalid.extract("https://example.com")).status).toBe(
    "unavailable",
  );
  const unknown = new HttpContentExtractor(resolver, async () => ({
    status: 200,
    headers: { "content-type": "text/plain; charset=unknown-charset" },
    body: Uint8Array.from([65]),
  }));
  expect((await unknown.extract("https://example.com")).status).toBe(
    "unavailable",
  );
});

test("preserves article headers and footers while stripping site boilerplate", async () => {
  const extractor = new HttpContentExtractor(
    async () => ["93.184.216.34"],
    async () => ({
      status: 200,
      headers: { "content-type": "text/html" },
      body: "<html><body><header>Site menu</header><article><header><h1>Article heading</h1><p>By author</p></header><p>Body</p><footer>Sources</footer></article><footer>Site footer</footer></body></html>",
    }),
  );
  const result = await extractor.extract("https://example.com");
  expect(result.text).toContain("Article heading");
  expect(result.text).toContain("Sources");
  expect(result.text).not.toContain("Site menu");
});

test("allows articles about CAPTCHA while rejecting blocking interstitials", async () => {
  const page = new HttpContentExtractor(
    async () => ["93.184.216.34"],
    async () => ({
      status: 200,
      headers: { "content-type": "text/html" },
      body: "<article><h1>Building CAPTCHA</h1><p>Use a captcha variable in your code.</p></article>",
    }),
  );
  expect((await page.extract("https://example.com")).status).toBe("extracted");
  const blocked = new HttpContentExtractor(
    async () => ["93.184.216.34"],
    async () => ({
      status: 200,
      headers: { "content-type": "text/html" },
      body: "<html><body><form>Verify you are human to continue</form></body></html>",
    }),
  );
  expect((await blocked.extract("https://example.com")).status).toBe(
    "unavailable",
  );
});

test("a pre-aborted signal observes an already rejected transport promise", async () => {
  const errors: unknown[] = [];
  const listener = (error: unknown) => {
    errors.push(error);
  };
  process.on("unhandledRejection", listener);
  try {
    const page = new HttpContentExtractor(
      async () => ["93.184.216.34"],
      () => Promise.reject(new Error("aborted transport")),
    );
    const controller = new AbortController();
    controller.abort();
    expect(
      (await page.extract("http://93.184.216.34", controller.signal)).status,
    ).toBe("unavailable");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(errors).toEqual([]);
  } finally {
    process.off("unhandledRejection", listener);
  }
});

test("HTML meta charset is recognized and BOM overrides conflicting headers", async () => {
  const resolver = async () => ["93.184.216.34"];
  const meta = new HttpContentExtractor(resolver, async () => ({
    status: 200,
    headers: { "content-type": "text/html" },
    body: Uint8Array.from([
      ...Buffer.from('<meta charset="windows-1252"><article>caf'),
      0xe9,
      ...Buffer.from("</article>"),
    ]),
  }));
  expect((await meta.extract("https://example.com")).text).toBe("café");
  const bom = new HttpContentExtractor(resolver, async () => ({
    status: 200,
    headers: { "content-type": "text/plain; charset=windows-1252" },
    body: Uint8Array.from([0xef, 0xbb, 0xbf, ...Buffer.from("café")]),
  }));
  expect((await bom.extract("https://example.com")).text).toBe("café");
});
