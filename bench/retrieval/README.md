# Retrieval benchmarks for coding harnesses

The useful comparison is whether a tool returns the code a harness needs, not
whether it can produce a convincing explanation. This suite measures ranked
**file retrieval** with fixed public tasks, exact source snapshots, and gold
labels kept outside the searchable corpus.

Two independent datasets are supported:

- **[RepoQA](https://github.com/evalplus/repoqa)** semantic function descriptions,
  adapted to finding the containing file. The original SNF evaluation requires
  returning the function and uses syntax similarity; our numbers are **not
  official RepoQA SNF scores**. We search the dataset's provided source snapshot,
  which can be a subset of the full upstream repository. The pinned June 2024
  release contains six language categories; its Express sample is JavaScript
  despite the dataset's `typescript` label.
- **[SWE-bench Verified](https://www.swebench.com/SWE-bench/guides/datasets/)** issue
  descriptions, adapted to finding preexisting files changed by the gold fix.
  Each checkout is at its exact `base_commit`; the patch is only an oracle for
  scoring. These are **localization results, not issue-resolution scores**.
  See [adapter details](SWE-BENCH.md).

## Baselines

| Method | What it does |
| --- | --- |
| `grep` | One real `rg` command: fixed literal query terms, case insensitive OR, ranked by matching-line count and path tie-break. No oracle keywords. This is mechanical grep, **not an agent choosing and revising grep commands**. |
| `bm25` | Standard file-body BM25 (`k1=1.2`, `b=.75`), with camel-case token splitting. No extracted facts, TypeSafe calls, or learned embeddings. |
| `bm25f` | The library's zero-call lexical search over path, facts, and body. It is lexical retrieval, not dense RAG. |
| `dense` | Actual local MiniLM embeddings, overlapping complete-source token windows, cosine ranking and maximum chunk score per file. This measures the retrieval component of a basic RAG system, **not an optimized code-specific RAG system or generated answers**. |
| `s1s` | The production `find` API with its unchanged TypeSafe questions, thresholds, shortlist, evidence verification and walk fallback. |

All methods see the same indexed source bodies and the same unmodified query.
Grep receives only explicit paths with an available `index.text` body; unsupported
extensions, oversized files and unavailable content are not extra evidence for
grep. Paths without bodies can still be known to path-aware methods. The pinned
checkouts are immutable and audited against the indexed text. Target
names, gold paths and patch text are never sent to a retriever. Sampling is a
seeded hash ordering, performed before examining answers; no success-based
selection or replacement. There is no tuning on this sample.

## Reproduce RepoQA

Node 24, pnpm, Git and ripgrep are required. TypeSafe runs use the existing
`TYPESAFE_API_KEY` in `.env`. Downloads and results stay under `.cache/`.

```sh
pnpm bench:retrieval:prepare
# Default: fixed seed, 1 repository/category, 5 queries/repository = 30 queries.
# Full published release: --repos-per-language 10 --queries-per-repo 10

pnpm bench:retrieval --export-corpus .cache/bench/dense-input.json
# Set up the optional CPU embedding environment per dense-usage.md, then:
.cache/bench/venv/bin/python bench/retrieval/dense.py \
  --input .cache/bench/dense-input.json \
  --output .cache/bench/dense-results.json --cache .cache/bench/dense
pnpm bench:retrieval --runs 3 --methods grep,bm25,bm25f,s1s,dense \
  --dense-results .cache/bench/dense-results.json \
  --out .cache/bench/retrieval-results.json
```

[Dense environment and chunking details](dense-usage.md). Model weights are
pinned to a commit and remote model code is disabled. Corpus and query hashes
must match before dense rankings are scored. To run without a paid API call,
use `--methods grep,bm25,bm25f`; add `dense` after producing its results.

`--reuse-results previous.json` requires recorded per-method implementation
fingerprints (executable source plus runtime versions), dataset provenance,
source-content hashes and exact query/gold-task hashes. Legacy results or changed
implementations fail before a run starts; omit reuse to measure them again.
Changed source or task content is remeasured instead of reusing stale rankings
or scores. Source-file hashing is conservative: changing a shared benchmark
module can invalidate several methods even when only one algorithm changed.
Historical published rows without these fingerprints remain valid observations
of their recorded run, but are not silently marked reusable.

## Metrics and reporting

- Hit@1/5/10: did at least one relevant file appear in that many results?
- Recall@5/10: what fraction of all relevant files appeared? This differs from
  hit rate on multi-file SWE-bench fixes.
- MRR@10 and nDCG@10: rank-sensitive retrieval quality.
- Latency: per-query p50 and p95; index/model setup is reported separately.
- Calls, reported input tokens and estimated TypeSafe input cost; failed or
  retried calls can have unreported spend. Local methods have no API charge,
  but CPU, memory and embedding index construction are not free resources.
- Context bytes: full source bytes of the top five files, not an exact token
  budget or a claim about how much a coding agent will actually read.

Every failed query remains in the denominator as a miss. `s1s` is repeated
three times; deterministic methods run once. Per-run quality and every query's
ranked paths are saved, so disagreement and regressions remain inspectable.
Each method returns its natural ranked list up to ten: `s1s` may return fewer
than ten, which can reduce its recall relative to wider retrieval.

These small samples test the harness and expose failures. They do not establish
universal superiority, agent task completion, repository completeness, or a
leaderboard result. End-to-end coding-agent comparisons would additionally need
a fixed agent model, tool budgets, edit/test harness and full task evaluation.

See [measured results](RESULTS.md) for the checked run, including where dense
retrieval retains more relevant candidates than `s1s`.
