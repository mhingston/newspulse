/** A source's own successive observations, not evidence the user saw them. */
export interface ObservedVersion {
  id: number;
  source_id: string;
  native_id: string;
  title: string;
  text: string;
  backfilled: number;
}
export interface ObservedUpdate {
  ruleVersion: "observed-update-v1";
  sourceId: string;
  nativeId: string;
  previousVersionId: number;
  currentVersionId: number;
  newTerms: string[];
  observedAt: number;
}
function terms(text: string): Set<string> {
  return new Set(
    text.toLocaleLowerCase("en").match(/[\p{L}\p{N}]{4,}/gu) ?? [],
  );
}
/** Conservative indicator, not a claim that a correction is important or true. */
export function observedUpdate(
  previous: ObservedVersion | undefined,
  current: (ObservedVersion & { observed_at: number }) | undefined,
): ObservedUpdate | null {
  if (
    !previous ||
    !current ||
    previous.backfilled ||
    current.backfilled ||
    previous.source_id !== current.source_id ||
    previous.native_id !== current.native_id ||
    !previous.text.trim() ||
    !current.text.trim()
  )
    return null;
  const beforeTitle = [...terms(previous.title)].sort().join(" ");
  const afterTitle = [...terms(current.title)].sort().join(" ");
  if (!beforeTitle || beforeTitle === afterTitle) return null;
  const before = terms(previous.text);
  const after = terms(current.text);
  const added = [...after].filter((term) => !before.has(term)).sort();
  if (added.length < 20 || added.length / Math.max(after.size, 1) < 0.2)
    return null;
  return {
    ruleVersion: "observed-update-v1",
    sourceId: current.source_id,
    nativeId: current.native_id,
    previousVersionId: previous.id,
    currentVersionId: current.id,
    newTerms: added,
    observedAt: current.observed_at,
  };
}

/** Preserve qualifying changes through incidental edits; exact lexical reversions cancel them. */
export function currentObservedUpdate(
  versions: (ObservedVersion & { observed_at: number })[],
): ObservedUpdate | null {
  const bySource = new Map<
    string,
    (ObservedVersion & { observed_at: number })[]
  >();
  for (const version of versions) {
    const key = JSON.stringify([version.source_id, version.native_id]);
    const history = bySource.get(key) ?? [];
    history.push(version);
    bySource.set(key, history);
  }
  const candidates: ObservedUpdate[] = [];
  for (const history of bySource.values()) {
    history.sort((a, b) => a.id - b.id);
    const seen = new Set<string>();
    let previous: (ObservedVersion & { observed_at: number }) | undefined;
    let active: ObservedUpdate | null = null;
    for (const current of history) {
      if (current.backfilled || !current.text.trim()) {
        previous = current;
        continue;
      }
      const signature = JSON.stringify([
        [...terms(current.title)].sort(),
        [...terms(current.text)].sort(),
      ]);
      const previousSignature = previous?.text.trim()
        ? JSON.stringify([
            [...terms(previous.title)].sort(),
            [...terms(previous.text)].sort(),
          ])
        : null;
      if (signature !== previousSignature && seen.has(signature)) active = null;
      else {
        const candidate = observedUpdate(previous, current);
        if (candidate) active = candidate;
        else if (active) {
          const currentTerms = terms(current.text);
          if (
            active.newTerms.filter((term) => currentTerms.has(term)).length <
            active.newTerms.length / 2
          )
            active = null;
        }
      }
      seen.add(signature);
      previous = current;
    }
    if (active) candidates.push(active);
  }
  return (
    candidates.sort((a, b) => b.currentVersionId - a.currentVersionId)[0] ??
    null
  );
}
