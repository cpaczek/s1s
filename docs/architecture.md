# Architecture

System One Search composes atomic TypeSafe judgments into repository navigation.
The engine emits extracted evidence and graph structure; it does not ask a
language model to write an explanation.

## The division of work

| Code computes | TypeSafe judges |
| --- | --- |
| File inventory, facts and signatures | Whether a candidate answers the question |
| Lexical retrieval and candidate pools | Whether a file belongs to a subject |
| Static reference resolution | Whether a reached file participates or is plumbing |
| Ranking, thresholds, caps and reading order | A file’s role within the subject |
| Graph assembly and rendering | Which comment or code block explains a step |
| Coverage counts and graph frontiers | Whether a real reference carries the subject’s work |

The client accepts a state object and a dictionary of typed questions. Noul
provides a yes/no score; Choice picks from supplied alternatives. Question text
refers to positions such as `candidates[i]` or `edges[j]`. Repository data lives
in the state. [`src/questions.ts`](../src/questions.ts) is the audit surface for
questions, rubrics and thresholds.

## Indexing

[`buildIndex`](../src/index/build.ts) starts from `git ls-files` and reads the
current checkout. It builds a file/directory tree and extracts `FileFacts`:
comments, declarations, imports, calls, strings and language-specific fields.
The registry in [`facts.ts`](../src/index/facts.ts) chooses an extractor by
extension. Its lightweight extractors are approximate, not compiler parsers.

[`signature.ts`](../src/index/signature.ts) prioritizes distinctive facts and
fits descriptions into a token budget. [`lex.ts`](../src/index/lex.ts) builds a
BM25F index over path, facts and body. Structured data receives different
indexing treatment so large dictionaries do not dominate natural-language
queries.

The lazy [`graphOf`](../src/graph/build.ts) graph resolves supported static
references and follows re-exports toward defining files. It retains incoming
and outgoing edges, external package uses and unresolved specifiers. Reference
resolution is language-dependent; a fact extractor’s existence does not imply
full graph support for that language.

## Find and Map

Find pools lexical candidates, then asks TypeSafe to shortlist their compact
descriptions. The best shortlist candidates and selected lexical hits are
verified against source windows aimed at the question. When verification does
not settle the answer, a beam walk explores directories and a later verification
compares survivors. Results contain paths, scores, a verdict, heat and usage.

Map retrieves files matching a subject, then judges membership in batches.
Its output is a set of relevant files, not a single answer. The `truncated`
field reports lexical candidates beyond its prefilter cap.

The explicit `walk` CLI strategy exposes tree descent. The default Find
pipeline uses it only when needed. There is no separate Explore strategy.

## Explain

Explain distills the subject and proceeds through five stages:

1. **Gather:** Map finds members; selected high-confidence members become seeds.
2. **Expand:** graph neighbors are judged for participation, plumbing and role. Depth, hubs and caps bound expansion.
3. **Evidence:** candidate comment blocks and source windows are judged; a Choice can select an existing comment as the summary.
4. **Edges:** existing references between drawn files are judged for relevance.
5. **Build:** code creates nodes, clusters, reading order, edge direction and omission metadata.

[`FlowGraph`](../src/flow/types.ts) is the renderer contract. Titles come from
identifiers or paths; optional summaries are extracted comments. Evidence
retains a file path, line number, source lines, kind and score. An edge records
its reference location and identifiers; visual direction can be rearranged for
reading order. The result is not an execution timeline.

The renderer in [`ui/flow.js`](../ui/flow.js) computes layout independently of
the search engine. It supports a chart, a collapsible walkthrough, selection,
source navigation, pan and zoom. The app shows provisional judged nodes while
evidence is gathered; references appear in the final graph.

## Contracts and deployment boundaries

- [`src/library.ts`](../src/library.ts): public source API over an injected client.
- [`src/nav/events.ts`](../src/nav/events.ts): progress events and result types.
- [`src/flow/types.ts`](../src/flow/types.ts): extracted flow graph and evidence.
- [`src/index/snapshot.ts`](../src/index/snapshot.ts): versioned index serialization and hydration.
- [`src/server.ts`](../src/server.ts): local HTTP/SSE adapter.
- [`demo/`](../demo/README.md): public repository catalog, cached artifacts, admission controls and analytics.

Snapshots include source text, facts, lexical postings and a resolved graph.
Hydration loads a trusted build artifact without reading the original checkout.
This keeps repository cloning/indexing outside the public request path. A
snapshot is source distribution, not just search metadata.

The core API has no public-demo quota policy. The demo adds those controls
around the same engine. See [integration](integration.md) for harness usage,
[limitations](limitations.md) for interpretation, and the
[benchmark guide](../bench/retrieval/README.md) for measurement.
