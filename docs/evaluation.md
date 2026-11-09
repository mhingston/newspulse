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

The original [v1 baseline](baselines/synthetic-robotics-v1.json) and [scoring-v2 replay](baselines/synthetic-robotics-scoring-v2.json) record the corpus hash, fixed evaluation time, interest versions, scoring/grouping versions, model provenance, each score, group and exclusion, and the metric denominators. The scoring-v2 replay has unchanged metrics and ranking for this corpus, which contains no delivery history; it does not evaluate historical redundancy. Archive new reports under distinct names; never overwrite an earlier result. New labeled examples belong in a new corpus version and cannot be compared as if they were the same inputs. Comparison requires identical corpus hash, time, k and profiles, reports version/configuration differences and per-item rank, group and eligibility changes, and refuses incompatible inputs. The optional timing is a local replay measurement, not ingestion-to-publication latency or a comparable deterministic metric.

A comparison optionally accepts a JSON array of gates, for example `[{"metric":"precisionAtK","min":0.8}]` as its third argument. Gates are operator-configured; no target is asserted by this project. A gate fails if its value is unavailable or its relevant labels are incomplete. A failed gate exits nonzero. Evaluate only sanitized, explicitly labeled data; do not put credentials or real user interests in a shared corpus. Corpus size is capped at 500 items and 100 profiles to bound the pairwise grouping evaluation.

## Definitions and limitations

- Precision at k is relevant items divided by relevant plus irrelevant judgments among eligible top-k items. Borderline and missing judgments are counted separately as unknown; a value with unknowns is not a complete precision estimate.
- Duplicate rate counts repeated labeled development IDs among selected items, divided by selected items with development labels. It measures actual duplicate coverage, not the grouper's own assignments. Unknown development labels are counted separately.
- Outside-subscription relevance is relevant divided by relevant plus irrelevant judgments among selected items explicitly marked outside subscriptions. Missing source status and borderline/missing relevance remain unknown.
- Important-development recall is distinct labeled important developments represented among the selected items divided by all distinct labeled important developments in the corpus. The report lists labeled misses and counts unknown importance/development labels separately.
- Group pair precision and recall compare predicted same-group pairs against pairs with explicit development labels; unlabeled pairs are reported separately. They assess grouping across the entire corpus, including excluded items.
- Useful discoveries count distinct relevant labeled developments in selected results. Replay provider calls are zero; historical provider costs and cost per useful discovery are unknown, not zero. The offline replay cannot establish real-world discovery yield, production latency or actual provider spending.

The nine-item corpus is deliberately small and synthetic. It includes positive, negative, borderline, duplicate, outside-subscription and unknown examples, but is neither representative nor a basis for real-world quality claims. Rankings do not simulate delivery or user feedback. The current baseline uses no recorded model analyses; if future examples include analyses, their provider, model and prompt version must be recorded. Synthetic profiles are not the user's interests.
