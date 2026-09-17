# SWE-bench Verified file localization

This adapter uses the [official SWE-bench Verified dataset](https://huggingface.co/datasets/princeton-nlp/SWE-bench_Verified)
to measure **retrieval of files changed by a fix**. It does not generate patches,
run repository tests, or report official SWE-bench issue-resolution scores.

```sh
node bench/retrieval/swebench.ts --count 12 --seed s1s-swebench-v1
node --env-file-if-exists=.env bench/retrieval/run.ts \
  --manifest .cache/bench/swebench/manifest.json \
  --out .cache/bench/swebench/results.json --runs 3
```

The default dataset revision is pinned in `swebench.ts`. Five pages from the
[Hugging Face rows API](https://huggingface.co/docs/dataset-viewer/rows) are fetched;
every page must identify that exact revision through `x-revision`. Missing,
truncated, reordered, partial or mixed-revision responses fail closed. The
combined input and each original page have SHA-256 fingerprints in provenance.
If the viewer advances, explicitly review/select `--revision <full-sha>` or
provide a JSON array/JSONL export with `--data path`. Local exports are marked
as unverified upstream origin even if a revision is supplied.

Sampling sorts instance IDs by a seeded SHA-256 key and selects 12 **before
parsing gold labels**. Excluded tasks are recorded in `provenance.json` and
are never replaced by easier examples. Change `--count` for a larger sample;
the default is a small development check, not a representative leaderboard.

Each repository is checked out at the instance's exact `base_commit`, using a
shared bare Git cache and a separate detached worktree per revision. Existing
checkouts must have the expected HEAD and be clean. Only Git metadata and
source are read; no repository installs, hooks, submodules, tests or code run.

The query is the original `problem_statement`, verbatim. Hints, test outcomes,
gold patches and solutions never enter the indexed source or model query.
Patches are read only by the oracle to obtain old-side file paths. Gold labels
retain preexisting regular source files, including deleted or renamed source
files; additions cannot be retrieved from the pre-fix snapshot and are omitted.
Conventional `tests`/`testing` directories, Python test filenames and files
named in `test_patch` are excluded. Production APIs such as `django/test/client.py`
remain eligible. Gold changes are proxy labels: an unmodified dependency can
still be useful evidence, and not every modified file is equally important.

`manifest.json` follows the same schema as RepoQA and works with the same grep,
BM25, BM25F, dense and s1s evaluator. Per-file recall matters for multi-file
fixes; report hit@K together with recall@K and query-level errors. Full benchmark
data, clones and results remain under gitignored `.cache/bench/swebench`.
