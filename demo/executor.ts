import { createClient } from "../src/client.ts";
import { hydrateIndex } from "../src/index/snapshot.ts";
import type { RepoIndex } from "../src/index/build.ts";
import { normalizeParams, runSearch } from "../src/nav/search.ts";
import { runExplain } from "../src/flow/run.ts";
import type { NavEvent } from "../src/nav/events.ts";
import type { Catalog, Repository } from "./catalog.ts";
import { assertParams, boundedFetch, LIMITS, normalizedQuestion, safePath } from "./protection.ts";
import type { Admission } from "./protection.ts";

export type DemoEnv = Env & { TYPESAFE_API_KEY: string };
export type AdmissionPort = { enter(ip: string, key: string): Admission | Promise<Admission>; poll(id: string): "active" | "queued" | "expired" | Promise<"active" | "queued" | "expired">; finish(id: string, body?: string): void | Promise<void> };
export type Lifecycle = { waitUntil(promise: Promise<unknown>): void };
const encoder = new TextEncoder();
// Only completed immutable build artifacts may be retained across requests.
let catalogCache: Catalog | undefined;
let indexCache: { revision: string; index: RepoIndex } | undefined;
const SSE_HEADERS = { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
function json(value: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...extra } });
}
async function digest(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function asset(env: DemoEnv, path: string): Promise<Response> {
  const response = await env.ASSETS.fetch(new Request(`https://assets.internal/_snapshots/${path}`));
  if (!response.ok) throw new Error("Repository snapshot unavailable. Please try again later.");
  return response;
}
async function catalog(env: DemoEnv): Promise<Catalog> {
  return catalogCache ??= await (await asset(env, "catalog.json")).json<Catalog>();
}
async function loadIndex(env: DemoEnv, repo: Repository): Promise<RepoIndex> {
  if (indexCache?.revision === repo.revision) return indexCache.index;
  // Drop the previous repository before parsing the replacement.
  indexCache = undefined;
  const response = await asset(env, `${repo.id}.json.gz`);
  if (!response.body) throw new Error("Repository snapshot unavailable.");
  const value: unknown = await new Response(response.body.pipeThrough(new DecompressionStream("gzip"))).json();
  const index = hydrateIndex(value);
  indexCache = { revision: repo.revision, index };
  return index;
}
async function identity(request: Request, secret: string): Promise<string> {
  // The edge sets this header. Never accept X-Forwarded-For or user-supplied query IDs.
  const ip = request.headers.get("CF-Connecting-IP");
  if (!ip) throw new Error("Client identity unavailable. Please retry through the public demo.");
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = await crypto.subtle.sign("HMAC", key, encoder.encode(`s1s-demo-ip:${Math.floor(Date.now() / 86_400_000)}:${ip}`));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function integer(value: string | null, fallback: number, min: number, max: number): number {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value)) throw new Error("Expected a whole number.");
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max) throw new Error(`Expected a number from ${min} to ${max}.`);
  return result;
}

