# Published frontier-model references

Checked **2026-09-17** against primary papers and official result files. These
are published observations, not new runs by s1s. None is directly comparable to
our file-localization hit@5/10: their tasks, outputs, corpora or scoring differ.
Keep them separate from [our measured retrieval results](RESULTS.md).

## Which benchmark is which?

| Name | Task | Direct comparison with our current retrieval scores? |
| --- | --- | --- |
| [RepoQA](https://evalplus.github.io/repoqa.html) | Find and return a matching function from supplied long code context | No: our adaptation returns ranked files across a source snapshot |
| [CodeQA (EMNLP 2021)](https://github.com/jadecxliu/CodeQA) | Generate an answer to a question about a supplied Java/Python snippet | No: answer generation, not repository retrieval |
| [CodeRepoQA (December 2024)](https://arxiv.org/html/2412.14764v1) | Predict a maintainer response from a GitHub issue conversation | No: dialogue-response similarity, not file ranking |
| [Code-QA-Bench (May 2026)](https://arxiv.org/html/2605.29277v1) | Answer repository questions with controlled code/documentation access | No: judged QA quality, not retrieval hit rate |

## RepoQA: official historical reference

The official SNF protocol uses **16,384 code tokens** (CodeLlama tokenizer),
plus the question/instructions. Passing requires the returned function to be
the closest match to the target and reach the selected similarity threshold
(default **0.8**, BLEU method 4). The original evaluation has 500 questions:
five languages × ten repositories × ten functions.
[Protocol](https://evalplus.github.io/repoqa.html).

The following values were checked both in the
[leaderboard JSON](https://evalplus.github.io/results/repoqa/COMBINED-RESULTS.json)
and individual score files in the official
[16K score archive](https://github.com/evalplus/repoqa/releases/download/dev-results/ntoken_16384-scores.zip).
The field is `scores.all["0.8"]["pass@1"]`; raw task records independently give
the same numerator/denominator.

| Exact model identifier | SNF pass@1, similarity ≥0.8 | Passed / total | Recorded evaluation date |
| --- | ---: | ---: | --- |
| `gpt-4o-2024-05-13` | 90.6% | 453 / 500 | 2024-05-18 |
| `claude-3-opus-20240229` | 90.6% | 453 / 500 | 2024-05-13 |
| `gemini-1.5-pro-latest` | 90.6% | 453 / 500 | 2024-05-19 |
| `gpt-4-turbo-2024-04-09` | 76.4% | 382 / 500 | 2024-05-13 |

These are **2024 models**, not a current frontier leaderboard. The Gemini alias
was not a dated model snapshot. The JSON contains 33 models; the archive adds a
`deepseek-chat` result covering Go only, so its `all` score must not be treated
as the same 500-question aggregate. The archive asset was updated 2024-06-27.
[Official release metadata](https://api.github.com/repos/evalplus/repoqa/releases/tags/dev-results).

Our adapter pins the [2024-06-23 dataset asset](https://github.com/evalplus/repoqa_release/releases/tag/2024-06-23),
which contains **600 functions across six language categories**, including Go.
The release notes identify Go as an addition; release publication metadata is
2024-10-07 despite the version tag. Local verification counted ten repositories
and 100 functions per category. The initial s1s experiment samples 30 questions;
it neither reproduces the original 500-question protocol nor its metric.
See [adapter source](prepare.ts) and [methodology](README.md).

Downloaded evidence SHA-256:

- Leaderboard JSON: `b17811cba4947dfed51b2204ef5cff294fc4dd3e02453279bc1284c86be60946`
- Official score ZIP: `b1f2bfdfa2d7c88cd75a3a1e3c482aecd558bd5db974c6d31c878650d756526f`
- Pinned dataset gzip: `c050a2ad90a7df89d9dc1f1c3b3b20683edd20a56293b35fcaae43dec115d681`

## 2026 repository QA: Code-QA-Bench

Published **2026-05-28**, Tables 4 and 6: 528 code-derivable questions across ten
Python repositories. Scores average accuracy, completeness and specificity,
each 0–5, divided by 15; GPT-5.4 judges answers. They are **not percentages of
questions solved**. All models use read/list/search tools, 60 turns, 4,096 output
tokens per response and a 200,000-character harness context budget.
[Paper and tables](https://arxiv.org/html/2605.29277v1#S6).

| Model / reported API identifier | Code-only score | Full documentation score |
| --- | ---: | ---: |
| Claude Opus 4.6 / `claude-opus-4-6` | 0.891 | 0.918 |
| DeepSeek-V4-Pro / `deepseek-v4-0324` | 0.892 | 0.899 |
| Kimi-K2.6 / `kimi-k2.6-0528` | 0.873 | 0.882 |
| Gemini-3.1-Pro / `gemini-3.1-pro-preview` | 0.772 | 0.755 |

The prose incorrectly calls Claude highest on code-only. Claude generated the
tasks. The separate 100 documentation-dependent tasks are excluded here. The paper says the
framework is open-source, but its inspected HTML and abstract provide no
project-repository link; reproducible artifacts remain unverified. These are
frontier models evaluated by this paper, not a claim about September's newest
available models. [Results and limitations](https://arxiv.org/html/2605.29277v1#S7).

## Newer RepoQA-related evidence needs protocol clarification

An **August 26, 2026** paper reports these **Original-condition function-selection
accuracy percentages** in Table 5. The model receives a query and candidate
functions; an attack condition substitutes irrelevant candidates, which is
excluded below. [Primary paper](https://arxiv.org/html/2608.26031v1#S4.SS5).

| Reported model label | Python | C++ | Java | Rust | TypeScript |
| --- | ---: | ---: | ---: | ---: | ---: |
| GPT-5.4-mini | 96 | 92 | 94 | 92 | 99 |
| Gemini-3.1-Pro | 95 | 92 | 95 | 95 | 98 |

**Do not aggregate or treat this as our baseline.** Table 10 describes 200 RepoQA
queries, 2,232 snippets and only Python/C++/Java, conflicting with Table 5's five
languages. Exact model snapshots, context budgets and task selection are not
established by these tables. The authors do not release their attack code.
This is evidence of a newer published experiment, with unresolved reproduction
and comparability questions. [Dataset and implementation notes](https://arxiv.org/html/2608.26031v1).

## Architecture QA: RepoProbe

The **August 6, 2026 v2** paper evaluates 500 questions across 50 repositories
using a fixed Claude Code harness and Claude Sonnet 4.5 checklist judge. Its
Table 3 reports weighted answer scores and fully satisfied checklists, not
retrieval. Exact model API snapshots and token/turn budgets are not specified
in the cited experimental setup.
[Setup and Table 3](https://arxiv.org/html/2608.04783v2#S5).

| Reported model label | Overall checklist score | Perfect-solve rate |
| --- | ---: | ---: |
| GPT-5.2 | 62.7% | 26.0% |
| GPT-5.4 | 60.4% | 24.2% |
| Claude Opus 4.6 | 62.1% | 27.5% |
| Gemini 3.1 Pro | 54.1% | 21.2% |

This is a useful direction for evaluating tracing and cross-file evidence,
but s1s does not generate QA answers. A comparison would require a fixed answer
model with different retrieval tools, measured separately from engine retrieval.

## Older CodeRepoQA scores are a different measurement

The **December 19, 2024 v1** paper uses historical dialogue as input and the last
maintainer response as reference. Table 3 reports these answer-similarity
scores. It names model families without dated API snapshots; its setup bounds
inputs to each model's capacity rather than stating a shared numeric budget.
[Experiment and Table 3](https://arxiv.org/html/2412.14764v1#S3).

| Reported model family | BLEU | ROUGE-L |
| --- | ---: | ---: |
| GPT-4o | 0.0943 | 0.1189 |
| GPT-4 | 0.1179 | 0.1330 |
| Gemini-1.5-Flash | 0.1227 | 0.1499 |
| Gemini-1.5-Pro | 0.1208 | 0.1551 |

These cannot rank a file-search engine against frontier models. The
[author-linked repository](https://github.com/kinesiatricssxilm14/CodeRepoQA)
is also distinct from both RepoQA and CodeQA.

## A directly comparable frontier baseline for s1s

Recommended next experiment; **not yet a measured result**:

1. Freeze identical query IDs, snapshot hashes, searchable text, accepted paths
   and scoring across s1s, grep, BM25F, dense retrieval and frontier baselines.
   Reserve untouched repositories/questions before tuning.
2. Add a read-only coding-agent baseline with `list`, `rg` and `read` tools.
   Let it choose and revise searches; the current one-shot mechanical grep
   baseline is not a substitute for this. Return up to ten ranked paths, never
   give the agent gold metadata, and score with our existing hit/recall/MRR/nDCG
   functions.
3. Run a second controlled baseline where that same model reranks the identical
   candidate/evidence pool. This isolates judgment quality from retrieval recall.
   Label it reranking, not whole-repository search.
4. Pin model API IDs and reasoning settings. Publish prompts, tool definitions,
   context/output/turn/deadline limits and per-task traces; report invalid paths,
   failures and truncation without dropping them. Repeat stochastic runs and
   report paired per-query changes, latency and total cost.
5. Compare the agent with and without s1s under equal budgets to measure value
   to a coding harness. Keep any answer-quality or patch-resolution experiment
   in a separate table with its own evaluator.

No frontier inference was run for this reference audit. A published score with
an incompatible protocol cannot fill a missing experimental row, and it does
not establish that s1s beats or trails that model at file hit@5.
