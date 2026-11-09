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
}
function terms(text: string): Set<string> {
  return new Set(
    text.toLocaleLowerCase("en").match(/[\p{L}\p{N}]{4,}/gu) ?? [],
  );
}
/** Conservative indicator, not a claim that a correction is important or true. */
export function observedUpdate(
  previous: ObservedVersion | undefined,
  current: ObservedVersion | undefined,
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
  };
}
