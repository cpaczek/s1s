# Working on System One Search

Use Node 24 and pnpm. Run `pnpm test`, `pnpm typecheck`, `pnpm demo:test`,
`pnpm demo:typecheck`, `pnpm test:ui` and `pnpm build:ui` before submitting changes.
The optional browser smoke test accepts `PLAYWRIGHT_MODULE` pointing to an
installed Playwright module: `node ui/smoke.mjs`.

- Questions, rubrics and judgment thresholds belong in `src/questions.ts`.
  Questions are constants; candidate text belongs in the request state.
- TypeSafe judges atomic semantic facts. Code computes ranks, caps, budgets,
  graph construction and layout. Do not add a generative model to the engine.
- Search-result titles, summaries and edges must come from source identifiers,
  comments and real references. Marketing and help copy are ordinary authored UI.
- Start recall improvements in extraction, lexical retrieval or reference resolution.
  Use fake-client tests and repeated public benchmarks before claiming improvement.
- Preserve `.ts` import specifiers, `import type` and erasable native TypeScript.
- Keep UI assets local. Tailwind is compiled at development time, without CDN
  scripts or web fonts. Verify keyboard use, phone/tablet layouts, source preview,
  cancellation and SSE errors in a browser with console-error logging.
- Never commit credentials, source checkouts, cached snapshots, private benchmark
  gold or generated local data. Public measured reports must include provenance
  and unsuccessful rows, and distinguish localization from agent task completion.

The core API is independent of Cloudflare. Public demo limits belong in `demo/`;
local library callers inject their own TypeSafe client. Keep those boundaries clear.
