/** Content and source references are untrusted. A missing URL is a valid citation. */
export interface DigestRenderItem {
  itemId: string;
  title: string;
  why: string;
  summary: string | null;
  uncertainty: string[];
  references: { source: string; nativeId: string; url: string | null }[];
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
/** Readable label for a public link: host plus path, without query noise. */
function linkLabel(url: string): string {
  const parsed = new URL(url);
  const path =
    parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/$/, "");
  return `${parsed.hostname.replace(/^www\./, "")}${path}`;
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
/** Pure renderer. No feedback links are fabricated; delivery may provide scoped links later. */
export function renderDigest(
  date: string,
  items: DigestRenderItem[],
): RenderedDigest {
  const subject = `Newspulse — ${date}`;
  const htmlItems = items.map((item) => {
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
          item.summary,
        )
          .map((p) => `<p>${escapeHtml(p)}</p>`)
          .join("")}`
      : "";
    const caveats = item.uncertainty.length
      ? `<p style="color:#666;font-size:12px;margin:0">Model uncertainty:</p><ul>${item.uncertainty
          .map((value) => `<li>${escapeHtml(value)}</li>`)
          .join("")}</ul>`
      : "";
    const sourceList = links
      .map(({ ref, url }) =>
        url
          ? `<li><a href="${escapeHtml(url)}">${escapeHtml(linkLabel(url))}</a> <span style="color:#666">· ${escapeHtml(ref.source)}</span></li>`
          : `<li><span>${escapeHtml(`${ref.source} (${ref.nativeId})`)}</span></li>`,
      )
      .join("");
    const sources = sourceList
      ? `<p style="color:#666;font-size:12px;margin:0">Sources</p><ul>${sourceList}</ul>`
      : "";
    // Delivery injects scoped feedback links between these stable markers;
    // the frozen body itself never carries a token.
    return `<article data-item-id="${escapeHtml(item.itemId)}">${heading}${paragraphs}${caveats}<p style="color:#444">${escapeHtml(item.why)}</p>${sources}<!--np:feedback:${escapeHtml(item.itemId)}:start--><!--np:feedback:${escapeHtml(item.itemId)}:end--></article>`;
  });
  const textItems = items.map((item) => {
    const refs = item.references
      .map(
        (ref) =>
          `${ref.source} (${ref.nativeId})${publicUrl(ref.url) ? `: ${ref.url}` : ""}`,
      )
      .join("; ");
    return [
      item.title,
      item.summary ? `Model summary: ${item.summary}` : null,
      item.uncertainty.length
        ? `Model uncertainty:\n${item.uncertainty.map((value) => `- ${value}`).join("\n")}`
        : null,
      item.why,
      `Sources: ${refs}`,
    ]
      .filter(Boolean)
      .join("\n");
  });
  return {
    subject,
    html: `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:640px;margin:0 auto;line-height:1.5;color:#111"><h1>${escapeHtml(subject)}</h1>${htmlItems.join("<hr>")}</body></html>`,
    text: [subject, ...textItems].join("\n\n"),
    feedbackTargets: items.map(({ itemId }) => ({
      itemId,
      actions: ["useful", "not_useful"],
    })),
  };
}
