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

Issue #29 requires measuring FTS5 retrieval gaps before any embedding or advanced search adoption. The replay uses a dedicated labeled retrieval corpus, [retrieval-gap-corpus-v1](../tests/fixtures/retrieval-gap-corpus-v1.json) (18 items, including explicit unavailable-content negatives), with recorded realistic queries in [retrieval-gap-queries-v1](../tests/fixtures/retrieval-gap-queries-v1.json) covering a working control query, vocabulary-mismatch queries (recorded acronyms against expanded corpus terminology), a paper-connection query (a preprint and a later engineering post describing the same work in different vocabulary), a historical-development query (a 2024 recall and its 2026 successor), an unavailable-content query and two metadata-filter queries. The same items and labels score every candidate; results differ only by match construction.

Reproduce:

```sh
bun run cli evaluate-retrieval tests/fixtures/retrieval-gap-corpus-v1.json tests/fixtures/retrieval-gap-queries-v1.json > /tmp/retrieval-current.json
# Optional local timing observation is emitted to stderr, not the deterministic report:
bun run cli evaluate-retrieval tests/fixtures/retrieval-gap-corpus-v1.json tests/fixtures/retrieval-gap-queries-v1.json --timing
```

The replay builds a throwaway FTS5 index with the production schema (`items_fts(title, text)` plus item metadata), replays every query for each strategy listed in `MATCH_STRATEGIES` (with and without the recorded per-query filters), and reports recall@k, precision@k, zero-result queries, full-recall queries and the measured index footprint. The checked-in [retrieval-gap-v1](baselines/retrieval-gap-v1.json) baseline records the replay deterministically; a test verifies a fresh run matches it exactly.

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

Interpretation preserved in decision [D14](decisions.md): vocabulary mismatch and cross-document connection produce measured zero-result and half-recall gaps on the baseline; OR-style expansion recovers recall but measurably trades precision away; prefix + synonym AND-grouping improves both without losing required vocabulary; recorded metadata filters measurably improve precision and were already implemented on the read surface. The one permanently unrecovered positive for every keyword strategy is the unavailable-content item. Local per-query latency ranged from about 0.23 ms to 0.35 ms across strategies (environment-dependent, recorded via `--timing` only); the FTS5 overhead for 18 items was 24,576 bytes of committed pages over the same rows without FTS. These are fixture measurements, not real-world quality claims.

## Definitions and limitations

- Precision at k is relevant items divided by relevant plus irrelevant judgments among eligible top-k items. Borderline and missing judgments are counted separately as unknown; a value with unknowns is not a complete precision estimate.
- Duplicate rate counts repeated labeled development IDs among selected items, divided by selected items with development labels. It measures actual duplicate coverage, not the grouper's own assignments. Unknown development labels are counted separately.
- Outside-subscription relevance is relevant divided by relevant plus irrelevant judgments among selected items explicitly marked outside subscriptions. Missing source status and borderline/missing relevance remain unknown.
- Important-development recall is distinct labeled important developments represented among the selected items divided by all distinct labeled important developments in the corpus. The report lists labeled misses and counts unknown importance/development labels separately.
- Group pair precision and recall compare predicted same-group pairs against pairs with explicit development labels; unlabeled pairs are reported separately. They assess grouping across the entire corpus, including excluded items.
- Useful discoveries count distinct relevant labeled developments in selected results. Replay provider calls are zero; historical provider costs and cost per useful discovery are unknown, not zero. The offline replay cannot establish real-world discovery yield, production latency or actual provider spending.
- Retrieval-gap replay recall@k counts labeled positives retrieved among the top k results across recorded queries, divided by all labeled positives; precision@k counts retrieved positives divided by retrieved results. A zero-result query has no precision value and is counted as unknown, never zero. Unavailable-content positives are recorded as a categorical keyword-retrieval gap. Index footprint compares committed pages of identical rows with and without FTS.
- Optional timing on either replay is a local measurement, not ingestion-to-publication latency or a comparable deterministic metric.

The nine-item corpus is deliberately small and synthetic. It includes positive, negative, borderline, duplicate, outside-subscription and unknown examples, but is neither representative nor a basis for real-world quality claims. Rankings do not simulate delivery or user feedback. The current baseline uses no recorded model analyses; if future examples include analyses, their provider, model and prompt version must be recorded. Synthetic profiles are not the user's interests.
