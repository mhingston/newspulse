# Offline evaluation

The corpus is synthetic and does not represent the user's interests or real-world relevance. It is a regression fixture, not a quality estimate or a release threshold. Unknown labels, model usage, monetary cost and latency must remain unknown rather than being counted as zero. No default replay sends email or calls a provider.

## Newsweave comparison

On 2026-11-09, the accessible Newsweave source at commit `6d2d1930947f3a6eadf4b23e9669dfdab3dae18e` was inspected. Its [curation path](https://github.com/mhingston/newsweave/blob/6d2d1930947f3a6eadf4b23e9669dfdab3dae18e/src/curate.ts) consumes model-generated summaries and calls a chat provider to group items; its [optional decision-model path](https://github.com/mhingston/newsweave/blob/6d2d1930947f3a6eadf4b23e9669dfdab3dae18e/src/decision.ts) can call Jev. The inspected CLI has no recorded-corpus replay command. No comparable recorded summary, model outputs, policy and cost for the same inputs are available in this repository. Therefore a comparable Newsweave baseline is unknown; its fallback singleton score is not substituted for the normal pipeline. A future comparison requires sanitized recorded inputs, outputs and configuration for both systems, with costs and missing labels reported explicitly.

## Reproduce and compare

```sh
bun run cli evaluate tests/fixtures/evaluation-corpus-v1.json 5 > /tmp/newspulse-current.json
bun run cli evaluate-compare docs/baselines/synthetic-robotics-v1.json /tmp/newspulse-current.json
# Optional local timing observation is emitted to stderr, not the deterministic report:
bun run cli evaluate tests/fixtures/evaluation-corpus-v1.json 5 --timing > /tmp/newspulse-current.json
```

The original [v1 baseline](baselines/synthetic-robotics-v1.json), [scoring-v2 replay](baselines/synthetic-robotics-scoring-v2.json) and [scoring-v3 replay](baselines/synthetic-robotics-scoring-v3.json) record the corpus hash, fixed evaluation time, interest versions, scoring/grouping versions, model provenance, each score, group and exclusion, and the metric denominators. The scoring-v3 replay adds explicit-feedback-aware scoring; this corpus carries no feedback, so its metrics and ranking are unchanged from scoring-v2 and it does not evaluate historical redundancy. Archive new reports under distinct names; never overwrite an earlier result. New labeled examples belong in a new corpus version and cannot be compared as if they were the same inputs. Comparison requires identical corpus hash, time, k and profiles, reports version/configuration differences and per-item rank, group and eligibility changes, and refuses incompatible inputs. A comparison optionally accepts a JSON array of gates, for example `[{"metric":"precisionAtK","min":0.8}]` as its third argument. Gates are operator-configured; no target is asserted by this project. A gate fails if its value is unavailable or its relevant labels are incomplete. A failed gate exits nonzero. Evaluate only sanitized, explicitly labeled data; do not put credentials or real user interests in a shared corpus. Corpus size is capped at 500 items and 100 profiles to bound the pairwise grouping evaluation.

## Retrieval gap replay (issue #29)

Issue #29 requires measuring FTS5 retrieval gaps before any embedding or advanced search adoption. The replay uses a dedicated labeled retrieval corpus, [retrieval-gap-corpus-v1](../tests/fixtures/retrieval-gap-corpus-v1.json) (18 items with recorded publication and ingestion times, including explicit unavailable-content negatives), with recorded realistic queries in [retrieval-gap-queries-v1](../tests/fixtures/retrieval-gap-queries-v1.json) covering a working control query, vocabulary-mismatch queries (recorded acronyms against expanded corpus terminology), a paper-connection query (a preprint and a later engineering post describing the same work in different vocabulary), a historical-development query (a 2024 recall and its 2026 successor), an unavailable-content query and two metadata-filter queries. The same items and labels score every candidate; results differ only by match construction. The replay enforces the production filter contract: recorded `from`/`to` windows apply to `ingested_at` with an inclusive lower and exclusive upper bound, exactly as `Store.search` applies `since`/`until` to `items.ingested_at`, so no old-review item can pass the replay while failing the shipped filters.

Reproduce:

```sh
bun run cli evaluate-retrieval tests/fixtures/retrieval-gap-corpus-v1.json tests/fixtures/retrieval-gap-queries-v1.json > /tmp/retrieval-current.json
# Optional local timing observation is emitted to stderr, not the deterministic report:
bun run cli evaluate-retrieval tests/fixtures/retrieval-gap-corpus-v1.json tests/fixtures/retrieval-gap-queries-v1.json --timing
```

The replay builds a throwaway FTS5 index with the production schema (`items_fts(title, text)` on top of identical canonical rows in both measured databases, so the reported overhead is purely the added index), replays every query for each strategy listed in `MATCH_STRATEGIES` (with and without the recorded per-query filters), and reports recall@k, precision@k, zero-result queries, full-recall queries and the measured index footprint. The checked-in [retrieval-gap-v1](baselines/retrieval-gap-v1.json) baseline records the replay deterministically; a test verifies a fresh run matches it exactly.

Recorded baseline findings (2026-11-10, Bun 1.4.4, local observation; see the baseline for hashes):

| Strategy                              | Filters  | Recall@5 | Precision@5 | Zero-result queries |
| ------------------------------------- | -------- | -------- | ----------- | ------------------- |
| `and-quoted` (recorded baseline)      | none     | 5/13     | 5/8         | 4 of 9              |
| `and-quoted`                          | recorded | 5/13     | 5/5         | 4 of 9              |
| `or-quoted`                           | none     | 12/13    | 12/26       | 1 of 9              |
| `or-quoted`                           | recorded | 12/13    | 12/21       | 1 of 9              |
| `and-prefix`                          | none     | 6/13     | 6/9         | 4 of 9              |
| `and-prefix`                          | recorded | 6/13     | 6/6         | 4 of 9              |
| `or-prefix`                           | none     | 12/13    | 12/26       | 1 of 9              |
| `or-prefix`                           | recorded | 12/13    | 12/21       | 1 of 9              |
| `and-group-synonyms`                  | none     | 8/13     | 8/11        | 1 of 9              |
| `and-group-synonyms`                  | recorded | 8/13     | 8/8         | 1 of 9              |
| `and-prefix-group-synonyms` (adopted) | none     | 9/13     | 9/12        | 1 of 9              |
| `and-prefix-group-synonyms` (adopted) | recorded | 9/13     | 9/9         | 1 of 9              |

Interpretation preserved in decision [D14](decisions.md): vocabulary mismatch and cross-document connection produce measured zero-result and half-recall gaps on the baseline; OR-style expansion recovers recall but measurably trades precision away; prefix and plain synonym AND-grouping improve both axes, with the adopted `and-prefix-group-synonyms` the best AND-side result (9/13 recall, 0.750 precision); recorded metadata filters measurably improve precision and were already implemented on the read surface. Under the adopted construction four positives stay unrecovered: the unavailable-content item (categorical for keyword retrieval; its query is the only zero-result query) and one available positive each in q-vocab-llm, q-connect-scaling and q-papers-protocols — accepted because the only constructions retrieving them were measured at precision 0.462, and the gaps are recorded rather than resolved. Local per-query latency ranged from about 0.33 ms to 0.55 ms across strategies (environment-dependent, recorded via `--timing` only); adding the FTS index to identical canonical storage cost 28,672 bytes of committed pages for 18 items. These are fixture measurements, not real-world quality claims.

## Definitions and limitations

- Precision at k is relevant items divided by relevant plus irrelevant judgments among eligible top-k items. Borderline and missing judgments are counted separately as unknown; a value with unknowns is not a complete precision estimate.
- Duplicate rate counts repeated labeled development IDs among selected items, divided by selected items with development labels. It measures actual duplicate coverage, not the grouper's own assignments. Unknown development labels are counted separately.
- Outside-subscription relevance is relevant divided by relevant plus irrelevant judgments among selected items explicitly marked outside subscriptions. Missing source status and borderline/missing relevance remain unknown.
- Important-development recall is distinct labeled important developments represented among the selected items divided by all distinct labeled important developments in the corpus. The report lists labeled misses and counts unknown importance/development labels separately.
- Group pair precision and recall compare predicted same-group pairs against pairs with explicit development labels; unlabeled pairs are reported separately. They assess grouping across the entire corpus, including excluded items.
- Useful discoveries count distinct relevant labeled developments in selected results. Replay provider calls are zero; historical provider costs and cost per useful discovery are unknown, not zero. The offline replay cannot establish real-world discovery yield, production latency or actual provider spending.
- Retrieval-gap replay recall@k counts labeled positives retrieved among the top k results across recorded queries, divided by all labeled positives (which must be unique per query); precision@k counts retrieved positives divided by retrieved results. A zero-result query has no precision value and is counted as unknown, never zero. Unavailable-content positives are recorded as a categorical keyword-retrieval gap. The index footprint uses identical canonical base rows in both measured databases, so the difference isolates the added FTS index.
- Optional timing on either replay is a local measurement, not ingestion-to-publication latency or a comparable deterministic metric.

The nine-item corpus is deliberately small and synthetic. It includes positive, negative, borderline, duplicate, outside-subscription and unknown examples, but is neither representative nor a basis for real-world quality claims. Rankings do not simulate delivery or user feedback. The current baseline uses no recorded model analyses; if future examples include analyses, their provider, model and prompt version must be recorded. Synthetic profiles are not the user's interests.

## Source recommendation replay (issue #33)

Issue #33 requires measuring whether opt-in recommendations of new sources add value over item-level discovery alone before any automatic source following. The replay uses the dedicated labeled corpus [source-recommendation-corpus-v2](../tests/fixtures/source-recommendation-corpus-v2.json) (36 items across 9 recorded domains plus 6 held-out subsequent items, including a high-value publisher with explicit useful feedback, a repetitive low-value publisher, duplicate mirrors, an unavailable feed with a recovered extraction generation, a source with recorded recent quality decline, a subscribed source, and a Reddit discussion reached only through search snippets). It populates a throwaway database with the exact production schema — items, item_sources, discovery run/page/results provenance, explicit feedback, extraction outcomes and feed-link metadata captured by the existing extraction fetch — and then runs the shipped `source-suggestions-v2` aggregation and refresh path unchanged (persistence, operator-suppression handling, eligibility reconciliation included), so shipped behavior and measured behavior cannot drift.

The baseline arm is item-level discovery alone: every labeled development already reachable through subscriptions or recorded discoveries. The suggestion arm adds only labeled held-out subsequent items from accepted (proposed) publishers, so the lift counts genuinely incremental coverage, never discoveries already recorded.

Reproduce:

```sh
bun run cli evaluate-source-recommendations tests/fixtures/source-recommendation-corpus-v2.json
# Optional local timing observation is emitted to stderr, not the deterministic report:
bun run cli evaluate-source-recommendations tests/fixtures/source-recommendation-corpus-v2.json --timing
```

The [source-recommendations-v1](baselines/source-recommendations-v1.json) baseline records the replay deterministically (evaluation version `source-recommendation-evaluation-v2`); a test verifies a fresh run matches it exactly.

Recorded baseline findings (2026-11-14 fixture metrics; see the baseline for the corpus hash):

| Measure                                    | Baseline (item-level discovery alone) | With proposed suggestions  |
| ------------------------------------------ | ------------------------------------- | -------------------------- |
| Labeled development recall                 | 8/11 (0.727)                          | 10/11 (0.909)              |
| Incremental lift                           | —                                     | +2/11 (+0.182)             |
| Novelty (newly covered developments/total) | —                                     | 2/11 (0.182)               |
| Suggestion precision (labeled proposals)   | —                                     | 2/3 (0.667)                |
| Recorded false positives                   | —                                     | 1 (`mixed-review.example`) |
| API cost of suggestion generation          | —                                     | 0 (micros)                 |

Interpretation preserved in decision [D16](decisions.md): proposing from provenance adds measured incremental coverage (+2/11 held-out developments, with the false-positive publisher's gossip development — labeled irrelevant on its held-out item — correctly never counted, and still uncovered). The precision and false-positive numbers make the cost explicit: one of the three recorded proposals is an "avoid"-labeled publisher. The estimator refuses volume-as-quality (the repetitive source fails on the repetition penalty plus the recent-feedback requirement), counts mirror coverage once per distinct mirrored item, gives only the current extraction generation's unavailable outcome weight (a recovered publisher is not suppressed by its history), and declines sources whose recorded quality has recently fallen — every judgment as a recorded skip reason. Reddit domains are never suggested from snippets. Suggestion generation reads only already-recorded rows: it consumes no search/discovery budget, makes no provider calls and its measured cost is 0 micros beyond the recorded discovery spend; real-world usefulness, latency and cost remain unknown and are reported as unknown, not zero. Operator suppression (dismiss/mute) removes a candidate from the actionable slice without consuming its limit, previously proposed candidates that stop qualifying are reconciled to the audited, system-managed `expired` state so acceptance cannot silently follow lost evidence, and a qualifying-again proposal is renewed with its full audit trail preserved.

## Interest adaptation replay (issue #25)

Issue #25 requires comparing the recorded explicit-feedback baseline against bounded, explainable richer adaptation strategies before any adoption, measuring false topic drift and exploration cost rather than aggregate relevance alone. The replay (`evaluateInterestAdaptation` in `src/interest-adaptation-evaluation.ts`) uses the same labeled corpus as the recorded #8 baseline, [evaluation-corpus-v1](../tests/fixtures/evaluation-corpus-v1.json), unchanged — same items, labels, profiles, replay instant (`asOf`) and top-k budget (k=5) — plus a recorded explicit-feedback history, [interest-adaptation-history-v1](../tests/fixtures/interest-adaptation-history-v1.json) (six recorded `mcp`/`email` judgments including a superseded useful judgment, a 120-day-old useful judgment, and a not_useful judgment; items without events are the no-feedback case). The baseline arm is the shipped `deterministic-v3` scoring unchanged: production `scoreItem` with each item's latest recorded judgment and its flat bounded adjustment. Three candidate arms run the same production scorer with one bounded, explainable change each:

- **Recency weighting** (`recency-weighted-feedback`): the flat judgment adjustment is replaced by the same magnitude decayed linearly with judgment age to zero at a configured horizon (30 days). It never exceeds the flat step in either direction, and a zero-decay judgment is recorded as expired rather than silently dropped.
- **Temporary feedback boost** (`expiring-feedback-boost`): when the configured count of distinct items (2) holds useful latest judgments inside a 30-day window, everything the interest matches gains a bounded +5 that expires by clock, 14 days after the last useful judgment. The boost is additive on top of the flat judgment adjustment, so an explicit not_useful penalty stays fully applied and is never overridden.
- **Adjacent-term widening** (`adjacent-term-widening`): terms supported by at least two explicitly useful items that already matched the interest (function words and the interest's own terms excluded, support-ranked, capped at three) widen the interest's keywords. Original terms are never removed, so widening can only widen eligibility, never narrow it. Widening learns exclusively from recorded explicit judgments — never from unread or missing clicks.

Reproduce:

```sh
bun run cli evaluate-interest-adaptation tests/fixtures/evaluation-corpus-v1.json tests/fixtures/interest-adaptation-history-v1.json
# Optional local timing observation is emitted to stderr, not the deterministic report:
bun run cli evaluate-interest-adaptation tests/fixtures/evaluation-corpus-v1.json tests/fixtures/interest-adaptation-history-v1.json --timing
```

The [interest-adaptation-v1](baselines/interest-adaptation-v1.json) baseline records the replay deterministically, including per-arm explainable changes and the recorded adoption decision; a test verifies a fresh run matches it exactly.

Recorded findings (2026-11-14 fixture metrics; see the baseline for hashes):

| Arm                           | Precision@5     | Useful discoveries | Outside-subscription relevance | Important recall | Development diversity | Topic drift     |
| ----------------------------- | --------------- | ------------------ | ------------------------------ | ---------------- | --------------------- | --------------- |
| `baseline` (deterministic-v3) | 4/4 (1 unknown) | 4/4 (1 unknown)    | 3/3 (1 unknown)                | 3/3 (1 unknown)  | 5/7 (0.714)           | 0/2 (2 unknown) |
| `recency-weighted-feedback`   | 4/4 (Δ 0)       | 3/4 (Δ −0.25)      | 2/2 (Δ 0)                      | 3/3 (Δ 0)        | 4/7 (Δ −0.143)        | 0/2 (Δ 0)       |
| `expiring-feedback-boost`     | 4/4 (Δ 0)       | 3/4 (Δ −0.25)      | 2/2 (Δ 0)                      | 3/3 (Δ 0)        | 4/7 (Δ −0.143)        | 0/2 (Δ 0)       |
| `adjacent-term-widening`      | 4/4 (Δ 0)       | 3/4 (Δ −0.25)      | 2/2 (Δ 0)                      | 3/3 (Δ 0)        | 4/7 (Δ −0.143)        | 0/2 (Δ 0)       |

Interpretation preserved in decision [D17](decisions.md): every candidate measurably regresses discovery and diversity on the labeled corpus. The shared mechanism is visible in the per-arm rankings: each candidate lifts recently judged material above the distinct, relevant `old-robotics` development, whose only recorded support is a 120-day-old useful judgment, and the top-5 selection then spends its last slot on `atlas-duplicate` — a duplicate of the already-selected Atlas 2 release — instead of the one item that covers a further labeled development (visible in the candidate arms' outside-subscription denominator shrinking 3 → 2 while the retained hits stay relevant, and in important recall unchanged only because the dropped `old-robotics` item is not item-flagged important). Recency weighting trades a distinct relevant development for recent duplicates; the temporary boost raises recently judged items the same way and gives its slot to the explicitly not_useful duplicate (its penalty stays applied, but the boost still outranks the unboosted distinct development); widening changes within-interest ordering without any eligibility gain on this corpus (the derived terms `model`, `acme`, `atlas` only match items the original terms already matched). Topic drift does not rise in any arm — the invariant tests confirm negative and no-feedback histories never erase an explicit interest match, the recency arm reweights only items with recorded events, the cumulative per-item boost is capped at the flat useful step so overlapping interests cannot reverse an explicit not_useful penalty, and the expired-boost variant restores baseline behavior exactly — but no candidate improves any gated axis, so the recorded threshold adopts none of them. The deterministic-v3 baseline is retained; richer adaptation remains an evaluated non-adoption with recorded revisit triggers, not a feature.
