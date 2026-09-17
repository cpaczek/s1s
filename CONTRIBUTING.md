# Contributing

Start with the [README](README.md) to run the CLI and the
[architecture guide](docs/architecture.md) to understand the engine. Keep changes
focused: repository indexing, model judgments, transport and rendering have
separate responsibilities.

## Local setup and checks

Use Node.js 24+, pnpm, Git and ripgrep (`rg` on `PATH`). Python 3 is needed for
the offline dense-helper tests. Install JavaScript dependencies with
`pnpm install --frozen-lockfile`. These checks match the
[CI workflow](.github/workflows/ci.yml) and do not call TypeSafe:

```bash
pnpm typecheck
pnpm demo:typecheck
pnpm typecheck:ui-contracts
pnpm test
pnpm demo:test
pnpm test:ui
pnpm build:ui
python3 -m unittest discover -s bench/retrieval -p 'test_dense.py'
```

`pnpm build:ui` regenerates the committed local Tailwind stylesheet. For browser
changes, also run `node ui/smoke.mjs` with Playwright installed or
`PLAYWRIGHT_MODULE` set to an existing installation. Review desktop and mobile
screenshots and unexpected console errors; test touch, keyboard, source preview,
cancellation, SSE errors and reduced motion when changing those interactions.
Keep UI assets local: no CDN scripts or web fonts.

## Where changes belong

| Area | Files |
| --- | --- |
| Public API and transport client | `src/library.ts`, `src/client.ts`, `src/types.ts` |
| Facts, signatures and lexical retrieval | `src/index/` |
| Static reference resolution | `src/graph/` |
| Find, Walk and Map | `src/nav/` |
| Explain and graph assembly | `src/flow/` |
| Questions, rubrics and thresholds | `src/questions.ts` |
| CLI adapters and local server | `src/commands/`, `src/server.ts` |
| Browser app and offline flow renderer | `ui/` |
| Hosted deployment and quota/cache policy | `demo/` |
| Unit tests and scripted client/index fixtures | `test/`, `test/fake.ts` |
| Public retrieval benchmarks | `bench/retrieval/`, `bench/public/` |

The library and CLI run native TypeScript: use `.ts` import specifiers and
`import type`, and avoid syntax requiring a transform, such as enums and
parameter properties. Keep Node filesystem/process dependencies out of portable
search and flow modules used by the Worker.

## Preserve the evidence boundary

- Put TypeSafe questions and thresholds in `src/questions.ts`. Questions refer
  to entries in the request state; do not interpolate repository text into them.
- Keep ranking, caps, graph construction and ordering in code. Use TypeSafe for
  atomic judgments, not generated explanations.
- Keep titles, summaries and references grounded in extracted source. Comments
  should explain the actual behavior or a necessary tradeoff, not promises the
  implementation cannot support. Marketing and help copy are ordinary authored UI.
- Treat `src/nav/events.ts` and `src/flow/types.ts` as shared contracts. Update
  producers, consumers and tests together when changing them.
- Before removing a helper or export, search its callers, tests, package exports
  and documented source imports. A missing local caller alone does not prove a
  public API is dead.

## Measure retrieval changes

Add a fake-client regression case for a real failure, then measure on fixed
public queries. Begin new retrieval ideas on the zero-call side: facts, lexical
retrieval or graph evidence. Do not tailor a question to a gold row.

Follow the [retrieval benchmark guide](bench/retrieval/README.md), use matching
corpora and budgets for baselines, and repeat TypeSafe runs at least three times.
Inspect per-question gains/losses as well as aggregate scores, cost and latency.
Record changed implementation fingerprints instead of reusing stale results.
Keep unsuccessful rows in reports and distinguish file localization from coding
agent task completion. Tests with scripted responses establish behavior; they do
not establish model quality. Real TypeSafe benchmarks require a key and incur
API usage.

Keep `.env`, generated caches, private repository data and private gold out of
commits. Retain dated benchmark and release evidence; update current guidance
without rewriting historical observations as if they were new measurements.

The core API is independent of Cloudflare. Public demo limits belong in `demo/`;
local library callers inject their own TypeSafe client.
