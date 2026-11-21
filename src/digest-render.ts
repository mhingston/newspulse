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
/** Show at most three uncertainty notes, each trimmed to a short line, so verbose model output stays readable. */
function caveatNotes(values: string[]): string[] {
  return values
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, 3)
    .map((value) => (value.length > 200 ? `${value.slice(0, 197)}...` : value));
}
/** Up to three claim statements, trimmed, so the email reads as a short list of key points. */
function keyPointList(values: string[] | undefined): string[] {
  return (values ?? [])
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, 3)
    .map((value) => (value.length > 240 ? `${value.slice(0, 237)}...` : value));
}
/**
 * Link text captured from a page is often a label rather than a headline
 * ("published", "repeated", "read more"). Only a title that reads like one is
 * used as link text; anything else falls back to the readable URL.
 */
function plausibleTitle(value: string | undefined): string | undefined {
  const title = value?.trim();
  if (!title || title.split(/\s+/).length < 2) return undefined;
  return /^[A-Z0-9]/.test(title) ? title : undefined;
}
/** Link text for a cited source: its own title when distinct, else the readable URL label. */
function referenceLabel(
  ref: { title?: string; url: string },
  storyTitle: string,
): string {
  const title = plausibleTitle(ref.title);
  return title && title !== storyTitle ? title : linkLabel(ref.url);
}
/**
 * One entry per page. Grouped stories cite the same article through several
 * URLs that differ only by tracking parameters or an anchor, and repeating
 * them makes the source list look broken.
 */
function uniqueReferences(
  references: DigestRenderItem["references"],
): DigestRenderItem["references"] {
  const seen = new Set<string>();
  return references.filter((ref) => {
    const url = publicUrl(ref.url);
    if (!url) {
      const key = `none:${ref.source}:${ref.nativeId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }
    const parsed = new URL(url);
    const key = `${parsed.hostname.replace(/^www\./, "")}${parsed.pathname.replace(/\/$/, "")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
/** A citation with no public link keeps its source name and native id so it stays traceable. */
function unlinkedLabel(ref: { source: string; nativeId: string }): string {
  return `${ref.source} (${ref.nativeId})`;
}
/** Readable label for a public link: host plus path, without query noise. */
function linkLabel(url: string): string {
  const parsed = new URL(url);
  const path =
    parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/$/, "");
  return `${parsed.hostname.replace(/^www\./, "")}${path}`;
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
    const links = uniqueReferences(item.references).map((ref) => ({
      ref,
      url: publicUrl(ref.url),
    }));
    const primary = links.find((link) => link.url)?.url ?? null;
    const heading = primary
      ? `<h3><a href="${escapeHtml(primary)}">${escapeHtml(item.title)}</a></h3>`
      : `<h3>${escapeHtml(item.title)}</h3>`;
    const paragraphs = item.summary
      ? summaryParagraphs(displaySummary(item.summary))
          .map((p) => `<p>${escapeHtml(p)}</p>`)
          .join("")
      : "";
    const points = keyPointList(item.keyPoints);
    const keyPoints = points.length
      ? `<ul>${points.map((value) => `<li>${escapeHtml(value)}</li>`).join("")}</ul>`
      : "";
    const caveats = caveatNotes(item.uncertainty).length
      ? `<p style="color:#666;font-size:13px;margin:8px 0 0">Caveats</p><ul style="color:#666;font-size:13px">${caveatNotes(
          item.uncertainty,
        )
          .map((value) => `<li>${escapeHtml(value)}</li>`)
          .join("")}</ul>`
      : "";
    const sourceList = links
      .map(({ ref, url }) =>
        url
          ? `<li><a href="${escapeHtml(url)}">${escapeHtml(referenceLabel({ title: ref.title, url }, item.title))}</a></li>`
          : `<li><span>${escapeHtml(unlinkedLabel(ref))}</span></li>`,
      )
      .join("");
    const sources = sourceList
      ? `<p style="color:#666;font-size:13px;margin:8px 0 0">Sources</p><ul style="font-size:13px">${sourceList}</ul>`
      : "";
    // Delivery injects scoped feedback links between these stable markers;
    // the frozen body itself never carries a token.
    return `<article data-item-id="${escapeHtml(item.itemId)}">${heading}${paragraphs}${keyPoints}${caveats}${sources}<!--np:feedback:${escapeHtml(item.itemId)}:start--><!--np:feedback:${escapeHtml(item.itemId)}:end--></article>`;
  };
  const renderText = (item: DigestRenderItem) => {
    const refs = uniqueReferences(item.references)
      .map((ref) => {
        const url = publicUrl(ref.url);
        if (!url) return unlinkedLabel(ref);
        const label = referenceLabel({ title: ref.title, url }, item.title);
        // Only prefix a distinct title; a bare URL stays as it was.
        return label === linkLabel(url) ? url : `${label} — ${url}`;
      })
      .join("; ");
    return [
      item.title,
      item.summary ? displaySummary(item.summary) : null,
      keyPointList(item.keyPoints).length
        ? keyPointList(item.keyPoints)
            .map((value) => `- ${value}`)
            .join("\n")
        : null,
      caveatNotes(item.uncertainty).length
        ? `Caveats:\n${caveatNotes(item.uncertainty)
            .map((value) => `- ${value}`)
            .join("\n")}`
        : null,
      `Sources: ${refs}`,
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
