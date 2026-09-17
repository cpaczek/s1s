import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "./client.ts";
import { buildIndex, evidenceFor, type RepoIndex } from "./index/build.ts";
import { REPO_DOMAIN } from "./questions.ts";
import type { ExplainParams, NavEvent, Strategy } from "./nav/events.ts";
import { normalizeParams, runSearch } from "./nav/search.ts";
import { runExplain } from "./commands/explain.ts";
import { F } from "./questions.ts";

const UI_DIR = fileURLToPath(new URL("../ui/", import.meta.url));
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

export type ServerOptions = { repo: string; port: number; client: Client; index?: RepoIndex; reload?: () => RepoIndex };

export function startServer(opts: ServerOptions) {
  const reload = opts.reload ?? (() => buildIndex(opts.repo));
  let index = opts.index ?? reload();
  let treeJson = JSON.stringify(serializeTree(index));

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (url.pathname === "/api/tree") {
        if (url.searchParams.get("rebuild") === "1") {
          index = reload();
          treeJson = JSON.stringify(serializeTree(index));
        }
        return json(res, treeJson);
      }
      if (url.pathname === "/api/file") {
        const path = url.searchParams.get("path") ?? "";
        const node = index.byPath.get(path);
        if (!node || node.kind !== "file") return json(res, JSON.stringify({ error: "not a tracked file" }), 404);
        return json(res, JSON.stringify({ path, lines: evidenceFor(index, path, 200), node }));
      }
      if (url.pathname === "/api/search") return sse(req, res, url, index, opts.client);
      if (url.pathname === "/api/explain") return sseExplain(req, res, url, index, opts.client);
      return serveStatic(url.pathname, res);
    } catch (err) {
      json(res, JSON.stringify({ error: (err as Error).message }), 500);
    }
  });

  server.listen(opts.port, () => {
    console.log(`typesafe-nav → http://localhost:${opts.port}  (repo ${opts.repo}, ${index.fileCount} files indexed in ${Math.round(index.buildMs)}ms)`);
  });
  return server;
}

function serializeTree(index: RepoIndex) {
  // The UI never reads signatures; leaving them out keeps the tree payload small.
  return JSON.parse(JSON.stringify({ repo: index.repo, builtAt: index.builtAt, buildMs: Math.round(index.buildMs), files: index.fileCount, domain: index.domain ?? REPO_DOMAIN, root: index.root }, (k, v) => (k === "signature" ? undefined : v)));
}

function json(res: ServerResponse, body: string, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}

async function serveStatic(pathname: string, res: ServerResponse) {
  const rel = pathname === "/" ? "index.html" : normalize(pathname).replace(/^\/+/, "");
  if (rel.includes("..")) return json(res, JSON.stringify({ error: "bad path" }), 400);
  const file = join(UI_DIR, rel);
  try {
    const st = await stat(file);
    if (!st.isFile()) throw new Error("not a file");
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" });
    res.end(body);
  } catch {
    json(res, JSON.stringify({ error: `no such UI file: ${rel} (expected under ui/)` }), 404);
  }
}

function sseHeaders(res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
}

/** `explain`: the same SSE shape as `/api/search`, ending with `explain_done`. */
function sseExplain(req: IncomingMessage, res: ServerResponse, url: URL, index: RepoIndex, client: Client) {
  const params: ExplainParams = {
    question: (url.searchParams.get("question") ?? url.searchParams.get("query") ?? "").trim(),
    scope: (url.searchParams.get("scope") ?? "").replace(/^\/+|\/+$/g, ""),
    depth: Math.max(0, Math.min(6, Number(url.searchParams.get("depth") ?? NaN) || F.DEPTH)),
    tests: url.searchParams.get("tests") === "1",
  };
  sseHeaders(res);
  let open = true;
  req.on("close", () => (open = false));
  const emit = (e: NavEvent) => {
    if (open) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  };
  if (!params.question) {
    emit({ type: "error", message: "question is empty" });
    res.end();
    return;
  }
  runExplain({ client, index, params, emit })
    .catch((err: Error) => emit({ type: "error", message: err.message }))
    .finally(() => {
      if (open) res.end();
    });
}

function sse(req: IncomingMessage, res: ServerResponse, url: URL, index: RepoIndex, client: Client) {
  const params = normalizeParams({
    query: url.searchParams.get("query") ?? "",
    strategy: (url.searchParams.get("strategy") ?? "find") as Strategy,
    scope: url.searchParams.get("scope") ?? "",
    beam: Number(url.searchParams.get("beam") ?? NaN) || undefined,
    maxDepth: Number(url.searchParams.get("maxDepth") ?? NaN) || undefined,
  });
  sseHeaders(res);
  let open = true;
  req.on("close", () => (open = false));
  const emit = (e: NavEvent) => {
    if (!open) return;
    res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  };
  runSearch({ client, index, params, emit })
    .catch((err: Error) => emit({ type: "error", message: err.message }))
    .finally(() => {
      if (open) res.end();
    });
}
