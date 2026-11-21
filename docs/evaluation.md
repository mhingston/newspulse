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

Issue #25 requires comparing the recorded explicit-feedback baseline against bounded, explainable richer adaptation strategies before any adoption, measuring false topic drift and exploration cost rather than aggregate relevance alone. The replay (`evaluateInterestAdaptation` in `src/interest-adaptation-evaluation.ts`) uses the same labeled corpus as the recorded #8 baseline, [evaluation-corpus-v1](../tests/fixtures/evaluation-corpus-v1.json), unchanged — same items, labels, profiles, replay instant (`asOf`) and top-k budget (k=5) — plus a recorded explicit-feedback history, [interest-adaptation-history-v1](../tests/fixtures/interest-adaptation-history-v1.json) (six recorded `mcp`/`email` judgments including a superseded useful judgment, a 120-day-old useful judgment, and a not_useful judgment; items without events are the no-feedback case). The baseline arm is the shipped `deterministic-v4` scoring unchanged: production `scoreItem` with each item's latest recorded judgment and its flat bounded adjustment. Three candidate arms run the same production scorer with one bounded, explainable change each:

- **Recency weighting** (`recency-weighted-feedback`): the flat judgment adjustment is replaced by the same magnitude decayed linearly with judgment age to zero at a configured horizon (30 days). It never exceeds the flat step in either direction, and a zero-decay judgment is recorded as expired rather than silently dropped.
- **Temporary feedback boost** (`expiring-feedback-boost`): when the configured count of distinct items (2) holds useful latest judgments inside a 30-day window, everything the interest matches gains a bounded +5 that expires by clock, 14 days after the last useful judgment. The boost is additive on top of the flat judgment adjustment, so an explicit not_useful penalty stays fully applied and is never overridden.
- **Adjacent-term widening** (`adjacent-term-widening`): terms supported by at least two explicitly useful items that already matched the interest (function words and the interest's own terms excluded, support-ranked, capped at three) widen the interest's keywords. Original terms are never removed, so widening can only widen eligibility, never narrow it. Widening learns exclusively from recorded explicit judgments — never from unread or missing clicks.

Reproduce:

```sh
bun run cli evaluate-interest-adaptation tests/fixtures/evaluation-corpus-v1.json tests/fixtures/interest-adaptation-history-v1.json
# Optional local timing observation is emitted to stderr, not the deterministic report:
bun run cli evaluate-interest-adaptation tests/fixtures/evaluation-corpus-v1.json tests/fixtures/interest-adaptation-history-v1.json --timing
```

The [interest-adaptation-v2](baselines/interest-adaptation-v2.json) baseline (scoring `deterministic-v4`; the v1 recording is kept as [interest-adaptation-v1-archived](baselines/interest-adaptation-v1-archived.json)) records the replay deterministically, including per-arm explainable changes and the recorded adoption decision; a test verifies a fresh run matches it exactly.

Recorded findings (2026-11-14 fixture metrics; see the baseline for hashes):

| Arm                           | Precision@5     | Useful discoveries | Outside-subscription relevance | Important recall | Development diversity | Topic drift     |
| ----------------------------- | --------------- | ------------------ | ------------------------------ | ---------------- | --------------------- | --------------- |
| `baseline` (deterministic-v4) | 4/4 (1 unknown) | 4/4 (1 unknown)    | 3/3 (1 unknown)                | 3/3 (1 unknown)  | 5/7 (0.714)           | 0/2 (2 unknown) |
| `recency-weighted-feedback`   | 4/4 (Δ 0)       | 3/4 (Δ −0.25)      | 2/2 (Δ 0)                      | 3/3 (Δ 0)        | 4/7 (Δ −0.143)        | 0/2 (Δ 0)       |
| `expiring-feedback-boost`     | 4/4 (Δ 0)       | 4/4 (Δ 0)          | 3/3 (Δ 0)                      | 3/3 (Δ 0)        | 5/7 (Δ 0)             | 0/2 (Δ 0)       |
| `adjacent-term-widening`      | 4/4 (Δ 0)       | 3/4 (Δ −0.25)      | 2/2 (Δ 0)                      | 3/3 (Δ 0)        | 4/7 (Δ −0.143)        | 0/2 (Δ 0)       |

Interpretation recorded in decision [D17](decisions.md) under `deterministic-v4`: recency weighting and adjacent-term widening measurably regress discovery and diversity on the labeled corpus, while the expiring boost is neutral on every axis. The shared mechanism is visible in the per-arm rankings: each candidate lifts recently judged material above the distinct, relevant `old-robotics` development, whose only recorded support is a 120-day-old useful judgment, and the top-5 selection then spends its last slot on `atlas-duplicate` — a duplicate of the already-selected Atlas 2 release — instead of the one item that covers a further labeled development (visible in the candidate arms' outside-subscription denominator shrinking 3 → 2 while the retained hits stay relevant, and in important recall unchanged only because the dropped `old-robotics` item is not item-flagged important). Recency weighting trades a distinct relevant development for recent duplicates; the temporary boost raises recently judged items the same way and gives its slot to the explicitly not_useful duplicate (its penalty stays applied, but the boost still outranks the unboosted distinct development); widening changes within-interest ordering without any eligibility gain on this corpus (the derived terms `model`, `acme`, `atlas` only match items the original terms already matched). Topic drift does not rise in any arm — the invariant tests confirm negative and no-feedback histories never erase an explicit interest match, the recency arm reweights only items with recorded events, the cumulative per-item boost is capped at the flat useful step so overlapping interests cannot reverse an explicit not_useful penalty, and the expired-boost variant restores baseline behavior exactly — but no candidate improves any gated axis, so the recorded threshold adopts none of them. The deterministic-v3 baseline is retained; richer adaptation remains an evaluated non-adoption with recorded revisit triggers, not a feature.

## History comparison replay (issue #26)

Issue #26 requires measuring whether basic grouping plus publication/score history answers "what has changed since last week?" before adopting richer historical tracking. The replay (`evaluateHistoryComparisons` in `src/history-evaluation.ts`) populates a throwaway production-schema database through the shipped ingest and grouping paths — two recorded source waves ten days apart, grouped per wave with the production planner — then settles all derived work deterministically (no providers) and replays the recorded retention outcome for the labeled expired item through the shipped purge path (`purgeItemFeedText`). It answers four recorded development queries over a fixed seven-day window ending at the recorded replay instant, two ways on the same database:

- **Baseline arm** — the pre-#26 capability, composed exactly as a connecting agent must: one `search_items` window (`since`/`until` applies to `items.ingested_at`, as shipped) per development, then `get_item` for each hit; stored report dates are preserved exactly as the shipped reads return them — a missing date stays null and is flagged unknown, never substituted — and no shipped surface records or classifies the change itself.
- **Adopted arm** — the recorded change-evidence read (`get_development_changes` over the append-only `story_change_events` written at ingestion and grouping-correction time), with event kinds classified by recorded kind and unknown dates carried as explicit nulls.

The labeled corpus, [history-comparison-corpus-v1](../tests/fixtures/history-comparison-corpus-v1.json), spans four developments and six items: a retracted benchmark claim (correction to an already-ingested item), a widened product recall whose retained text expires under the recorded retention policy before the replay reads (second correction), an unchanged verbatim republication of the retraction (repeat coverage, labeled no_update), a broad-topic weekly industry digest sharing the query vocabulary (decoy, unlabeled development), a genuinely new research preview (new development), and an undated discussion item (missing report date).

Reproduce:

```sh
bun run cli evaluate-history-comparisons tests/fixtures/history-comparison-corpus-v1.json
# Optional local timing observation is emitted to stderr, not the deterministic report:
bun run cli evaluate-history-comparisons tests/fixtures/history-comparison-corpus-v1.json --timing
```

The [history-comparisons-v1](baselines/history-comparisons-v1.json) baseline records the replay deterministically — fixture item ids, never store UUIDs; a test verifies a fresh run matches it exactly.

Recorded findings (2026-11-16 fixture metrics; see the baseline for the corpus hash):

| Measure                                              | Baseline (windowed search + story reads) | Adopted (recorded change evidence)        |
| ---------------------------------------------------- | ---------------------------------------- | ----------------------------------------- |
| Meaningful-update recall (labeled corrections)       | 0/2 (0.0)                                | 2/2 (1.0)                                 |
| Window hits presented without change evidence        | 2 (incl. the unchanged republication)    | 0 claimed-update false positives          |
| Invented chronology (dates not stored by the source) | 0 (both arms preserve null dates)        | 0 (unknowns reported as unknown)          |
| Expired-content updates retrievable                  | 0/1 (index cleared with the text)        | 1/1 (citation, detail marked unavailable) |
| Labeled coverage recall                              | 2/2 (1.0)                                | 2/2 (1.0)                                 |
| Provider calls                                       | 0                                        | 0                                         |

Interpretation preserved in decision [D18](decisions.md): the baseline answer is not merely incomplete — it is _silently_ wrong in two recorded ways. Corrections to known items are invisible to every documented windowed read (a correction updates `content_versions`, never `items.ingested_at`), and repeat coverage is indistinguishable from claimed updates (both surface as plain hits). A third limitation is attributed explicitly rather than counted as invented chronology: the baseline window filters on `items.ingested_at`, not on the source's declared report date (a re-publication of an old story counts as "this week"), and an undated item keeps a null report date in both arms — the shipped reads never substitute ingestion time for it. Retention makes the retrieval gap worse for expired content: the keyword index no longer reaches the recall item at all, and even an unbounded manual scan finds no diffs — the evidence is destroyed with the text. The adopted read closes all of the measured gaps: the corrections are recorded events with bounded added/removed-term evidence recorded at change time, the unchanged republication is recorded and reported as new coverage of an unchanged story (never as a claimed update), the decoy never enters the development (its grouping membership remains its own), the unknown report date survives as an explicit null with the observation time labeled as an observation, and the expired recall stays citable with `detail_available: false`. The recorded evidence never establishes that any claim — including a retraction — is true; the uncertainty envelope in every response states this.

Not measured here and recorded as unknown: real-world usefulness over the recorded fixture ("what changed" quality on live sources), monetary cost of the local event writes beyond the already-required ingest, and whether connecting agents in practice compose the read correctly. Regrouping-corrected revisions (a membership that later moves developments) are covered by deterministic behavior tests in `tests/dev-changes.test.ts` rather than the replay corpus.

The adoption threshold was fixed in code (`ADOPTION_THRESHOLD`) before the replay result was observed; it requires a measured baseline gap, perfect adopted recall with zero claimed-update false positives, zero invented chronology, full expired-content citability, no coverage regression and zero provider calls — every gate met on this corpus.

## Event alert replay (issue #27)

Issue #27 requires measuring, before adoption, whether the daily digest misses time-sensitive high-value developments. The replay (`evaluateAlerts` in `src/alert-evaluation.ts`) populates a throwaway production-schema database through the shipped ingest paths and replays a labeled corpus of six items across seven recorded observation instants over one ascending timeline — wave ingestion, the shipped daily-digest publication instants (06:00 Europe/London, including the 2026-10-25 BST→GMT fallback) and 30-minute alert ticks. All derived work is settled deterministically at each instant (recorded fixture analysis, shipped grouping, scoring and retention; no providers), and each tick runs the shipped `AlertWorker.evaluate` and the shipped draft digest on the same store. The replay installs a counter-seeded UUID generator for its duration so store ids never perturb curation tie-breaks; a fresh run reproduces the recorded baseline byte-for-byte.

The labeled corpus, [alert-evaluation-corpus-v1](../tests/fixtures/alert-evaluation-corpus-v1.json), contains: a river-defence coordination incident (`incident-1`, labeled `alert_time_sensitive`), a rapidly-updating tremor event (`quake`, labeled `alert_update`, two recorded changed-facts observations), a verbatim republication of that update (`repeat-1`, labeled `repeat_coverage`), a flood-warning update observed inside quiet hours across the DST change (`dst-1`, labeled `alert_time_sensitive`, 12h horizon), a slow low-priority historical piece (`evergreen-1`, labeled `no_alert`) and an off-interest vendor release (`atlas-1`, labeled `no_alert`). The alert candidate settings were fixed in code before the replay ran: `minScore` 75, `minEvidence` 60, quiet hours 22:00–07:00 Europe/London, 12h per-development cooldown, 3/day cap, one opt-in destination.

Reproduce:

```sh
bun run cli evaluate-alerts tests/fixtures/alert-evaluation-corpus-v1.json
# Optional local timing observation is emitted to stderr, not the deterministic report:
bun run cli evaluate-alerts tests/fixtures/alert-evaluation-corpus-v1.json --timing
```

The [alert-evaluation-v1](baselines/alert-evaluation-v1.json) baseline records the replay deterministically; a test verifies a fresh run matches it exactly and that two runs in one process agree.

Recorded findings (fixture metrics; see the baseline for the corpus hash):

| Measure                                              | Baseline (daily digest only)                              | Candidate (opt-in alerts)                                  |
| ---------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------- |
| Labeled alert-worthy events delivered within horizon | 1/4 (0.25)                                                | 3/4 (0.75)                                                 |
| Missed alert-worthy events                           | `incident-1` (20.0h), `quake#1` (21.0h), `quake#2` (6.5h) | `quake#2` (7.5h: quiet-hours send at the 07:00 quiet end)  |
| False alerts (repeat coverage / no-alert items)      | n/a (no alerts exist)                                     | 0                                                          |
| Alert volume vs labeled alert-worthy events          | 0 (frozen, no channel)                                    | 4 vs 4 (one per recorded event observation)                |
| Suppressed candidate evaluations, with reasons       | n/a                                                       | 6 recorded (2 priority, 1 off-interest, 1 repeat, 2 kinds) |
| Provider calls                                       | 0                                                         | 0                                                          |

Measurement is per labeled alert-worthy event observation: the first recorded coverage of an `alert_time_sensitive` item and EVERY recorded changed-facts update of an `alert_update` item (`quake#1`, `quake#2`). An earlier recording that measured only each item's first update reported the candidate at 3/3 and an adoption; review finding 1 corrected the measurement to classify all firings, and the correction changes the outcome — quake's second update was observed at 22:30 inside quiet hours, its alert froze immediately but its send was legitimately scheduled for the 07:00 quiet end, which is 7.5h after observation, beyond quake's recorded 6h horizon. The corrected replay therefore records a candidate miss.

Interpretation preserved in decision [D19](decisions.md): the digest cadence is the measured gap — everything observed between two editions waits for the next 06:00 publication, and three of the four labeled alert-worthy events exceeded their recorded horizons on the baseline. The candidate closes most of that gap without noise — triggers are only the recorded `story_change_events` surface from issue #26, so a high-scoring article with no recorded change evidence never alerts, URL-only edits record no new facts (bodies or headlines changed) and are suppressed as cosmetic, verbatim republication is suppressed as repeat coverage through membership-history attribution (first coverage is recorded before grouping resolves, with no group assigned yet), and slow news stays below the fixed priority threshold — but the quiet-hours discipline and a tight usefulness horizon genuinely conflict: an urgent update observed at 22:30 cannot deliver before 07:00, so quake#2 missed its horizon. Under the threshold fixed before the replay, that honest miss records as a non-adoption at the recorded settings. Every alert and every suppression persists why it fired or stayed silent (decision snapshot with the recorded evidence, thresholds, score reference and suppression reason per local day); scores must be current in exactly the same sense the digest requires (a pending or refreshing score defers the batch and retires nothing), and a regrouped development's pending alert is cancelled atomically at the shared claim/send boundary before any provider contact.

Not measured here and recorded as unknown: alert usefulness on live sources (the corpus is synthetic), monetary send cost per alert (the replay contacts no provider — cost is recorded as unknown, not zero), and real-client behavior of the opt-in destination. Alert delivery reuses the shipped outbox rules, so crash-after-send, idempotency-expiry, cancellation and default-disabled contracts are covered by focused deterministic tests in `tests/alerts.test.ts` rather than the replay corpus. Normal ingestion availability is unaffected by construction: evaluation reads already-recorded rows in short per-event transactions and runs on the same scheduler stage boundary as polling, never holding a transaction across network work.

## Newsletter replies replay (issue #28)

Issue #28 requires evaluating the "reply to the newsletter" conversational entry point before adoption. The replay (`evaluateNewsletterReplies` in `src/replies-evaluation.ts`) drives the shipped signed-verified inbound path, newsletter indexing, frozen-edition reads and the retention purge on a throwaway production-schema database — no provider, no send path, no AI call:

```sh
bun run cli evaluate-newsletter-replies tests/fixtures/newsletter-replies-corpus-v1.json
```

The [newsletter-replies-v1](baselines/newsletter-replies-v1.json) baseline records the replay deterministically (a test re-verifies byte-exact reproduction, including a poisoned-`fetch` run asserting the shipped path makes no network call).

| Scenario                                | Shipped behavior (measured)                                                                              | Verdict                             |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Valid reply from the recorded recipient | Indexed as an inbound newsletter original attributed to whatever the From header claims                  | `indexed_without_verified_sender`   |
| Spoofed sender                          | Indexed identically to the genuine reply; no recorded field distinguishes the spoof                      | `indexed_without_verified_sender`   |
| Forwarded thread                        | Attributed to the forwarder only; quoted original identity unrecorded                                    | `attributed_to_forwarder_only`      |
| Duplicate provider event                | Deduplicated by recorded provider identity: one row, no second claim                                     | `deduplicated_by_provider_identity` |
| Auto-responder loop                     | No shipped outbound capability; zero loop risk today — adoption would create the surface                 | `no_outbound_capability`            |
| Missing/unknown edition                 | No recorded delivery matches; correlation unresolvable                                                   | `correlation_unresolvable`          |
| Expired reply context                   | Citation survives, frozen edition bytes unchanged, extracted text purged                                 | `citations_survive_context_expired` |
| Same question over MCP                  | Authenticated `get_digest`/`search_items`/`get_item` answer with source-linked citations and uncertainty | `answered_with_citations_over_mcp`  |

Decision recorded in [D20](decisions.md): the adoption threshold (fixed in code as `ADOPTION_THRESHOLD`) fails on sender verification and edition correlation, and the MCP-equivalence arm shows the client can already reach the same scoped knowledge. Non-adoption recorded with revisit triggers; no reply channel code ships.

## Web interface task replay (issue #31)

Issue #31 requires evaluating an optional discovery-focused web interface with concrete user tasks and recorded evidence that MCP/CLI do or do not cover them. The replay (`evaluateWebInterface` in `src/web-interface-evaluation.ts`) defines five tasks spanning the issue's scope and performs every step through the shipped surfaces — the real registered MCP tool handlers driven by the official SDK client over an in-memory transport pair (production `createMcp` code, no sockets), and, for the tasks the CLI also covers, the shipped CLI verbs that call the identical application services — against a throwaway production-schema store seeded through the shipped poll, discovery-run (recorded fake provider), grouping/scoring settle and immutable-edition-freeze paths. No provider, no network, no email.

The recorded corpus, [web-interface-corpus-v1](../tests/fixtures/web-interface-corpus-v1.json), contains two RSS waves (one development with anchor plus repeat coverage), two pre-recorded discovery results, one trigger-query result, a persistent interest profile plus its recorded update, and one frozen-edition definition. The adoption threshold was fixed in code (`ADOPTION_THRESHOLD`) before the replay ran.

Reproduce:

```sh
bun run cli evaluate-web-interface tests/fixtures/web-interface-corpus-v1.json
# Optional local timing observation is emitted to stderr, not the deterministic report:
bun run cli evaluate-web-interface tests/fixtures/web-interface-corpus-v1.json --timing
```

The [web-interface-v1](baselines/web-interface-v1.json) baseline records the replay deterministically (a test re-verifies byte-exact reproduction and runs the whole replay once with a poisoned `fetch`); a further test exercises the recorded CLI verbs end to end on a throwaway database.

Recorded findings (fixture metrics; see the baseline for the corpus hash and the exact registered tool contract):

| Task (issue #31 scope)                       | Shipped steps that completed                                                                                                                           | Covered by |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| Understand a discovery + ranking explanation | `search_items`, `get_discoveries`, `get_item` (analysis provenance, `latest_score`), `explain_ranking` (criteria version, exclusions)                  | `mcp-tool` |
| Run a budgeted discovery query               | `trigger_discovery` preview → confirm over the shared budget ledger (same fixture-day budget as the seeded run); results listed with origin provenance | `mcp-tool` |
| Configure interests                          | `get_interests`; `update_interest` preview → confirm appends the immutable version; replayed token rejected                                            | `both`     |
| Give explicit feedback (item/edition/query)  | `submit_feedback` preview → confirm; `get_feedback`; `discovery_result_feedback` refinement row recorded                                               | `both`     |
| Review developments + history                | `search_items`, `get_story_group`, `get_development_changes`, `get_digest` (frozen + list); frozen bytes unchanged under feedback                      | `mcp-tool` |

Measured gates: 20/20 recorded task steps completed through shipped surfaces; 0 steps uncovered (`uncoveredSteps: []`, `uiOnlySteps: []`); 2 recorded fake-provider requests (seeded run and confirmed run on the same fixture `budget_day` — the confirmed dispatch runs on an injected fixture clock, so the budget evidence never depends on the replay's execution day); 0 UI-transport or email side effects; the preview/confirm token stayed single-use, and a separate fresh-token probe verified payload binding as a real hash comparison (equal document accepted with no profile write, altered document rejected with `payload_changed`); the frozen edition stayed byte-identical under not-useful edition feedback. The replay rejects itself instead of emitting a decision when a recorded step does not complete. A review correction fixed two overstated CLI halves (findings 3/4 of PR #82): `discovery-runs`/`search` expose no discovery-result origin provenance and no CLI verb reads a frozen edition or edition history (`digest-preview` rebuilds a draft from current state), so three `mcp-tool`-only tasks — discovery explanation, budgeted dispatch, developments/history — record a CLI convenience gap in rendering, not capability, which is exactly the conversational role D8 assigns to the connecting client. Coverage is derived from the recorded steps, never asserted per task.

Interpretation preserved in decision [D21](decisions.md): the adoption threshold requires a step no shipped surface can perform; none exists. Non-adoption recorded with revisit triggers; no UI code ships.

## Browser extraction evaluation (issue #24)

Issue #24 required a recorded evaluation of permitted browser extraction, closed by either a tested optional adapter or a justified non-adoption. The replay (`evaluateBrowserExtraction` in `src/browser-extraction-evaluation.ts`) runs the shipped HTTP-only extraction path for each of five corpus records — issue #17's manual-submission intake, the shipped extract job claim/complete flow and the shipped `HttpContentExtractor` (issue #3) over recorded fake DNS and transport — and consults a browser arm whenever the HTTP arm does not record complete coverage: extraction failure, or an "extracted" body that misses the record's recorded expected-content markers (`expectedHttpContent`), which is coverage `partial` rather than proof that no content is missing. The corpus schema restricts permission-denied records to the refusal arm, a transient 429/503 is recorded through the shipped `failProcessing` lifecycle while the replay rejects itself rather than emitting a decision from an incomplete HTTP attempt, the daily-render-budget gate is derived from the adapter's daily-budget state, and the decision is derived from the qualifying gates rather than a literal. The browser arm is a simulated recorded adapter: renders come pre-recorded in the corpus and the adapter enforces the contracts adoption would need — destination validation (the manual-submission discipline), permission refusals before any render, per-render timeout and memory budgets, concurrency and daily render budgets, and crash isolation. The adoption threshold was fixed in code (`ADOPTION_THRESHOLD`) before the replay ran.

The corpus, [browser-extraction-corpus-v1](../tests/fixtures/browser-extraction-corpus-v1.json), covers the issue's scope: an ordinary permitted static page (HTTP baseline), a genuinely HTTP-inaccessible but permitted-to-render JavaScript-only page, a blocked Reddit discussion found through #17's permitted paths, and an anti-abuse captcha interstitial.

Reproduce:

```sh
bun run cli evaluate-browser-extraction tests/fixtures/browser-extraction-corpus-v1.json
# Optional local timing observation is emitted to stderr, not the deterministic report:
bun run cli evaluate-browser-extraction tests/fixtures/browser-extraction-corpus-v1.json --timing
```

The [browser-extraction-v1](baselines/browser-extraction-v1.json) baseline records the replay deterministically — tests re-verify byte-exact reproduction, the blocked-Reddit-stays-unavailable assertion and a poisoned-`fetch` no-egress run, and exercise the adapter's budget/refusal/crash contracts directly.

| Record (issue #24 scope)   | HTTP-only outcome (shipped path)             | Browser arm (simulated, recorded)                                                               |
| -------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Permitted static article   | extracted, complete coverage, 327 text chars | not needed; no render attempted                                                                 |
| JavaScript-only page       | unavailable, `Page unavailable` (JS shell)   | rendered +358 text chars at declared 4.2 s / 512 MB, inside budgets; capability probe           |
| Readable placeholder shell | extracted, partial coverage, 17 text chars   | rendered +219 text chars at declared 4.5 s / 512 MB, inside budgets; capability probe           |
| Blocked Reddit discussion  | unavailable, `HTTP 403`                      | refused — anti-abuse control; render would circumvent a platform restriction; stays unavailable |
| Captcha interstitial       | unavailable (shipped interstitial detection) | refused — anti-abuse challenge; no render measured or recorded                                  |

Recorded gates: `qualifyingLiftRecords: []` and `recordsQualifyingOnAccessPermittedAffordability: ["js-only-app-report", "js-shell-loading-placeholder"]` — the records that are HTTP-inaccessible (including partial coverage), permitted and affordable all fail the grounding condition (capability probes, not observed pipeline loss); `partialHttpCoverageRecords: ["js-shell-loading-placeholder"]`; `blockedRedditResponseStaysUnavailable: true`; `circumventionAttempts: 0`; Reddit post-ID provenance preserved through the submission path; every non-qualifying record carries an explicit rejection reason; 2 recorded renders used of 10 per day with `dailyRenderBudgetExhausted` derived from the adapter's daily-budget state; 0 live browser launches, 0 live network egress, 0 browser-dependent requirements in core.

The decision ([D22](decisions.md)) is non-adoption: the shipped HTTP-only extraction already covers every observed permitted use case, the blocked Reddit response stays unavailable rather than circumvented, and no browser capability is validated in any default test path. Revisit triggers are recorded in D22.

### Live measurement (recorded out-of-band; clearly labelled; not part of the deterministic baseline)

Everything above is a deterministic recorded replay with zero egress. Separately, while recording this evaluation, a bounded live capability probe was performed in the recording environment to answer the issue's "is a browser tool even available here" question first:

- **Scope:** an `agent-browser` CLI was present in the environment; it launched its bundled Chrome 155.0.8059.84 against a **localhost-only** page served during the recording. No third-party page and no Reddit URL was navigated, and no external egress occurred.
- **Observed:** the browser launched and executed the page's JavaScript (page open 94 ms and agent-readable text 14 ms against a warm daemon; plain `curl` 26 ms on the same page — warm, single local page). During the probe, at least three Chrome renderer processes were resident (~556 MB total RSS). The CLI itself warned that Chrome 155 is **729 CVEs behind stable** (`agent-browser install` advised).
- **Not measured / not run (recorded as unknown):** any third-party page traversal or Reddit request — deliberately outside the recorded authorization, since the recorded decision treats Reddit's block as an anti-abuse control that a browser render must not defeat; cold-start, binary download and update cadence beyond the CLI's own warning; and any sustained per-page cost distribution.
- **Status:** these are environment-specific observations made at recording time. They are **not** part of `browser-extraction-v1.json` (which must stay byte-reproducible); the baseline records only a fixed pointer to this section. Default tests launch no browser and make no network calls.
