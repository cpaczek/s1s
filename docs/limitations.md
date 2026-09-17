# Limitations and interpretation

System One Search provides bounded repository evidence. It does not prove that
it found every relevant file or that a caller understands all behavior.

## The indexed universe is limited

The index begins with Git-tracked paths and reads current working-tree content.
Untracked and ignored files are not included. Deleted files, symlinks and
non-regular entries are skipped. Files above the read limit and files outside
the text-extension set remain path-searchable without the same content facts.
The current content-read limit is 2 MiB per file. Language-specific extraction
can be incomplete even when text is available.

An index is not a compiler build and does not execute repository code. It does
not collect deployed configuration, external service state, generated runtime
objects, database contents or a program’s observed execution.

## Extraction and resolution are approximate

Facts use lightweight, language-specific extraction. TypeScript/JavaScript,
Python, Rust, Vue, GraphQL, Go and Java have dedicated paths, alongside several
document/configuration formats. This does not imply complete syntax support or
compiler-level name resolution. Macros, unusual formatting, nested constructs,
conditional imports and generated code can be missed or misinterpreted.

The graph is primarily static imports and re-exports, with supported reference
forms layered on top. Calls extracted as facts do not constitute a complete
call graph. Dependency injection, decorators, dynamic loading, string-based
routing, reflection and HTTP/WebSocket boundaries can leave disconnected parts.
An unresolved reference may be a missing local target, an unsupported form or
an external dependency; it is not automatically a defect in the repository.

## Retrieval and judgments can miss

Vocabulary gaps can prevent the right file from entering the candidate pool.
A file with similar words may receive stronger evidence than the true target.
Judgments vary across runs and are not calibrated guarantees of correctness.
Choice scores depend on the supplied alternatives.

Pools, prefilters, token budgets, graph depth, hub handling and output caps all
trade coverage for cost and readability. Inspect Map’s `truncated`, Explain’s
`graph.dropped`, coverage sample totals and the trace. Missing evidence is not
evidence that the behavior does not exist.

A Find `found` result meets a verification threshold. A flow `found` result
meets a bounded graph criterion. Neither means “complete.” `partial` and
`absent` are useful outcomes that downstream tools should preserve.

## A flow is not a runtime trace

Flow nodes are real files or supported extracted units. Summaries are selected
comments, which may themselves be incomplete or outdated. A missing summary
means no suitable comment was selected, not that the file is unimportant.

Arrows originate from recorded references, but their displayed direction and
reading order are computed for explanation. They do not prove call order,
reachability in a particular execution, or a request’s runtime path. Inspect
edge kind, reference location and source evidence before drawing conclusions.

## Coverage is an audit of a caller’s claim

`assessCoverage` trusts `examinedPaths`. It cannot determine whether the caller
read, understood or tested those files. Its graph frontier only covers recorded
reference neighbors; missing graph edges are not counted. Files without
available text remain a separate gap.

Even full file examination returns `semanticCompleteness: 'not-established'`.
Use coverage to name remaining work, not to certify correctness or replace
behavioral tests and human review.

## Source, snapshots and hosted questions

The TypeSafe client sends selected descriptors and source evidence to the
provider. Do not confuse local indexing with entirely offline search. Keep API
keys outside committed source and choose repositories appropriate for that
processing.

Index snapshots contain source text and resolved metadata. They are intended
for trusted build artifacts and can reproduce anything present in the captured
source. Compression does not redact content. A pinned public demo snapshot can
lag upstream changes; use its recorded revision when comparing results.

Public-demo questions are logged for evaluation and operations. Avoid including
secrets in questions. See the [demo guide](../demo/README.md) for admission,
caching and operational configuration.

## Evaluation is scoped

Results depend on repository revisions, the gold questions, accepted paths,
model behavior and harness settings. Repeated runs and per-question attribution
are more informative than a single aggregate score. Baselines must use the same
corpus and comparable retrieval budgets. An embedding comparison in the
[benchmark suite](../bench/retrieval/README.md) does not add embeddings to the
engine or establish superiority on unrelated repositories.
