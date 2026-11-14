/**
 * Query construction for FTS5 keyword search, shared by the production store
 * and the offline retrieval-gap evaluation (#29) so measured behavior and
 * shipped behavior cannot drift. Versioned because the matching contract is
 * observable through MCP search results and recorded baselines.
 */

export const SEARCH_MATCH_VERSION = "fts-match-groups-v1";

/** Mirrors the original production tokenizer; FTS5 default unicode61 applies. */
export function searchTerms(query: string): string[] {
  return (query.match(/[\p{L}\p{N}_]+/gu) ?? []).slice(0, 30);
}

/**
 * Curated, versioned synonym expansion. Deliberately small and literal so a
 * measured benefit is attributable; it is not an open vocabulary resource.
 */
export const SYNONYM_VERSION = "retrieval-synonyms-v1";
export const QUERY_SYNONYMS: Record<string, string[]> = {
  benchmark: ["evaluation"],
  evaluations: ["benchmarks"],
  llm: ["large language model", "language model"],
  quantization: ["compression"],
  robot: ["robotics"],
  robotics: ["robot"],
  sbom: ["software bill of materials"],
  laws: ["power-law"],
};

const quote = (term: string) => '"' + term + '"';
const prefixQuote = (term: string) =>
  term.length >= 3 ? quote(term) + "*" : quote(term);

/** FTS5 default tokenization is case-insensitive; expansion must be too. */
function synonymsFor(term: string): string[] {
  return QUERY_SYNONYMS[term.toLowerCase()] ?? [];
}

/**
 * Adopted production strategy (decision D14; candidate and-prefix-group-
 * synonyms): every query term becomes a prefix match OR-grouped with its
 * curated synonyms, and the groups are combined with AND, so required
 * vocabulary is preserved while morphology (recall/recalls) and recorded
 * acronym expansions widen recall. Measured on the labeled retrieval-gap
 * corpus: recall 0.385 → 0.692 and precision at 5 0.625 → 0.750 against the
 * baseline quoted-AND match, with the only unrecovered positives being
 * unavailable content.
 */
export function buildQueryMatch(terms: string[]): string {
  return terms
    .map((term) => {
      const group = [term, ...synonymsFor(term)].map(prefixQuote);
      return group.length > 1 ? "(" + group.join(" OR ") + ")" : group[0]!;
    })
    .join(" AND ");
}
