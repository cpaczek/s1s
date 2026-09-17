# System One Search

**Find the file. Map the subject. Follow the flow.**

System One Search (`s1s`) navigates a Git repository using code and Jev,
[TypeSafe’s](https://typesafe.ai) decision model. The engine does not use an
LLM to generate explanations. Its answers consist of source paths,
identifiers, extracted comments and real references.

- **Find** narrows a question to candidate files and verifies relevant source lines.
- **Map** locates the files that belong to a subject.
- **Explain** traces a subject across files and builds a chart with an evidence-backed walkthrough.
- **Check** reports which files a harness has examined and which reference neighbors remain. It does **not** establish semantic completeness.

Recall is code; precision is TypeSafe. A lexical index and reference graph
propose candidates. Small, typed judgments decide which pieces belong.

## Run from source

Requirements: Node.js 24+, pnpm and Git. The TypeScript runs directly in Node;
there is no JavaScript compilation step for the library or CLI.

```bash
git clone https://github.com/cpaczek/s1s.git
cd s1s
pnpm install
cp .env.example .env
```

Set `TYPESAFE_API_KEY` in `.env`. Keep that file private. Find, Map and Explain
send selected repository descriptors and source evidence to TypeSafe. Indexing
and coverage checks run locally without a model call.

```bash
# Start the local explorer, then open http://localhost:4747/app
pnpm s1s serve --repo /path/to/repository

# Ask for a file, a subject map, or a flow
pnpm s1s find "where are requests authenticated" --repo /path/to/repository
pnpm s1s map "authentication" --repo /path/to/repository
pnpm s1s explain "how does authentication work" --repo /path/to/repository --out auth.html

# Machine-readable output and a bounded search
pnpm s1s find "database connection" --repo /path/to/repository --scope src --json
pnpm s1s explain "how does request routing work" --repo /path/to/repository --depth 2 --json

# Inspect the local index without calling TypeSafe
pnpm s1s index --repo /path/to/repository

# Audit files your harness actually reviewed (no model call)
pnpm s1s check --repo /path/to/repository --examined src/router.ts,src/auth.ts --json
```

`--repo` defaults to the current working directory. It must be a Git checkout;
the index starts with tracked files and reads their current working-tree
contents. Use the checkout’s actual directory names for `--scope`.

The binary can also be invoked directly: `node bin/s1s.mjs --help`. It loads
an optional `.env` from the current working directory. The project is MIT
licensed and source-installable; npm publishing is a later step, so
`private: true` is intentional.

## Use the library

Save this as `example.ts` in the s1s checkout:

```ts
import { buildIndex, createClient, find, explain, assessCoverage } from './src/library.ts';

const index = buildIndex('/path/to/repository');
const client = createClient();

const answer = await find(index, client, 'where are requests authenticated');
console.log(answer.verdict, answer.results, answer.stats);

const flow = await explain(index, client, 'how does authentication work', { depth: 2 });
console.log(flow.graph);

// Supply paths actually read by your harness, not every search candidate.
const reviewedPaths: string[] = [];
console.log(assessCoverage(index, { examinedPaths: reviewedPaths }));
```

Run it with `node --env-file-if-exists=.env example.ts`. The injected `Client`
interface also lets a harness add its own budgeting, cancellation, logging or
fake responses for tests. See the [integration guide](docs/integration.md) for
events, snapshots and a responsible coverage workflow.

## How it works

1. **Index:** extract facts, build compact file descriptions, score paths/facts/text lexically, and resolve static references.
2. **Find:** pool candidates → shortlist → verify on source evidence → walk the tree if needed.
3. **Map:** retrieve subject candidates → judge membership → return a heatmap.
4. **Explain:** gather members → expand through references → judge evidence and edges → build a graph in code.

Every question and threshold lives in [`src/questions.ts`](src/questions.ts).
Data goes in the request state, not into question text. Ranking, caps, graph
construction and layout are ordinary code. See [architecture](docs/architecture.md).

## Demo and evaluation

The public demo is deployed at [s1s.iar.dev](https://s1s.iar.dev), with pre-indexed
OpenCode, Strapi, Outline, Hoppscotch and ripgrep repositories. It provides a
live heatmap, a flow view, source previews, suggestions and cost/time details.
See the [demo deployment guide](demo/README.md) for setup and operational limits.

The [retrieval benchmark guide](bench/retrieval/README.md) describes public-repo
evaluation and comparisons against retrieval baselines. Optional embedding
baselines belong to that benchmark, not the search engine. Benchmark results
are specific to their questions, revisions and runs; there is no universal
accuracy or completeness claim.

## Development

```bash
pnpm test
pnpm typecheck
pnpm build:ui
node ui/check-transport.mjs
```

`pnpm build:ui` compiles Tailwind locally. The browser uses vanilla JavaScript,
local styles and the same flow renderer as HTML exports, with no CDN or web
fonts. The optional browser smoke test is `node ui/smoke.mjs`; install Playwright
or set `PLAYWRIGHT_MODULE` to an existing Playwright module path.

Before extending a strategy, add a fake-client test and measure it on public
questions. Repeat real model runs and inspect per-question gains and losses.
Do not infer an improvement from a single aggregate score.

## Boundaries

A high-confidence result is still a model judgment. A flow is a bounded static
view, not a runtime trace. Unsupported syntax, dynamic wiring, vocabulary gaps,
search caps and unexamined files can all hide relevant behavior. Review the
[limitations](docs/limitations.md) before using results to guide a change.

[MIT license](LICENSE).
