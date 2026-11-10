import type { Interest } from "./profiles";

export interface PlannedQuery {
  key: string;
  query: string;
  kind: "interest" | "adjacent";
  interestId?: string;
  interestVersion?: number;
  interestLineage: Array<{ id: string; version: number }>;
  priority: number;
  negative: string[];
}

export function normalizeDiscoveryQuery(query: string): string {
  return query
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("en-US");
}

export function planDiscoveryQueries(interests: Interest[]): PlannedQuery[] {
  const selected = new Map<string, PlannedQuery>();
  const boundedInterests = [...interests]
    .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))
    .slice(0, 1000);
  let primaryCandidates = 0;
  let adjacentCandidates = 0;
  let pairAttempts = 0;
  const add = (
    query: string,
    kind: PlannedQuery["kind"],
    interest?: Interest,
    additionalNegative: string[] = [],
    additionalInterests: Interest[] = [],
  ) => {
    const normalized = normalizeDiscoveryQuery(query);
    if (
      !normalized ||
      normalized.length > 500 ||
      /[\u0000-\u001f\u007f]/.test(query)
    )
      return;
    const negative = [
      ...new Set([...(interest?.negative ?? []), ...additionalNegative]),
    ];
    const key = normalized;
    const candidate: PlannedQuery = {
      key,
      query: query.trim().replace(/\s+/g, " "),
      kind,
      interestId: interest?.id,
      interestVersion: interest?.version,
      interestLineage: [
        ...(interest ? [{ id: interest.id, version: interest.version }] : []),
        ...additionalInterests.map(({ id, version }) => ({ id, version })),
      ],
      priority: (interest?.priority ?? 1) * 100,
      negative,
    };
    const prior = selected.get(key);
    if (!prior) selected.set(key, candidate);
    else {
      const preferred =
        (prior.kind === "adjacent" && kind === "interest") ||
        candidate.priority > prior.priority
          ? candidate
          : prior;
      selected.set(key, {
        ...preferred,
        negative: [...new Set([...prior.negative, ...candidate.negative])],
        interestLineage: [
          ...new Map(
            [...prior.interestLineage, ...candidate.interestLineage].map(
              (entry) => [`${entry.id}@${entry.version}`, entry] as const,
            ),
          ).values(),
        ],
      });
    }
  };
  for (const interest of boundedInterests) {
    for (const query of interest.queries) {
      if (primaryCandidates >= 500) break;
      primaryCandidates++;
      add(query, "interest", interest);
    }
    if (primaryCandidates >= 500) break;
  }

  const terms = boundedInterests.map((interest) => ({
    interest,
    values: [...new Set([...interest.entities, ...interest.keywords])].slice(
      0,
      10,
    ),
  }));
  for (let left = 0; left < terms.length; left++)
    for (let right = left + 1; right < terms.length; right++) {
      if (adjacentCandidates >= 500 || pairAttempts >= 5000) break;
      const a = terms[left]!;
      const b = terms[right]!;
      for (const x of a.values.slice(0, 3))
        for (const y of b.values.slice(0, 3)) {
          if (adjacentCandidates >= 500 || pairAttempts >= 5000) break;
          pairAttempts++;
          const size = selected.size;
          add(`${x} ${y}`, "adjacent", a.interest, b.interest.negative, [
            b.interest,
          ]);
          if (selected.size > size) adjacentCandidates++;
        }
    }
  return [...selected.values()]
    .filter(
      (candidate) =>
        !candidate.negative.some((term) =>
          candidate.key.includes(term.toLocaleLowerCase("en-US")),
        ),
    )
    .sort(
      (a, b) =>
        b.priority - a.priority ||
        a.kind.localeCompare(b.kind) ||
        a.key.localeCompare(b.key),
    );
}

export function allocateQuerySlots<T extends { kind: "interest" | "adjacent" }>(
  queries: T[],
  slots: number,
  adjacentPercent: number,
  priorRuns: { total: number; adjacent: number } = { total: 0, adjacent: 0 },
): T[] {
  if (
    !Number.isSafeInteger(slots) ||
    slots < 0 ||
    !Number.isFinite(adjacentPercent) ||
    adjacentPercent < 0 ||
    adjacentPercent > 100
  )
    throw new Error("Invalid discovery allocation");
  const primary = queries.filter((q) => q.kind === "interest");
  const adjacent = queries.filter((q) => q.kind === "adjacent");
  const reserve = Math.max(
    0,
    Math.floor(((priorRuns.total + slots) * adjacentPercent) / 100) -
      priorRuns.adjacent,
  );
  const adjacentTake = Math.min(reserve, slots, adjacent.length);
  const primaryTake = Math.min(slots - adjacentTake, primary.length);
  let remaining = slots - adjacentTake - primaryTake;
  const extraPrimary = Math.min(remaining, primary.length - primaryTake);
  remaining -= extraPrimary;
  const extraAdjacent = Math.min(remaining, adjacent.length - adjacentTake);
  return [
    ...primary.slice(0, primaryTake),
    ...adjacent.slice(0, adjacentTake),
    ...primary.slice(primaryTake, primaryTake + extraPrimary),
    ...adjacent.slice(adjacentTake, adjacentTake + extraAdjacent),
  ];
}
