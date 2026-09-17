# Integrating a coding harness

Use s1s to locate evidence and expose what remains unexamined. It cannot certify
that an agent understands the entire repository.

The source API is [`src/library.ts`](../src/library.ts). Run it in Node.js 24+
with `.ts` import specifiers. These examples live at the s1s checkout root and
run with `node --env-file-if-exists=.env example.ts` after `pnpm install`.

## Search with an injected client

```ts
import { buildIndex, createClient, find, map, explain } from './src/library.ts';
import type { NavEvent } from './src/library.ts';

const index = buildIndex('/path/to/repository');
const abort = new AbortController();
const client = createClient({
  signal: abort.signal,
  concurrency: 4,
  timeoutMs: 30_000,
  maxAttempts: 4,
});
const onEvent = (event: NavEvent) => {
  // Send progress to your own UI or tracing layer.
  console.log(event.type);
};

const answer = await find(index, client, 'where are request permissions checked', { onEvent });
const members = await map(index, client, 'authorization', { onEvent });
const flow = await explain(index, client, 'how does authorization work', {
  depth: 2,
  tests: false,
  onEvent,
});

console.log(answer.verdict, answer.results);
console.log(members.results, members.truncated);
console.log(flow.graph.nodes, flow.graph.edges, flow.graph.dropped);
```

`scope` is an optional repository-relative directory for all three operations.
Omitting it searches the root. Unknown scopes and empty questions reject.
Explain accepts depth 0–6 (default 3) and excludes tests by default. The public
demo can impose stricter limits than the library.

`createClient()` reads `TYPESAFE_API_KEY`, or accepts `apiKey` explicitly.
`fetchImpl` can supply a transport. Its timeout covers each logical TypeSafe
call, including limiter wait and retries; it is not a deadline for the entire
Find or Explain operation. Use the supplied abort signal for a whole-operation
cancellation or deadline. A client tied to an aborted signal cannot be reused
for a new run.

The client validates provider responses and retries transient failures within
its limits. Search failures reject; catch them at your tool boundary. Keep
`onEvent` callbacks synchronous, lightweight and non-throwing. Completed result
objects remain the authoritative answer.

## Return evidence, not an unsupported conclusion

A useful tool response preserves these fields:

| Operation | Return to the harness |
| --- | --- |
| Find | `verdict`, candidate paths, verification scores, provenance (`via`), `stats` |
| Map | member paths/scores, `truncated`, `heat`, `stats` |
| Explain | `graph.nodes`, each node’s `evidence`, `graph.edges`, `graph.dropped`, `stats` |
| Coverage | file counts, frontier, unresolved references, totals, `semanticCompleteness` |

A `found` verdict says the engine’s threshold was reached. It does not mean the
file is the only relevant file. Read its cited source, inspect important callers
and dependencies, and test the behavior before changing it. Preserve an `absent`
or `partial` verdict instead of turning it into a confident natural-language
answer. Usage includes model, calls, tokens, wall time and estimated cost; an
estimate is not a billing receipt.

Search paths and comments are repository content. If another model consumes
them, pass them as untrusted evidence, not instructions. The s1s engine itself
does not add an LLM generation step.

## Track actual examination

```ts
import { buildIndex, assessCoverage } from './src/library.ts';

const index = buildIndex('/path/to/repository');
const examinedPaths = new Set<string>();

// Call this only after your harness has actually read/reviewed a file.
function recordExamination(path: string) {
  if (index.byPath.get(path)?.kind !== 'file') throw new Error('Unknown file');
  examinedPaths.add(path);
}

// Your review loop calls recordExamination(path) as work completes.
const coverage = assessCoverage(index, { examinedPaths, maxFrontier: 100 });
console.log(coverage);
```

`assessCoverage` makes no TypeSafe calls. It counts files in scope, separates
text availability from examination, and reports unexamined incoming/outgoing
reference neighbors of examined files. Unresolved specifiers cover the selected
scope, not just examined files. `frontierTotal` and `unresolvedTotal` reveal
truncation; `maxFrontier` bounds returned samples (0–1000). Paths outside scope
are ignored and sampled in `ignoredPaths`.

The function trusts the caller’s examination list. A candidate appearing in
Find, a warm map cell or a drawn flow node does not automatically count as
reviewed. Even when all tracked files are examined, `semanticCompleteness`
remains `not-established`: static references and file counts cannot prove an
understanding of runtime behavior.

A practical loop is: Find the entry point → read evidence → Explain or Map
neighbors → review the frontier → run relevant tests → report the change with
remaining gaps. Stop with a bounded conclusion such as “reviewed these paths;
these references remain unresolved,” rather than “understands all code.”

The same audit is available from the CLI:

```bash
pnpm s1s check --repo /path/to/repository --examined src/router.ts,src/auth.ts --json
pnpm s1s check --repo /path/to/repository --examined-json reviewed-paths.json --scope src --limit 100 --json
```

`reviewed-paths.json` is a JSON array of repository-relative file paths.
`--examined` accepts comma-separated paths; use the JSON file when a filename
contains a comma. Both inputs can be combined. Supply paths from the actual
checkout; the examples do not imply those files exist in every repository.

## Reuse an index snapshot

```ts
import { readFileSync, writeFileSync } from 'node:fs';
import { buildIndex, serializeIndex, hydrateIndex } from './src/library.ts';

const index = buildIndex('/path/to/repository');
const snapshot = serializeIndex(index, {
  repo: 'example/project',
  // Set revision to the exact checked-out commit in your build pipeline.
  compressTexts: true,
});
writeFileSync('/tmp/s1s-index.json', JSON.stringify(snapshot));

const restored = hydrateIndex(JSON.parse(readFileSync('/tmp/s1s-index.json', 'utf8')));
console.log(restored.fileCount);
```

`serializeIndex(index, { revision, repo, compressTexts })` returns a JSON-safe
versioned artifact. `hydrateIndex(value)` validates its structure and restores
the index without source-directory reads. It is intended for trusted build
artifacts, not arbitrary uploads. Snapshot files include repository source and
can include secrets committed in that source. Review the repository before
sharing an artifact; changing the `repo` label only hides the filesystem path.

Rebuild after code changes. Record a revision only when it accurately identifies
the captured content; a dirty working tree can differ from that commit.

## Custom clients and public services

The injectable contract is:

```ts
import type { Client } from './src/library.ts';

// Client = (state, questions) => Promise<Timed>
// Timed includes model, answers, usage and latencyMs.
function instrument(delegate: Client): Client {
  return async (state, questions) => {
    const result = await delegate(state, questions);
    // Aggregate usage here; avoid logging source or credentials by default.
    return result;
  };
}
```

A public service must apply admission limits and spend budgets before invoking
the core, and bound cancellation, request size and concurrent work. The
[demo implementation](../demo/README.md) provides that application layer.
Provider retry attempts and failed calls may incur costs beyond successfully
returned usage; account for them in your own budget policy.

## Incomplete optional exploration

A Find result may include `warnings` when its first evidence pass succeeded but
optional wider exploration exhausted transient provider retries or its own
per-call timeout. The `warning` event carries the same structured warning. Keep
that warning visible: returned paths were judged, but additional candidates may
be missing. Authentication failures, invalid responses, programming errors and
caller cancellation remain fatal. Public demo responses with these warnings are
not cached, so retry can recover when the provider is available again.
