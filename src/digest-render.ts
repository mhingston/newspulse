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
/** Reader-facing match note: interest reasons ("interest:<id>@<v>: <terms>") keep only their terms. */
function matchNote(why: string): string {
  const terms = why
    .split(";")
    .map((part) => part.trim())
    .map((part) => part.match(/^interest:[^:]+:\s*(.+)$/)?.[1] ?? part)
    .filter(Boolean)
    .join(", ");
  return terms ? `Matched your interest: ${terms}` : why;
}
/** Up to three claim statements, trimmed, so the email reads as a short list of key points. */
function keyPointList(values: string[] | undefined): string[] {
  return (values ?? [])
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, 3)
    .map((value) => (value.length > 240 ? `${value.slice(0, 237)}...` : value));
}
/** Link text for a cited source: its own title when distinct, else the readable URL label. */
function referenceLabel(
  ref: { title?: string; url: string },
  storyTitle: string,
): string {
  const title = ref.title?.trim();
  return title && title !== storyTitle ? title : linkLabel(ref.url);
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
  const sentences =
    value
      .trim()
      .match(/[^.!?]+(?:[.!?]+|$)/g)
      ?.map((sentence) => sentence.trim())
      .filter(Boolean) ?? [];
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
    .match(/[^.!?]+(?:[.!?]+|$)/g)
    ?.map((s) => s.trim())
    .filter(Boolean) ?? [value.trim()];
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
    const links = item.references.map((ref) => ({
      ref,
      url: publicUrl(ref.url),
    }));
    const primary = links.find((link) => link.url)?.url ?? null;
    const heading = primary
      ? `<h2><a href="${escapeHtml(primary)}">${escapeHtml(item.title)}</a></h2>`
      : `<h2>${escapeHtml(item.title)}</h2>`;
    const paragraphs = item.summary
      ? `<p style="color:#666;font-size:12px;margin:0">Model summary (estimate)</p>${summaryParagraphs(
          displaySummary(item.summary),
        )
          .map((p) => `<p>${escapeHtml(p)}</p>`)
          .join("")}`
      : "";
    const points = keyPointList(item.keyPoints);
    const keyPoints = points.length
      ? `<p style="color:#666;font-size:12px;margin:0">Key points</p><ul>${points.map((value) => `<li>${escapeHtml(value)}</li>`).join("")}</ul>`
      : "";
    const caveats = caveatNotes(item.uncertainty).length
      ? `<p style="color:#666;font-size:12px;margin:0">Model uncertainty:</p><ul>${caveatNotes(
          item.uncertainty,
        )
          .map((value) => `<li>${escapeHtml(value)}</li>`)
          .join("")}</ul>`
      : "";
    const sourceList = links
      .map(({ ref, url }) =>
        url
          ? `<li><a href="${escapeHtml(url)}">${escapeHtml(referenceLabel({ title: ref.title, url }, item.title))}</a></li>`
          : `<li><span>${escapeHtml(`${ref.source} (${ref.nativeId})`)}</span></li>`,
      )
      .join("");
    const sources = sourceList
      ? `<p style="color:#666;font-size:12px;margin:0">Sources</p><ul>${sourceList}</ul>`
      : "";
    // Delivery injects scoped feedback links between these stable markers;
    // the frozen body itself never carries a token.
    return `<article data-item-id="${escapeHtml(item.itemId)}">${heading}${paragraphs}${keyPoints}${caveats}<p style="color:#444">${escapeHtml(matchNote(item.why))}</p>${sources}<!--np:feedback:${escapeHtml(item.itemId)}:start--><!--np:feedback:${escapeHtml(item.itemId)}:end--></article>`;
  };
  const renderText = (item: DigestRenderItem) => {
    const refs = item.references
      .map((ref) => {
        const url = publicUrl(ref.url);
        if (!url) return `${ref.source} (${ref.nativeId})`;
        const label = referenceLabel({ title: ref.title, url }, item.title);
        // Only prefix a distinct title; a bare URL stays as it was.
        return label === linkLabel(url) ? url : `${label} — ${url}`;
      })
      .join("; ");
    return [
      item.title,
      item.summary ? `Model summary: ${displaySummary(item.summary)}` : null,
      keyPointList(item.keyPoints).length
        ? `Key points:\n${keyPointList(item.keyPoints)
            .map((value) => `- ${value}`)
            .join("\n")}`
        : null,
      caveatNotes(item.uncertainty).length
        ? `Model uncertainty:\n${caveatNotes(item.uncertainty)
            .map((value) => `- ${value}`)
            .join("\n")}`
        : null,
      matchNote(item.why),
      `Sources: ${refs}`,
    ]
      .filter(Boolean)
      .join("\n");
  };
  const top = items.slice(0, TOP_STORIES);
  const rest = items.slice(TOP_STORIES);
  const section = (heading: string, values: DigestRenderItem[]) =>
    values.length
      ? `<h2>${heading}</h2>${values.map(renderHtml).join("<hr>")}`
      : "";
  const textSection = (heading: string, values: DigestRenderItem[]) =>
    values.length ? [heading, ...values.map(renderText)].join("\n\n") : "";
  return {
    subject,
    html: `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:640px;margin:0 auto;line-height:1.5;color:#111"><h1>${escapeHtml(subject)}</h1>${rest.length ? `${section("Top stories", top)}${section("More coverage", rest)}` : top.map(renderHtml).join("<hr>")}</body></html>`,
    text: [
      subject,
      rest.length
        ? `${textSection("Top stories", top)}\n\n${textSection("More coverage", rest)}`
        : top.map(renderText).join("\n\n"),
    ].join("\n\n"),
    feedbackTargets: items.map(({ itemId }) => ({
      itemId,
      actions: ["useful", "not_useful"],
    })),
  };
}
