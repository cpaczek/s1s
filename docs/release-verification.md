# Release verification — 2026-09-17

Public site: [s1s.iar.dev](https://s1s.iar.dev). Source:
[cpaczek/s1s](https://github.com/cpaczek/s1s). The deployment is a Cloudflare
Worker with SQLite Durable Object execution, using the existing account's Free
plan. No account-plan upgrade or npm publication was performed.

| Handoff item | Delivered behavior | Evidence |
| --- | --- | --- |
| Initialize a real repository | `main`, isolated worktrees, public MIT repository; private data/gold excluded | Git history and tracked-file audit; no history entries for `.env`, `data/` or private gold |
| Clean up and type boundaries | Native TypeScript strict/unused checks; local compiled Tailwind; validated HTTP/SSE failures; cancellation and safe file windows | Core tests, demo tests, `typecheck`, `demo:typecheck`, `typecheck:ui-contracts`, transport and browser smoke |
| Rename | System One Search / `s1s` package, binary, commands, docs and UI | `node bin/s1s.mjs --help`; CLI coverage command; published pages |
| Cloudflare demo | Five build-time snapshots; per-IP/global budgets, bounded queue, persistent cache and analytics | Actual Wrangler deployment, all five `/api/tree` responses, live find/explain and cache replay; protection tests |
| Polished interactive UI | Repo picker, tailored suggestions, automatic Find/Explain with override, live heatmap, provisional and final flow, cost/time, previews | Real Strapi authentication result; browser controls/error/retry/cancel/source tests |
| Flow transition | Matching visible file boxes move from heatmap to real graph nodes | Browser asserts real matching IDs, completed cleanup, and no animation under reduced motion |
| Public library/toolset | Injected-client Find/Map/Explain, portable snapshots, bounded coverage audit; Rust/Vue/GraphQL/Go/Java/Python extraction and references | `src/library.ts`, integration guide, multilingual/graph/snapshot tests and public benchmark rows |
| Landing and About | Original code-atlas mark, ink-blue/mist/lime identity, exact source-reference illustration, architecture and integration guide | Desktop/phone visual review; source import inventory for every illustrated reference |
| Mobile follow-up | Phone/tablet reading order, 44px controls, 16px inputs, readable graph zoom, touch pan/pinch, bounded source/results scrolling | Eight portrait/landscape interaction sizes; production pages checked at 320, 390, 768, 1024 and 1440px |
| No emoji icons | Local SVG/CSS controls and original SVG mark | UI source scan and rendered visual checks; semantic arrows in reference text remain notation |
| Retrieval benchmark follow-up | Pinned RepoQA/SWE-bench localization adapters; real grep, BM25, BM25F, local dense embeddings and repeated s1s | [Results and raw rankings](../bench/retrieval/RESULTS.md), corpus parity audit and strict reuse-provenance tests |
| Updated secret | User-authorized `.env` key transferred over stdin into the Worker secret store, without displaying its value | Wrangler successful secret upload, no inherited environment override, production `/api/health` reports `live: true` |

## Verified behavior

The live production path completed an uncached OpenCode Find request and an
uncached Strapi authentication Explain request with 36 nodes and connected
references. Repeating Find returned `X-S1S-Cache: hit`. A partial Find verdict
was retained as partial rather than presented as certainty. All five repository
indexes matched their catalog revisions and file counts. Private snapshot paths
return 404; unknown repositories return 404; traversal and public rebuild
parameters are rejected. Source previews return physical line windows.

The browser suite covers 320×568, 360×800, 390×844, 768×1024, 568×320, 800×360,
844×390 and 1024×768, plus a desktop view. It checks buttons, source previews,
repo isolation, strategy override, keyboard selection, touch pan/pinch, errors,
explicit retry and cancellation. Its deliberately injected HTTP 429 produces an
expected console resource error; unexpected browser exceptions fail the suite.
Production page checks report no unexpected console errors or horizontal page
overflow. Cloudflare's injected bot-detection script uses a per-response CSP
nonce; unrestricted inline script execution is not enabled.

Validation at this release: 360 core tests, 23 demo checks (12 also occur in the
core suite), 6 Python benchmark tests, transport checks, strict typechecks and
Chromium smoke. Hosted CI runs the offline checks, including its explicit
ripgrep prerequisite. Real provider tests are separate from CI and fake-client
tests; they are not inferred from a green CI badge.

## What this does not prove

The engine is still bounded static retrieval. Vocabulary misses, broad-question
subject selection, approximate language parsing, dynamic dependency injection,
client/server boundaries and graph caps can hide relevant code. The public Rust
broad-subject flow miss is preserved in the benchmark notes. No universal
semantic-completeness or runtime-trace claim is made. The original handoff's
research observations remain explicit in [limitations](limitations.md).
