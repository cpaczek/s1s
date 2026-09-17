import { createServer, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { basename, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "./client.ts";
import { buildIndex, type RepoIndex } from "./index/build.ts";
import { F, REPO_DOMAIN } from "./questions.ts";
import { STRATEGIES, type ExplainParams, type NavEvent, type Strategy } from "./nav/events.ts";
import { normalizeParams, runSearch } from "./nav/search.ts";
import { runExplain } from "./flow/run.ts";

const UI_DIR = fileURLToPath(new URL("../ui/", import.meta.url));
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
export type ServerOptions = {
  repo: string; port: number; client: Client; index?: RepoIndex; reload?: () => RepoIndex;
  /** Per-request factory makes cancellation stop upstream requests as well. */
  clientForSignal?: (signal: AbortSignal) => Client;
  host?: string;
};
class HttpError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } }

export function startServer(opts: ServerOptions) {
  if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) throw new Error("port must be an integer from 0 to 65535");
  const reload = opts.reload ?? (() => buildIndex(opts.repo));
  let index = opts.index ?? reload();
  let treeJson = JSON.stringify(serializeTree(index));
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "Method not allowed");
      if (url.pathname.startsWith("/api/") && req.method !== "GET") throw new HttpError(405, "Use GET for API requests");
      if (url.pathname.startsWith("/api/")) {
        const host = new URL(`http://${req.headers.host ?? ""}`).hostname;
        const allowed = new Set(["localhost", "127.0.0.1", "[::1]", ...(opts.host && opts.host !== "0.0.0.0" && opts.host !== "::" ? [opts.host] : [])]);
        if (!allowed.has(host)) throw new HttpError(403, "Use the local server address");
        if (req.headers["sec-fetch-site"] === "cross-site" || (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`)) throw new HttpError(403, "Cross-origin API requests are not allowed");
      }
      const repo = url.searchParams.get("repo");
      if (url.pathname.startsWith("/api/") && repo && repo !== "local") throw new HttpError(404, "Unknown repository");
      if (url.pathname === "/api/health") return json(res, JSON.stringify({ ok: true, files: index.fileCount }));
      if (url.pathname === "/api/repos") return json(res, JSON.stringify({ defaultRepo: "local", repos: [{ id: "local", name: basename(opts.repo), description: "Your local Git repository", url: "", files: index.fileCount, questions: ["How does authentication work?", "Where is the application entry point?", "Show me the database connection flow"] }] }));
      if (url.pathname === "/api/tree") {
        if (url.searchParams.get("rebuild") === "1") { index = reload(); treeJson = JSON.stringify(serializeTree(index)); }
        return json(res, treeJson);
      }
      if (url.pathname === "/api/file") {
        const path = url.searchParams.get("path") ?? "";
        if (!safePath(path)) throw new HttpError(400, "Invalid file path");
        const node = index.byPath.get(path);
        if (!node || node.kind !== "file") throw new HttpError(404, "Not a tracked file");
        const text = index.text(path);
        if (text === undefined) throw new HttpError(404, "File content is unavailable");
        const from = integer(url, "from", 1, 1, 10_000_000);
        const to = integer(url, "to", from + 199, from, from + 399);
        const lines = text.split("\n");
        return json(res, JSON.stringify({ path, from, to: Math.min(to, lines.length), total: lines.length, lines: lines.slice(from - 1, to), node }));
      }
      if (url.pathname === "/api/search" || url.pathname === "/api/explain") {
        const scope = (url.searchParams.get("scope") ?? "").replace(/^\/+|\/+$/g, "");
        if ((scope && !safePath(scope)) || index.byPath.get(scope)?.kind !== "dir") throw new HttpError(400, "Scope must be a tracked directory");
        const query = (url.searchParams.get("question") ?? url.searchParams.get("query") ?? "").trim();
        if (!query || query.length > 1000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(query)) throw new HttpError(400, "Enter a question between 1 and 1000 characters");
        const strategy = url.searchParams.get("strategy") ?? "find";
        if (!STRATEGIES.includes(strategy as Strategy)) throw new HttpError(400, "Unknown search strategy");
        const params = normalizeParams({ query, scope, strategy: strategy as Strategy, beam: integer(url, "beam", 3, 1, 10), maxDepth: integer(url, "maxDepth", 12, 1, 30) });
        const explanation: ExplainParams = { question: query, scope, depth: integer(url, "depth", F.DEPTH, 0, 6), tests: url.searchParams.get("tests") === "1" };
        const controller = new AbortController();
        const deadline = setTimeout(() => controller.abort(new Error("Search timed out")), 120_000);
        res.on("close", () => { controller.abort(new Error("Connection closed")); clearTimeout(deadline); });
        const client = opts.clientForSignal?.(controller.signal) ?? (async (state, questions) => { controller.signal.throwIfAborted(); return opts.client(state, questions); });
        res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no", "X-Content-Type-Options": "nosniff" });
        res.flushHeaders();
        const emit = (event: NavEvent) => { if (!res.destroyed && !res.writableEnded) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`); };
        const heartbeat = setInterval(() => { if (!res.destroyed) res.write(": heartbeat\n\n"); }, 15_000);
        try {
          if (url.pathname === "/api/explain") await runExplain({ index, client, params: explanation, emit });
          else await runSearch({ index, client, params, emit });
        } catch (error) { emit({ type: "error", message: error instanceof Error ? error.message : "Search failed" }); }
        finally { clearInterval(heartbeat); clearTimeout(deadline); res.end(); }
        return;
      }
      if (url.pathname.startsWith("/api/")) throw new HttpError(404, "Unknown API endpoint");
      await serveStatic(url.pathname, res, req.method === "HEAD");
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      json(res, JSON.stringify({ error: error instanceof HttpError ? error.message : "Unable to complete request" }), error instanceof HttpError ? error.status : 500);
    }
  });
  server.listen(opts.port, opts.host ?? "127.0.0.1", () => {
    const address = server.address();
    console.log(`s1s → http://localhost:${typeof address === "object" && address ? address.port : opts.port}/app (${index.fileCount} files)`);
  });
  return server;
}
function safePath(path: string): boolean { return !path.startsWith("/") && !path.includes("\\") && !path.includes("\0") && !path.split("/").some((part) => part === ".." || part === "."); }
function integer(url: URL, key: string, fallback: number, min: number, max: number): number {
  const raw = url.searchParams.get(key);
  const value = raw === null ? fallback : Number(raw);
  if (raw === "" || !Number.isSafeInteger(value) || value < min || value > max) throw new HttpError(400, `${key} must be an integer from ${min} to ${max}`);
  return value;
}
export function serializeTree(index: RepoIndex) {
  return JSON.parse(JSON.stringify({ repo: basename(index.repo), builtAt: index.builtAt, buildMs: Math.round(index.buildMs), files: index.fileCount, domain: index.domain ?? REPO_DOMAIN, root: index.root }, (key, value) => key === "signature" ? undefined : value));
}
function json(res: ServerResponse, body: string, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(body);
}
async function serveStatic(pathname: string, res: ServerResponse, head: boolean) {
  const aliases: Record<string, string> = { "/": "index.html", "/app": "app.html", "/about": "about.html" };
  let rel: string;
  try { rel = aliases[pathname] ?? decodeURIComponent(pathname).replace(/^\/+/, ""); } catch { throw new HttpError(400, "Invalid path encoding"); }
  if (!safePath(rel) || rel.split("/").some((part) => part.startsWith("."))) throw new HttpError(400, "Invalid asset path");
  const file = resolve(UI_DIR, rel);
  if (!file.startsWith(UI_DIR.endsWith(sep) ? UI_DIR : UI_DIR + sep)) throw new HttpError(400, "Invalid asset path");
  try {
    if (!(await stat(file)).isFile()) throw new Error();
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" });
    res.end(head ? undefined : body);
  } catch { throw new HttpError(404, "Page not found"); }
}
