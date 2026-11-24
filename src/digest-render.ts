/** Content and source references are untrusted. A missing URL is a valid citation. */
export interface DigestRenderItem {
  itemId: string;
  title: string;
  why: string;
  summary: string | null;
  keyPoints?: string[];
  uncertainty: string[];
  references: {
    source: string;
    nativeId: string;
    url: string | null;
    /** Cited item's title, used as the link text when it differs from the story title. */
    title?: string;
  }[];
  /** Links fanned out from a roundup parent, shown attributed beneath it. */
  roundup?: { url: string; title: string }[];
}
export interface RenderedDigest {
  subject: string;
  html: string;
  text: string;
  feedbackTargets: { itemId: string; actions: ("useful" | "not_useful")[] }[];
}
function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c]!,
  );
}
function publicUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") &&
      !url.username &&
      !url.password
      ? value
      : null;
  } catch {
    return null;
  }
}
/** Roundup links shown under a parent. Bounded so one roundup cannot flood the edition. */
const MAX_ROUNDUP_LINKS = 12;
/** Up to five claim statements, trimmed, so the email reads as a concise list of key points. */
function keyPointList(values: string[] | undefined): string[] {
  return (values ?? [])
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, 5)
    .map((value) => (value.length > 240 ? `${value.slice(0, 237)}...` : value));
}
/** Public, distinct roundup links with readable labels; anything without a safe URL is dropped. */
function roundupLinks(
  values: DigestRenderItem["roundup"],
): { url: string; label: string }[] {
  const seen = new Set<string>();
  const links: { url: string; label: string }[] = [];
  for (const value of values ?? []) {
    const url = publicUrl(value.url);
    if (!url) continue;
    const key = new URL(url).href;
    if (seen.has(key)) continue;
    seen.add(key);
    const title = value.title.replace(/\s+/g, " ").trim();
    links.push({
      url,
      label: title || new URL(url).hostname.replace(/^www\./, ""),
    });
    if (links.length >= MAX_ROUNDUP_LINKS) break;
  }
  return links;
}
/** Keep the email summary to at most three sentences and roughly 600 characters. */
function displaySummary(value: string): string {
  const sentences = value
    .trim()
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  const kept: string[] = [];
  let length = 0;
  for (const sentence of sentences) {
    if (kept.length >= 3) break;
    if (kept.length > 0 && length + sentence.length > 600) break;
    kept.push(sentence);
    length += sentence.length + 1;
  }
  return kept.join(" ") || value.trim();
}
/**
 * A heading that is only a URL reads as a raw link. Show the host and path
 * instead, so the reader sees a source rather than an address.
 */
function readableTitle(title: string): string {
  const value = title.replace(/\s+/g, " ").trim();
  if (!/^(?:https?:\/\/|www\.)\S+$/i.test(value)) return value;
  try {
    const url = new URL(/^https?:/i.test(value) ? value : `https://${value}`);
    const path = url.pathname.replace(/\/+$/, "").replace(/\.(html?)$/i, "");
    const host = url.hostname.replace(/^www\./, "");
    const segment = path.split("/").filter(Boolean).pop();
    return segment ? `${segment.replace(/[-_]+/g, " ")} — ${host}` : host;
  } catch {
    return value;
  }
}

/** Split a model summary into short paragraphs for reading, without changing its words. */
function summaryParagraphs(value: string): string[] {
  const explicit = value
    .split(/\r?\n\s*\r?\n/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (explicit.length > 1) return explicit;
  const sentences = value
    .trim()
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const chunks: string[] = [];
  for (let i = 0; i < sentences.length; i += 3)
    chunks.push(sentences.slice(i, i + 3).join(" "));
  return chunks.filter(Boolean);
}
/** The email leads with a short list, then a longer section, as a readable daily brief. */
const TOP_STORIES = 5;
/** Pure renderer. No feedback links are fabricated; delivery may provide scoped links later. */
export function renderDigest(
  date: string,
  items: DigestRenderItem[],
): RenderedDigest {
  const subject = `Newspulse — ${date}`;
  const renderHtml = (item: DigestRenderItem) => {
    const primary =
      item.references.map((ref) => publicUrl(ref.url)).find(Boolean) ?? null;
    const title = readableTitle(item.title);
    const heading = primary
      ? `<h3><a href="${escapeHtml(primary)}">${escapeHtml(title)}</a></h3>`
      : `<h3>${escapeHtml(title)}</h3>`;
    const paragraphs = item.summary
      ? summaryParagraphs(displaySummary(item.summary))
          .map((p) => `<p>${escapeHtml(p)}</p>`)
          .join("")
      : "";
    const points = keyPointList(item.keyPoints);
    const keyPoints = points.length
      ? `<ul>${points.map((value) => `<li>${escapeHtml(value)}</li>`).join("")}</ul>`
      : "";
    const roundup = roundupLinks(item.roundup);
    const roundupHtml = roundup.length
      ? `<p style="color:#666;font-size:13px;margin:8px 0 0">From this roundup</p><ul style="font-size:14px">${roundup
          .map(
            ({ url, label }) =>
              `<li><a href="${escapeHtml(url)}">${escapeHtml(label)}</a></li>`,
          )
          .join("")}</ul>`
      : "";
    // Delivery injects scoped feedback links between these stable markers;
    // the frozen body itself never carries a token.
    return `<article data-item-id="${escapeHtml(item.itemId)}">${heading}${paragraphs}${keyPoints}${roundupHtml}<!--np:feedback:${escapeHtml(item.itemId)}:start--><!--np:feedback:${escapeHtml(item.itemId)}:end--></article>`;
  };
  const renderText = (item: DigestRenderItem) => {
    return [
      readableTitle(item.title),
      item.summary ? displaySummary(item.summary) : null,
      keyPointList(item.keyPoints).length
        ? keyPointList(item.keyPoints)
            .map((value) => `- ${value}`)
            .join("\n")
        : null,
      roundupLinks(item.roundup).length
        ? `From this roundup:\n${roundupLinks(item.roundup)
            .map(({ url, label }) => `- ${label} — ${url}`)
            .join("\n")}`
        : null,
    ]
      .filter(Boolean)
      .join("\n");
  };
  const top = items.slice(0, TOP_STORIES);
  const rest = items.slice(TOP_STORIES);
  const section = (heading: string, values: DigestRenderItem[]) =>
    values.length
      ? `<h2 style="font-size:18px;border-bottom:1px solid #ddd;padding-bottom:4px">${heading}</h2>${values.map(renderHtml).join("<hr>")}`
      : "";
  const textSection = (heading: string, values: DigestRenderItem[]) =>
    values.length ? [heading, ...values.map(renderText)].join("\n\n") : "";
  return {
    subject,
    html: `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:640px;margin:0 auto;line-height:1.5;color:#111"><h1 style="font-size:22px">${escapeHtml(subject)}</h1>${rest.length ? `${section("Top Stories", top)}${section("More Coverage", rest)}` : top.map(renderHtml).join("<hr>")}</body></html>`,
    text: [
      subject,
      rest.length
        ? `${textSection("Top Stories", top)}\n\n${textSection("More Coverage", rest)}`
        : top.map(renderText).join("\n\n"),
    ].join("\n\n"),
    feedbackTargets: items.map(({ itemId }) => ({
      itemId,
      actions: ["useful", "not_useful"],
    })),
  };
}