async function execute(request: Request, env: DemoEnv, ctx: Lifecycle, url: URL, repo: Repository, coordinator: AdmissionPort): Promise<Response> {
  if (request.headers.get("Sec-Fetch-Site") === "cross-site" || (request.headers.has("Origin") && request.headers.get("Origin") !== url.origin)) return json({ error: "Open the demo directly to ask a question." }, 403);
  const explain = url.pathname === "/api/explain";
  assertParams(url.searchParams, explain ? ["repo", "question", "query", "scope", "depth", "tests"] : ["repo", "query", "strategy", "scope", "beam", "maxDepth"]);
  if (explain && url.searchParams.has("query") && url.searchParams.has("question")) throw new Error("Provide question or query, not both.");
  const question = normalizedQuestion(url.searchParams.get("question") ?? url.searchParams.get("query") ?? "");
  if (!question || question.length > 500) throw new Error("Please ask a question between 1 and 500 characters.");
  const scope = url.searchParams.get("scope") ?? "";
  if (!safePath(scope)) throw new Error("Invalid repository scope.");
  const strategy = url.searchParams.get("strategy") ?? "find";
  if (strategy !== "find" && strategy !== "map" && strategy !== "walk") throw new Error("Unsupported strategy.");
  const tests = url.searchParams.get("tests") ?? "0";
  if (tests !== "0" && tests !== "1") throw new Error("tests must be 0 or 1.");
  const options = explain ? { depth: integer(url.searchParams.get("depth"), 3, 0, 3), tests: tests === "1" } : { beam: integer(url.searchParams.get("beam"), 3, 1, 3), maxDepth: integer(url.searchParams.get("maxDepth"), 8, 1, 12) };
  if (!env.TYPESAFE_API_KEY) return json({ error: "The live demo is temporarily unavailable." }, 503);
  const key = await digest(JSON.stringify({ version: 1, repo: repo.id, revision: repo.revision, question, scope, mode: explain ? "explain" : strategy, options }));
  const admission = await coordinator.enter(await identity(request, env.TYPESAFE_API_KEY), key);
  if (admission.status === "rejected") return json({ error: admission.message }, 429, { "Retry-After": String(admission.retryAfter) });
  if (admission.status === "cached") {
    console.log(JSON.stringify({ event: "demo_question", repo: repo.id, question, mode: explain ? "explain" : strategy, verdict: "cached", calls: 0, costUsd: 0, latencyMs: 0 }));
    return new Response(admission.body, { headers: { ...SSE_HEADERS, "X-S1S-Cache": "hit" } });
  }
  const abort = new AbortController();
  const signal = AbortSignal.any([abort.signal, request.signal, AbortSignal.timeout(LIMITS.executionMs)]);
  let open = true;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const run = async () => {
        const start = performance.now();
        const budget = boundedFetch(fetch, signal);
        let body = ""; let bodyBytes = 0; let done = false; let verdict = "error"; let costUsd: number | null = null;
        const emit = (event: NavEvent | { type: "queue"; message: string }) => {
          signal.throwIfAborted();
          const frame = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
          const data = encoder.encode(frame);
          bodyBytes += data.byteLength;
          if (bodyBytes <= LIMITS.cacheBytes) body += frame;
          else body = "";
          if (open) controller.enqueue(data);
          if (event.type === "done" || event.type === "explain_done") {
            done = true;
            const result = event.result;
            verdict = "verdict" in result ? result.verdict : result.graph.verdict;
            costUsd = result.stats.estCostUsd;
          }
        };
        try {
          let status = admission.status;
          if (status === "queued") emit({ type: "queue", message: "Waiting for a demo slot…" });
          while (status === "queued") {
            await new Promise<void>((resolve) => setTimeout(resolve, 500));
            signal.throwIfAborted();
            const next = await coordinator.poll(admission.id);
            if (next === "expired") throw new Error("The demo queue timed out. Please try again shortly.");
            status = next;
          }
          const index = await loadIndex(env, repo);
          if (scope && !index.byPath.has(scope)) throw new Error("That scope is not part of this repository.");
          const client = createClient({ apiKey: env.TYPESAFE_API_KEY, concurrency: 3, maxAttempts: 2, signal, fetchImpl: budget.fetch });
          if (explain) await runExplain({ client, index, params: { question, scope, depth: options.depth ?? 3, tests: options.tests ?? false }, emit });
          else await runSearch({ client, index, params: normalizeParams({ query: question, scope, strategy, ...options }), emit });
        } catch (error) {
          if (open) {
            const message = signal.aborted ? "The question was cancelled or reached the demo time limit." : error instanceof Error && /demo|scope|snapshot|repository/i.test(error.message) ? error.message : "The search service could not complete this question. Please try again.";
            controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ type: "error", message })}\n\n`));
          }
        } finally {
          abort.abort();
          await coordinator.finish(admission.id, done && bodyBytes <= LIMITS.cacheBytes ? body : undefined);
          console.log(JSON.stringify({ event: "demo_question", repo: repo.id, question, mode: explain ? "explain" : strategy, verdict, costUsd, latencyMs: Math.round(performance.now() - start), ...budget.usage() }));
          if (open) { open = false; controller.close(); }
        }
      };
      ctx.waitUntil(run().catch(() => { if (open) { open = false; controller.close(); } }));
    },
    cancel() { open = false; abort.abort(); },
  });
  return new Response(stream, { headers: { ...SSE_HEADERS, "X-S1S-Cache": "miss" } });
}

/** Called only from the Durable Object fetch handler, never the edge Worker. */
export async function compute(request: Request, env: DemoEnv, ctx: Lifecycle, coordinator: AdmissionPort): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (!["/api/file", "/api/search", "/api/explain"].includes(url.pathname)) return json({ error: "Unknown compute endpoint" }, 404);
      if (request.method !== "GET") return json({ error: "Method not allowed" }, 405, { Allow: "GET" });
      if (url.pathname.startsWith("/api/")) {
        const repos = await catalog(env);
        const repo = repos.repos.find((item) => item.id === (url.searchParams.get("repo") ?? repos.defaultRepo));
        if (!repo) return json({ error: "Unknown repository" }, 404);
        if (url.pathname === "/api/file") {
          assertParams(url.searchParams, ["repo", "path", "from", "to"]);
          const path = url.searchParams.get("path") ?? "";
          if (!path || !safePath(path)) return json({ error: "Invalid file path" }, 400);
          const from = integer(url.searchParams.get("from"), 1, 1, 1_000_000);
          const to = integer(url.searchParams.get("to"), from + 199, from, from + 199);
          const shard = (await digest(path)).slice(0, 2);
          const source = await env.ASSETS.fetch(new Request(`https://assets.internal/_snapshots/${repo.id}.source-${shard}.json`));
          if (source.status === 404) return json({ error: "Not a tracked file" }, 404);
          if (!source.ok) throw new Error("Source preview unavailable.");
          const records = await source.json<Record<string, { text?: string; node: unknown }>>();
          const record = Object.hasOwn(records, path) ? records[path] : undefined;
          if (!record) return json({ error: "Not a tracked file" }, 404);
          return json({ path, from, to, lines: record.text?.split("\n").slice(from - 1, to) ?? [], node: record.node });
        }
        if (url.pathname === "/api/search" || url.pathname === "/api/explain") return await execute(request, env, ctx, url, repo, coordinator);
        return json({ error: "Unknown API endpoint" }, 404);
      }
      return json({ error: "Unknown compute endpoint" }, 404);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Request failed";
      const validation = /parameter|whole number|Expected a number|question between|scope|strategy|tests must|Provide question/.test(message);
      return json({ error: validation ? message : "The demo is temporarily unavailable. Please try again." }, validation ? 400 : 503);
    }
}
