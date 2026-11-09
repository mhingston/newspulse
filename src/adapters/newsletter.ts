import { parseHTML } from "linkedom";
import { canonicalUrl, resolvedUrl, type Candidate } from "../domain";
import type { ReceivedEmail } from "../inbound";

// Bounds apply before parsing as well as to the number of extraction jobs produced.
const MAX_BODY = 2_000_000;
const MAX_LINKS_SCANNED = 500;
const MAX_CHILDREN = 50;
const MAX_TITLE = 500;

const chrome =
  /\b(unsubscribe|opt[ -]?out|manage (?:your )?(?:preferences|subscription)|email preferences|privacy policy|view (?:this )?(?:email|newsletter) in (?:your )?browser|advertisement|sponsored|follow us|share this|subscribe now)\b/i;
const chromeUrl =
  /(?:^|[\/_.-])(unsubscribe|optout|preferences|tracking|track|pixel|beacon|advert|ads)(?:[\/_.?=&-]|$)/i;
const opaqueTrackers =
  /(?:^|\.)(?:list-manage\.com|mailchi\.mp|click\.redditmail\.com|email\.mg\.substack\.com)$/i;

function destination(
  raw: string,
): { sourceUrl: string; url: string } | undefined {
  try {
    let sourceUrl = resolvedUrl(raw);
    let parsed = new URL(sourceUrl);
    // Only documented, named wrappers are unwrapped; no redirect requests are made.
    for (let i = 0; i < 2; i++) {
      const google =
        /^(?:www\.)?google\.com$/i.test(parsed.hostname) &&
        parsed.pathname === "/url";
      const facebook =
        /^(?:l|lm)\.facebook\.com$/i.test(parsed.hostname) &&
        parsed.pathname === "/l.php";
      if (!google && !facebook) break;
      const target =
        parsed.searchParams.get(google ? "q" : "u") ??
        (google ? parsed.searchParams.get("url") : null);
      if (!target) return undefined;
      sourceUrl = resolvedUrl(target);
      parsed = new URL(sourceUrl);
    }
    if (opaqueTrackers.test(parsed.hostname) || chromeUrl.test(parsed.pathname))
      return undefined;
    const cleaned = new URL(sourceUrl);
    for (const key of [...cleaned.searchParams.keys()])
      if (/^(?:mc_cid|mc_eid|mkt_tok|_hsenc|_hsmi)$/i.test(key))
        cleaned.searchParams.delete(key);
    return { sourceUrl, url: canonicalUrl(cleaned.href) };
  } catch {
    return undefined;
  }
}

/** Treat all email markup and text as untrusted data; never fetch redirect wrappers. */
export function normalizeNewsletter(email: ReceivedEmail): {
  candidate: Candidate;
  bodyUnavailable: boolean;
  linksTruncated: boolean;
} {
  const html = email.html?.slice(0, MAX_BODY) ?? "";
  const plain = email.text?.slice(0, MAX_BODY) ?? "";
  const children = new Map<
    string,
    { url: string; sourceUrl: string; title: string }
  >();
  let scanned = 0;
  let linksTruncated =
    (email.html?.length ?? 0) > MAX_BODY ||
    (email.text?.length ?? 0) > MAX_BODY;
  const consider = (raw: string, label: string) => {
    scanned++;
    if (scanned > MAX_LINKS_SCANNED || children.size >= MAX_CHILDREN) {
      linksTruncated = true;
      return;
    }
    if (chrome.test(label)) return;
    const link = destination(raw);
    if (link && !children.has(link.url))
      children.set(link.url, {
        ...link,
        title: label.trim().slice(0, MAX_TITLE) || link.url,
      });
  };
  let text = plain;
  if (html.trim()) {
    const { document } = parseHTML(html);
    for (const element of document.querySelectorAll(
      "script,style,noscript,nav,footer,form,svg",
    ))
      element.remove();
    for (const anchor of document.querySelectorAll("a[href]")) {
      if (scanned >= MAX_LINKS_SCANNED || children.size >= MAX_CHILDREN) {
        linksTruncated = true;
        break;
      }
      const label = (anchor.textContent ?? "").replace(/\s+/g, " ").trim();
      const href = anchor.getAttribute("href") ?? "";
      const attrs = `${anchor.getAttribute("class") ?? ""} ${anchor.getAttribute("id") ?? ""} ${anchor.getAttribute("aria-label") ?? ""}`;
      if (!label || chrome.test(`${label} ${attrs}`) || chromeUrl.test(href)) {
        anchor.remove();
        continue;
      }
      consider(href, label);
    }
    text = (document.body?.textContent || document.textContent || plain)
      .replace(/\s+/g, " ")
      .trim();
  } else {
    // Plain-text newsletters often include a label on the same line as each URL.
    text = plain
      .split(/\r?\n/)
      .filter((line) => !chrome.test(line))
      .join("\n")
      .trim();
    for (const line of text.split(/\r?\n/)) {
      for (const match of line.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
        if (scanned >= MAX_LINKS_SCANNED || children.size >= MAX_CHILDREN) {
          linksTruncated = true;
          break;
        }
        const raw = match[0].replace(/[.,;!?\])}]+$/, "");
        consider(raw, line.replace(match[0], "").trim());
      }
      if (scanned >= MAX_LINKS_SCANNED || children.size >= MAX_CHILDREN) break;
    }
  }
  return {
    candidate: {
      nativeId: email.metadata.providerId,
      title:
        email.metadata.subject.trim().slice(0, MAX_TITLE) ||
        "Untitled newsletter",
      text,
      children: [...children.values()],
    },
    bodyUnavailable: !html.trim() && !plain.trim(),
    linksTruncated,
  };
}
