# Measured retrieval results — 2026-09-17

These small, fixed **file-localization** samples are not official RepoQA SNF
scores, SWE-bench issue-resolution scores, or a comparison of complete coding
agents. [Methodology and reproduction](README.md). No question or threshold was
tuned against these rows. All attempts completed without errors.

## RepoQA source snapshots

30 questions: five from one seeded repository in each of six dataset categories.
The `typescript` category selected Express, whose files are JavaScript. s1s ran
three times (90 observations); deterministic baselines ran once.

| Method | Hit@1 | Hit@5 | Hit@10 | MRR@10 | Query p50 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Literal OR/count grep | 13.3% | 53.3% | 66.7% | .298 | 13.3 ms |
| Plain BM25 | 56.7% | 80.0% | 90.0% | .673 | .8 ms |
| s1s lexical BM25F | 43.3% | 76.7% | 86.7% | .572 | .4 ms |
| MiniLM dense retrieval | 63.3% | 93.3% | 96.7% | .748 | 46.5 ms |
| s1s | 78.9% | 83.3% | 83.3% | .811 | 370.0 ms |

s1s hit@1 was **76.7%, 80.0%, 80.0%** across the three runs. Reported successful
input usage cost approximately **$0.1304 total** for 90 searches, or $0.00145 per
question, at the configured input price.

The tradeoff matters: s1s led first-result accuracy here, while dense retrieval
found a relevant file in its top five more often. s1s returns a smaller verified
set and does not retain every candidate that a wider retriever finds. This
sample does not support replacing all RAG with s1s.

Dense retrieval used the general sentence model
`sentence-transformers/all-MiniLM-L6-v2`, pinned to
`1110a243fdf4706b3f48f1d95db1a4f5529b4d41`, on CPU with four threads. Its 15,115
complete-source chunks took about 239 seconds of cold encoding across the six
corpora. Query timings exclude model loading and corpus indexing. Hardware
scheduling and network variation make these indicative latencies, not a
controlled performance leaderboard.

[Per-query rankings, source revisions, hashes and setup costs](repoqa-2026-09-17.json).

## SWE-bench Verified issue localization

12 seeded issues across eight projects at exact pre-fix commits, with 13 relevant
preexisting files. No issues were excluded or replaced. s1s ran three times
(36 observations); lexical baselines ran once. **Dense retrieval was not run on
this sample**; its measured comparison is the RepoQA table above.

| Method | Hit@1 | Hit@5 | Recall@5 | MRR@10 | Query p50 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Literal OR/count grep | 8.3% | 8.3% | 8.3% | .094 | 39.1 ms |
| Plain BM25 | 25.0% | 50.0% | 50.0% | .336 | 52.6 ms |
| s1s lexical BM25F | 16.7% | 50.0% | 50.0% | .273 | 2.3 ms |
| s1s | 75.0% | 86.1% | 86.1% | .806 | 367.0 ms |

s1s hit@1 was 75% in each run; estimated successful-input cost was $0.0647 for
all 36 searches. The fixed SymPy issue was missed in every run; Django `14792`
appeared in the top five in only one of three runs. Those failures remain in
the reported denominators.

[Per-query rankings and exact checkout revisions](swebench-2026-09-17.json).

## Limits of this comparison

- Grep uses one fixed OR/count command. A capable coding agent can choose better
  terms, inspect results and search again; that workflow was not benchmarked.
- MiniLM is a general sentence encoder, not a tuned code-specific retrieval stack.
- The samples are small and public. No significance, contamination-free or
  state-of-the-art claim is made. Use the full import options for broader testing.
- Retrieval quality does not establish that an agent can implement a fix or
  understands the whole repository. No editing agent or resolution harness ran.
- Cost uses the configured token price and reported successful usage; it excludes
  hosting, hardware, failed calls and unreported retry billing.

## Public demo smoke results

The five demo repositories also have separately authored smoke gold in
`bench/public/`. These are development checks, not independent benchmarks.
A broad Rust ignore-file flow question retrieved none of its three required
units across three runs, while the shorter suggested ignore-file question
produced a connected chart. Broad-query subject selection remains a limitation;
the failing gold was preserved without rewording it.
