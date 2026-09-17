# Recall architecture iteration — 2026-09-17

The earlier file search used a broad descriptor shortlist but evidence-checked
only six semantic winners plus two lexical candidates. On the fixed RepoQA
sample, all five persistent top-five misses had already reached the candidate
stage. Their evidence was often discarded before verification. Merely widening
the first lexical pool would not address those losses.

## Changes evaluated separately

- **Baseline:** commit `8305f7e`; existing source descriptors and 6+2 verification.
- **A, width:** commit `6031cd5`; reserve up to 16 descriptor winners and eight
  additional lexical candidates for evidence verification in one shared call.
- **B, evidence:** commit `d184602`, including A; show two query-matching source
  windows before shortlisting can discard a large module. Verification sees
  relevant private/late declarations and the extracted file comment, not just
  a truncated UI hint and the first exported names.

Every returned path is still evidence-judged. No unjudged padding, generated
query expansion, embeddings or LLM interpreter were added to the engine. The
model's yes/no judgment remains separate from deterministic ranking and caps.
No questions or accepted answers were reworded to fit individual rows.

## Paired measurements

All stages ran serially using the updated TypeSafe key through environment
injection, with no credential value in reports. The provider identified itself
as `jev-1.13.0`. Each query was repeated three times for each compared variant.

| Suite / variant | Unique queries | Hit@1 | Hit@5 | Hit@10 | Hit@20 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Development RepoQA / baseline | 30 | 80.0% | 83.3% | 83.3% | 83.3% |
| Development RepoQA / A | 30 | 78.9% | 84.4% | 91.1% | 93.3% |
| Development RepoQA / B | 30 | 82.2% | 90.0% | 92.2% | 93.3% |
| Development SWE-bench / baseline | 12 | 75.0% | 83.3% | 83.3% | 83.3% |
| Development SWE-bench / A | 12 | 77.8% | 91.7% | 91.7% | 91.7% |
| Development SWE-bench / B | 12 | 83.3% | 91.7% | 91.7% | 91.7% |
| Held-out RepoQA / baseline | 30 | 90.0% | 96.7% | 96.7% | 96.7% |
| Held-out RepoQA / B | 30 | 94.4% | 96.7% | 96.7% | 96.7% |

The held-out repositories were reserved before the candidates were evaluated:
WasmEdge, nuclei, flink-ml, Poetry, LibAFL and openai-node. They are the second
repository per dataset category in the existing fixed hash ordering; all six
were excluded from the development sample. This checks transfer to new repos,
though it is still a small sample of the same public benchmark family.

Across all 72 unique queries / 216 paired observations, B changed hit@5 from
**88.9% to 93.1%**, hit@10 from **88.9% to 94.0%**, and hit@20 to **94.4%**.
Hit@1 changed from 83.3% to 87.5%. The new-repository top-five score was preserved,
not improved; the larger gains came from the development suites. Do not describe
this as a universal improvement or a result on the full official benchmarks.

## Cost, failures and interpretation

Median query wall time rose from **405 ms to 582 ms**. Reported successful input
cost for the 216 observations rose from **$0.3183 to $0.4842** (about $0.00224 per
B query), approximately 52% more. Wider verification spends more tokens to retain
useful alternatives. Provider failures/retries may have unreported spend.

B had one 30-second provider timeout during optional fallback on the development
RepoQA sample. It remains a miss in every table; it was not silently retried or
dropped. The other compared suites had no failures. That trace exposed a separate
robustness problem: successful verification results should not disappear merely
because optional further exploration times out. Recovery changes are tested
separately from the accuracy measurements reported here.

The timed-out run had already verified candidates before the failure. Raw traces
include candidate inclusion, shortlist rank, verification judgments, returned
rank, model, cost and timing. This makes it possible to distinguish retrieval,
shortlist, evidence-ranking and operational losses. Scores remain file-localization
adaptations, not official RepoQA function pass@1 or SWE-bench fix-resolution scores.
[Frontier-model reference protocols](FRONTIER-REFERENCES.md) are intentionally
kept separate rather than presented as comparable hit-rate rows.

## Final release validation

The integrated engine at `cba1058` was then measured for three fresh runs per
query, including optional-expansion recovery and cleanup. These are additional
runs, not replacements for the ablation results or their timeout above.

| Suite | Observations | Hit@1 | Hit@5 | Hit@10 / 20 |
| --- | ---: | ---: | ---: | ---: |
| Development RepoQA | 90 | 80.0% | 90.0% | 93.3% |
| Development SWE-bench | 36 | 83.3% | 91.7% | 91.7% |
| Held-out RepoQA | 90 | 92.2% | 96.7% | 96.7% |
| Combined | 216 | 85.6% | 93.1% | 94.4% |

All 216 completed without an error, degraded fallback or unverified returned
path. The combined baseline was 83.3% hit@1 and 88.9% hit@5/10/20. Total reported
cost was $0.4933 (about $0.00228 per query), 55% above baseline. Per-suite median
latencies were 582, 566 and 558 ms respectively. Top-one variation between the
ablation and final runs is why repeated measurements remain necessary.
The three `release-*.json` files preserve the exact engine hash and raw rows;
the deployed catalog's engine revision was checked against that hash. Subsequent
mobile scrolling and recorded-playback changes affect only the UI.

## Reproduce and inspect

[`iteration.ts`](iteration.ts) runs a chosen engine checkout against an immutable
manifest and records executable-source hashes plus dataset/task/source hashes:

```sh
node --env-file=.env bench/retrieval/iteration.ts \
  --engine /path/to/frozen/s1s-checkout \
  --manifest .cache/bench/repoqa/manifest.json \
  --label candidate --runs 3 --out .cache/iteration/candidate.json
```

[Raw measurements and selected query metadata](iterations/2026-09-17/) contain
all runs, including failures. The selection files omit local directory paths;
use the preparation tools to materialize their pinned public snapshots. Gold
paths are used only by the evaluator, never the search client. The earlier
[measurement report](RESULTS.md) remains unchanged as historical evidence.
