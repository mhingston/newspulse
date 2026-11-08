import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import { parseHTML } from "linkedom";
import { resolvedUrl } from "../domain";

export type Extraction = {
  status: "extracted" | "unavailable";
  text?: string;
  resolvedUrl?: string;
  reason?: string;
  retryable?: boolean;
  method?: string;
};
export interface ContentExtractor {
  extract(
    url: string,
    signal?: AbortSignal,
    trustedOrigin?: string,
  ): Promise<Extraction>;
}
type Resolver = (host: string) => Promise<string[]>;
type Reply = {
  status: number;
  headers: Record<string, string | undefined>;
  body: string;
};
type Transport = (
  url: URL,
  address: string,
  signal?: AbortSignal,
) => Promise<Reply>;
const MAX_BYTES = 2_000_000;
class PermanentExtractionError extends Error {}
const resolve: Resolver = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map((row) => row.address);
function publicAddress(value: string, allowPrivate = false): boolean {
  try {
    const parsed = ipaddr.process(value);
    return (
      parsed.range() === "unicast" ||
      (allowPrivate && ["private", "uniqueLocal"].includes(parsed.range()))
    );
  } catch {
    return false;
  }
}
export const pinnedTransport: Transport = (url, address, signal) =>
  new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        family: isIP(address),
        headers: {
          accept: "text/html, text/plain;q=0.8",
          "accept-encoding": "identity",
        },
        lookup: (_hostname, _options, callback) =>
          callback(null, address, isIP(address) as 4 | 6),
        signal,
      },
      (response) => {
        const encoding = response.headers["content-encoding"];
        if (encoding && encoding !== "identity") {
          response.destroy();
          reject(new PermanentExtractionError("Unsupported content encoding"));
          return;
        }
        let size = 0;
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BYTES) {
            response.destroy(
              new PermanentExtractionError("Response too large"),
            );
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: {
              "content-type": response.headers["content-type"],
              location: response.headers.location,
            },
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.setTimeout(15_000, () =>
      request.destroy(new Error("Request timed out")),
    );
    request.on("error", reject);
    request.end();
  });
async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Error("Request aborted");
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("Request aborted"));
    signal.addEventListener("abort", abort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}
class RetryableExtractionError extends Error {}
export class HttpContentExtractor implements ContentExtractor {
  private resolving = new Set<string>();
  constructor(
    private resolver: Resolver = resolve,
    private transport: Transport = pinnedTransport,
  ) {}
  async extract(
    input: string,
    signal?: AbortSignal,
    trustedOrigin?: string,
  ): Promise<Extraction> {
    try {
      const deadline = signal
        ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
        : AbortSignal.timeout(15_000);
      let url = new URL(resolvedUrl(input));
      for (let redirects = 0; redirects <= 5; redirects++) {
        const host = url.hostname.replace(/^\[|\]$/g, "");
        let addresses: string[];
        if (isIP(host)) addresses = [host];
        else {
          if (this.resolving.size >= 4 || this.resolving.has(host))
            throw new RetryableExtractionError("DNS resolver busy");
          this.resolving.add(host);
          const pending = Promise.resolve().then(() => this.resolver(host));
          void pending.then(
            () => {
              this.resolving.delete(host);
            },
            () => {
              this.resolving.delete(host);
            },
          );
          try {
            addresses = await abortable(pending, deadline);
          } catch (error) {
            throw new RetryableExtractionError(`DNS: ${String(error)}`);
          }
        }
        if (
          !addresses.length ||
          addresses.some((a) => !publicAddress(a, url.origin === trustedOrigin))
        )
          throw new Error("Destination is not public");
        let response: Reply;
        try {
          response = await abortable(
            this.transport(url, addresses[0]!, deadline),
            deadline,
          );
        } catch (error) {
          if (error instanceof PermanentExtractionError) throw error;
          throw new RetryableExtractionError(`Transport: ${String(error)}`);
        }
        if (
          response.status >= 300 &&
          response.status < 400 &&
          response.headers.location
        ) {
          url = new URL(resolvedUrl(response.headers.location, url.href));
          if (trustedOrigin && url.origin !== trustedOrigin)
            trustedOrigin = undefined;
          continue;
        }
        if (response.status === 429 || response.status >= 500)
          throw new RetryableExtractionError(`HTTP ${response.status}`);
        if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
        if (response.body.length > MAX_BYTES)
          throw new Error("Response too large");
        const type = response.headers["content-type"]
          ?.split(";")[0]
          ?.toLowerCase();
        if (type !== "text/html" && type !== "text/plain")
          throw new Error("Unsupported content type");
        let text = response.body;
        if (type === "text/html") {
          const { document } = parseHTML(response.body);
          for (const node of document.querySelectorAll(
            "script,style,nav,header,footer,aside,form,iframe",
          ))
            node.remove();
          const root = document.querySelector("article,main") ?? document.body;
          const read = (node: Node): string => {
            if (node.nodeType === 3) return node.textContent ?? "";
            const body = Array.from(node.childNodes, read).join("");
            return node.nodeType === 1 &&
              /^(P|H[1-6]|DIV|PRE|LI|BR|BLOCKQUOTE)$/.test(
                (node as Element).tagName,
              )
              ? `\n${body}\n`
              : body;
          };
          text = root ? read(root) : "";
        }
        text = text
          .replace(/\r/g, "")
          .replace(/\n{3,}/g, "\n\n")
          .trim();
        if (
          !text ||
          /\b(captcha|verify you are human|subscribe to continue)\b/i.test(text)
        )
          throw new Error("Page unavailable");
        return {
          status: "extracted",
          text,
          resolvedUrl: url.href,
          method: "http",
        };
      }
      throw new Error("Too many redirects");
    } catch (e) {
      return {
        status: "unavailable",
        reason: e instanceof Error ? e.message : String(e),
        retryable: e instanceof RetryableExtractionError,
      };
    }
  }
}
export class DisabledBrowserExtractor implements ContentExtractor {
  async extract(): Promise<Extraction> {
    return { status: "unavailable", reason: "Browser extraction disabled" };
  }
}

export function extractionHandler(
  store: import("../db/store").Store,
  extractor: ContentExtractor,
  trustedFeeds: string[] = [],
): import("../worker").ProcessingHandler {
  return async (job, signal) => {
    const item = store.getItem(job.item_id);
    if (!item?.url)
      return {
        status: "unavailable",
        result: JSON.stringify({
          status: "unavailable",
          reason: "No public URL",
          method: "http",
          at: Date.now(),
        }),
      };
    const references = item.references as {
      url: string | null;
      feed_url: string;
    }[];
    const entry = references.find((entry) => entry.url) ?? references[0];
    const reference = entry?.url ?? item.url;
    const trustedOrigin =
      entry &&
      trustedFeeds.includes(entry.feed_url) &&
      new URL(reference).origin === new URL(entry.feed_url).origin
        ? new URL(entry.feed_url).origin
        : undefined;
    const extraction = await extractor.extract(
      reference,
      signal,
      trustedOrigin,
    );
    if (extraction.retryable)
      throw new Error(extraction.reason ?? "Temporary extraction failure");
    const hash = extraction.text
      ? new Bun.CryptoHasher("sha256").update(extraction.text).digest("hex")
      : undefined;
    return {
      status: extraction.status,
      result: JSON.stringify({
        ...extraction,
        sourceUrl: reference,
        hash,
        at: Date.now(),
      }),
    };
  };
}
