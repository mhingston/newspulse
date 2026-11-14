import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

export const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>Engineering</title><item><guid>release-1</guid><title>Specialist models released</title><link>https://example.com/models?utm_source=rss</link><description><![CDATA[<p>Small models improve robotics.</p>]]></description><pubDate>Sun, 08 Nov 2026 09:00:00 GMT</pubDate></item><item><guid>private-message</guid><title>Private newsletter note</title><description>Useful information without a public URL</description></item></channel></rss>`;
export const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>urn:release:1</id><title>Specialist models released</title><link rel="alternate" href="https://example.com/models"/><content type="html">Small models improve robotics.</content><updated>2026-11-08T09:00:00Z</updated></entry></feed>`;
export const opml = (url: string) =>
  `<opml version="2.0"><body><outline text="Technology"><outline text="Engineering" xmlUrl="${url}"/></outline></body></opml>`;

export const prefixedAtom = `<?xml version="1.0" encoding="UTF-16"?><a:feed xmlns:a="http://www.w3.org/2005/Atom"><a:entry><a:id>urn:release:1</a:id><a:title>Specialist models released</a:title><a:link rel="alternate" href="https://example.com/models#benchmarks"/><a:content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml">Small <strong>models</strong> improve robotics.</div></a:content><a:updated>2026-11-08T09:00:00Z</a:updated></a:entry></a:feed>`;

/**
 * Materializes the checked-in Drizzle migrations with journal index below
 * `before` into a fresh folder, so a test can build a database at a prior
 * schema version and migrate it forward.
 */
export function migrationsBefore(dir: string, before: number): string {
  const source = fileURLToPath(new URL("../drizzle/", import.meta.url));
  const folder = join(dir, `migrations-before-${before}`);
  mkdirSync(join(folder, "meta"), { recursive: true });
  const version = (name: string): number => Number(name.slice(0, 4));
  for (const file of readdirSync(source)) {
    if (file.endsWith(".sql") && version(file) < before)
      copyFileSync(join(source, file), join(folder, file));
  }
  const journal = JSON.parse(
    readFileSync(join(source, "meta/_journal.json"), "utf8"),
  ) as { entries: { idx: number }[] };
  journal.entries = journal.entries.filter((entry) => entry.idx < before);
  writeFileSync(join(folder, "meta/_journal.json"), JSON.stringify(journal));
  for (const file of readdirSync(join(source, "meta"))) {
    if (file.endsWith("_snapshot.json") && version(file) < before)
      copyFileSync(join(source, "meta", file), join(folder, "meta", file));
  }
  return folder;
}
