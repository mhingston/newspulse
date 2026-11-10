import type { Database } from "bun:sqlite";

/**
 * Read-only views of items found outside followed subscriptions. Pagination is
 * keyset on the discovery result id (ascending insertion order, newest first
 * when `before` is omitted), so pages never skip or repeat rows.
 */
export interface DiscoveryRead {
  id: number;
  item_id: string;
  url: string;
  title: string;
  snippet: string;
  origin: string;
  published_at: number | null;
  observed_at: number | null;
}

export function listDiscoveries(
  db: Database,
  input: { limit: number; before?: number },
): { discoveries: DiscoveryRead[]; next_before: number | null } {
  const rows = db
    .query<DiscoveryRead, [number, number]>(
      "SELECT id,item_id,url,title,snippet,origin,published_at,observed_at FROM discovery_results WHERE id<? ORDER BY id DESC LIMIT ?",
    )
    .all(input.before ?? Number.MAX_SAFE_INTEGER, input.limit + 1);
  const page = rows.slice(0, input.limit);
  return {
    discoveries: page,
    next_before: rows.length > input.limit ? page[page.length - 1]!.id : null,
  };
}
