# Cloudflare demo

The core library knows nothing about the demo. `preindex.ts` clones only the
five catalog repositories (or reuses `.cache/repos/<id>`), indexes the checked-out
commit, and writes compressed snapshots plus UI assets to `.cache/demo/assets`.
It never installs or executes repository code. Build output and clones stay
gitignored. The build records each exact revision; rerun it after intentionally
updating the clones. `S1S_REPO_CACHE` can point at another clone directory.

```sh
pnpm demo:build
pnpm demo:typecheck
pnpm exec wrangler types worker-configuration.d.ts --include-runtime=false
pnpm exec wrangler deploy --dry-run
pnpm demo:dev
# Set the existing TypeSafe key securely using Wrangler's prompt:
pnpm exec wrangler secret put TYPESAFE_API_KEY
pnpm demo:deploy
```

The deployment uses the `s1s.iar.dev` custom domain, Workers Static Assets and
one SQLite Durable Object. Cloudflare account access to that zone is required.
The secret is a Worker binding, never a browser asset. Local Wrangler can use
a gitignored `.dev.vars`; do not commit credentials. `wrangler.jsonc` is the
deployment configuration; regenerate types when bindings change.

`GET /api/repos` returns the allowlist and pinned revisions. `/api/tree`,
`/api/file`, `/api/search` and `/api/explain` accept a `repo` ID. File previews
accept `from`/`to` (inclusive, at most 200 lines). Search and explain use SSE,
ending in `done` / `explain_done`, or an `error` event. Unknown and repeated
parameters are rejected; the public API cannot rebuild or choose filesystem
paths or repository URLs. Private snapshot assets are blocked before static
routing. The landing page is `/`, the live app `/app`, and architecture `/about`.

## Spending and concurrency

`protection.ts` contains the auditable limits, all enforced server-side:

- One paid question runs globally; up to eight wait for at most 15 seconds.
  One IP can have only one active or waiting question. Expiring leases make
  crashes recoverable; a 60-second execution deadline is shorter than the
  90-second lease, so a queued job cannot overlap a still-valid execution.
- Six questions per minute per IP, 60 globally; 16 million reserved input
  token units per IP per UTC day and 200 million globally. At the documented
  TypeSafe price of $0.042 per million input tokens, those reservations are
  equivalent to $8.40/day if the bytes-plus-framing token bound below holds.
  This is an application-level estimate, not a provider-enforced dollar cap.
  Hosting and storage are separate.
- Every uncached admission reserves two million units before inference starts.
  Reservations are deliberately never refunded, including cancellations,
  errors and crashes. That means at most eight uncached questions per IP/day
  and 100 globally, even if each actual question is much cheaper.
- Each actual provider fetch, including a retry, consumes one of 48 calls and
  a conservative token ceiling of UTF-8 serialized request bytes plus 1,024
  framing units. The ceiling assumes no more than one token per UTF-8 byte
  plus framing; it is deliberately larger than normal tokenizer usage. A
  narrow question usually uses far less. Failed attempts still count.
- The coordinator persists its ledger and leases in a synchronous SQLite
  transaction, so restarts cannot reset budgets. It also runs the admitted
  search and snapshot hydration using Durable Objects' default 30-second CPU
  allowance. The edge Worker stays within Free-plan limits by forwarding these
  requests over the binding, without parsing large snapshots.
  Daily cleanup removes old hashed identities; the identity table, queue and
  answer cache all have hard size bounds.

The edge's `CF-Connecting-IP` is HMAC-hashed with a daily salt and the server
secret before it reaches storage. Forwarded-IP headers and client-provided
identities are not trusted. No raw IP is logged or stored by application code.
Cross-site browser requests to paid endpoints are rejected.

Successful SSE responses are cached for 24 hours by repository, revision,
normalized question, mode, scope and options. The cache is global, survives
restarts, stores at most 100 answers of at most 1 MB, and does not cache failures.
Cache hits consume minute rate allowance but no paid reservation. Concurrent
identical questions are rejected briefly instead of triggering duplicate
inference. Responses identify `X-S1S-Cache: hit` or `miss`.

## Resource bounds and analytics

Search and source preview processing runs inside the Durable Object; the edge
serves catalog/tree/static responses. Snapshots are loaded only after paid admission. Only the latest hydrated repo
is retained; source previews use small separate shards, and tree reads use a
prebuilt tree. Build-time compressed source text and packed lexical postings
keep runtime hydration small; snapshots above 48 MiB raw or 24 MiB compressed
fail the build. No indexing runs on a public request.

Workers structured logs record repository, question, mode, verdict, cache-hit status, call count,
reserved token ceiling, observed result cost and latency. Failed requests have
`costUsd: null` because partial provider spend is unknown. The conservative
reservation remains charged. Questions are logged, so users should keep them
about the public repositories and avoid confidential text. Cloudflare account
log retention controls the analytics retention period.

Validation: `pnpm test` includes deterministic admission, retry, concurrency,
restart, expiration and path-validation checks. Before deployment, run the
Worker typecheck and Wrangler dry-run; exercise landing/app/about, all five
trees, source previews, uncached SSE and cached replay in a real browser.

Platform references used for this implementation: [static asset bindings](https://developers.cloudflare.com/workers/static-assets/binding/),
[Worker-first routing](https://developers.cloudflare.com/workers/static-assets/routing/worker-script/),
[SQLite storage transactions](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/),
and [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/).
