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
/** Pure renderer. No feedback links are fabricated; delivery may provide scoped links later. */
export function renderDigest(
  date: string,
  items: DigestRenderItem[],
): RenderedDigest {
  const subject = `Newspulse — ${date}`;
  const htmlItems = items.map((item) => {
    const refs = item.references
      .map((ref) => {
        const label = `${ref.source} (${ref.nativeId})`;
        const url = publicUrl(ref.url);
        return url
          ? `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`
          : escapeHtml(label);
      })
      .join("; ");
    const caveats = item.uncertainty
      .map((value) => `<li>${escapeHtml(value)}</li>`)
      .join("");
    // Delivery injects scoped feedback links between these stable markers;
    // the frozen body itself never carries a token.
    return `<article data-item-id="${escapeHtml(item.itemId)}"><h2>${escapeHtml(item.title)}</h2>${item.summary ? `<p>Model summary: ${escapeHtml(item.summary)}</p>` : ""}${caveats ? `<p>Model uncertainty:</p><ul>${caveats}</ul>` : ""}<p>${escapeHtml(item.why)}</p><p>Sources: ${refs}</p><!--np:feedback:${escapeHtml(item.itemId)}:start--><!--np:feedback:${escapeHtml(item.itemId)}:end--></article>`;
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
    html: `<!doctype html><html><body><h1>${escapeHtml(subject)}</h1>${htmlItems.join("")}</body></html>`,
    text: [subject, ...textItems].join("\n\n"),
    feedbackTargets: items.map(({ itemId }) => ({
      itemId,
      actions: ["useful", "not_useful"],
    })),
  };
}
