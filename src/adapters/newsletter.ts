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
const advertisingHosts =
  /(?:^|\.)(?:doubleclick\.net|googlesyndication\.com|googleadservices\.com|adservice\.google\.com|adnxs\.com|taboola\.com|outbrain\.com)$/i;
const platformChromeUrl =
  /^\/(?:confirm|unsubscribe|welcome|subscribe)(?:[\/_.?=&-]|$)/i;
const socialProfileHosts =
  /(?:^|\.)(?:linkedin\.com|x\.com|twitter\.com|facebook\.com|instagram\.com|youtube\.com|threads\.net|bsky\.app)$/i;
const genericLabel =
  /^(?:here|click here|sign up here|read more|read here|view|latest issue|access all our playbooks here|view image|confirm subscription|powered by.*|linkedin|x|twitter|facebook|instagram|youtube|threads|bluesky|join the discussion|more on our site|discussion|comments?|reply|share|forward|view online|browse the archive)$/i;

/**
 * Plain-text newsletters often carry a whole markdown line as the label.
 * Split it into readable parts so a run of CTAs cannot become an item title.
 */
function labelParts(label: string): string[] {
  return label
    .replace(/!?\[([^\]]*)\]\([^)]*\)?/g, "$1")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/[\[\]()]/g, " ")
    .split(/[·|•]+/)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function wrapper(parsed: URL): "google" | "facebook" | undefined {
  if (
    /^(?:www\.)?google\.com$/i.test(parsed.hostname) &&
    parsed.pathname === "/url"
  )
    return "google";
  if (
    /^(?:l|lm)\.facebook\.com$/i.test(parsed.hostname) &&
    parsed.pathname === "/l.php"
  )
    return "facebook";
  return undefined;
}

function queryIsChrome(parsed: URL): boolean {
  const action =
    /^(?:unsubscribe|opt[-_]?out|manage[-_]?(?:preferences|subscription)|preferences)$/i;
  for (const [key, value] of parsed.searchParams) {
    if (action.test(key) || action.test(value)) return true;
  }
  return false;
}

function trimUrlPunctuation(raw: string): string {
  const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  const counts: Record<string, number> = {};
  for (const char of raw)
    if ("()[]{}".includes(char)) counts[char] = (counts[char] ?? 0) + 1;
  let end = raw.length;
  while (end > 0) {
    const char = raw[end - 1]!;
    if (/[.,;!?]/.test(char)) {
      end--;
      continue;
    }
    const opening = pairs[char];
    if (opening && (counts[char] ?? 0) > (counts[opening] ?? 0)) {
      counts[char]!--;
      end--;
      continue;
    }
    break;
  }
  return raw.slice(0, end);
}

function isProfileRoot(parsed: URL): boolean {
  return (
    socialProfileHosts.test(parsed.hostname) &&
    parsed.pathname.split("/").filter(Boolean).length <= 1
  );
}

function destination(
  raw: string,
): { sourceUrl: string; url: string } | undefined {
  try {
    const sourceUrl = resolvedUrl(raw);
    let parsed = new URL(sourceUrl);
    // Only documented, named wrappers are unwrapped; no redirect requests are made.
    for (let i = 0; i < 2; i++) {
      if (queryIsChrome(parsed)) return undefined;
      const kind = wrapper(parsed);
      if (!kind) break;
      const target =
        parsed.searchParams.get(kind === "google" ? "q" : "u") ??
        (kind === "google" ? parsed.searchParams.get("url") : null);
      if (!target) return undefined;
      parsed = new URL(resolvedUrl(target));
    }
    if (
      wrapper(parsed) ||
      opaqueTrackers.test(parsed.hostname) ||
      advertisingHosts.test(parsed.hostname) ||
      chromeUrl.test(decodeURIComponent(parsed.pathname)) ||
      platformChromeUrl.test(decodeURIComponent(parsed.pathname)) ||
      isProfileRoot(parsed) ||
      queryIsChrome(parsed)
    )
      return undefined;
    const cleaned = new URL(parsed.href);
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
  const consider = (raw: string, rawLabel: string) => {
    const parts = labelParts(rawLabel);
    // A line made only of CTAs is navigation, not an item.
    if (
      parts.length > 0 &&
      parts.every((part) => chrome.test(part) || genericLabel.test(part))
    )
      return;
    const label = parts.join(" ");
    if (label && (chrome.test(label) || genericLabel.test(label))) return;
    const link = destination(raw);
    if (link && !children.has(link.url))
      children.set(link.url, {
        ...link,
        title: label.slice(0, MAX_TITLE) || link.url,
      });
  };
  const parsePlain = () => {
    const clean = plain
      .split(/\r?\n/)
      .filter((line) => !chrome.test(line))
      .join("\n")
      .trim();
    for (const line of clean.split(/\r?\n/)) {
      for (const match of line.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
        if (scanned >= MAX_LINKS_SCANNED || children.size >= MAX_CHILDREN) {
          linksTruncated = true;
          break;
        }
        scanned++;
        const raw = trimUrlPunctuation(match[0]);
        consider(raw, line.replace(match[0], "").trim());
      }
      if (scanned >= MAX_LINKS_SCANNED || children.size >= MAX_CHILDREN) break;
    }
    return clean;
  };
  let text = plain;
  if (html.trim()) {
    // linkedom does not populate document.body for standalone HTML fragments.
    const { document } = parseHTML(
      /<html(?:\s|>)/i.test(html) ? html : `<html><body>${html}</body></html>`,
    );
    for (const element of document.querySelectorAll(
      "script,style,noscript,nav,footer,form,svg",
    ))
      element.remove();
    for (const anchor of document.querySelectorAll("a[href]")) {
      if (scanned >= MAX_LINKS_SCANNED || children.size >= MAX_CHILDREN) {
        linksTruncated = true;
        break;
      }
      scanned++;
      const label = (anchor.textContent ?? "").replace(/\s+/g, " ").trim();
      const href = anchor.getAttribute("href") ?? "";
      const attrs = `${anchor.getAttribute("class") ?? ""} ${anchor.getAttribute("id") ?? ""} ${anchor.getAttribute("aria-label") ?? ""}`;
      if (
        !label ||
        chrome.test(`${label} ${attrs}`) ||
        genericLabel.test(label)
      ) {
        anchor.remove();
        continue;
      }
      consider(href, label);
    }
    // textContent concatenates adjacent elements in linkedom, which can join
    // words across paragraph and link boundaries and make them unsearchable.
    for (const element of document.querySelectorAll(
      "p,div,br,li,blockquote,h1,h2,h3,h4,h5,h6,section,article,tr,a",
    )) {
      element.insertBefore(document.createTextNode(" "), element.firstChild);
      element.appendChild(document.createTextNode(" "));
    }
    const htmlText = (document.body?.textContent || document.textContent || "")
      .replace(/\s+/g, " ")
      .trim();
    text = htmlText || parsePlain();
  } else {
    // Plain-text newsletters often include a label on the same line as each URL.
    text = parsePlain();
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
    bodyUnavailable: !text.trim(),
    linksTruncated,
  };
}
