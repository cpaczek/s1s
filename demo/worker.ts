import type { Catalog } from "./catalog.ts";
import { assertParams } from "./protection.ts";
export { AdmissionCoordinator } from "./coordinator.ts";
type DemoEnv = Env & { TYPESAFE_API_KEY: string };
let catalogCache: Catalog | undefined;
function json(value: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...extra } });
}
async function asset(env: DemoEnv, path: string): Promise<Response> {
  const response = await env.ASSETS.fetch(new Request(`https://assets.internal/_snapshots/${path}`));
  if (!response.ok) throw new Error("Repository snapshot unavailable.");
  return response;
}
async function catalog(env: DemoEnv): Promise<Catalog> {
  return catalogCache ??= await (await asset(env, "catalog.json")).json<Catalog>();
}

export default {
  async fetch(request: Request, env: DemoEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "Method not allowed" }, 405, { Allow: "GET, HEAD" });
      if (url.pathname.split("/").some((part) => part.startsWith("_"))) return json({ error: "Not found" }, 404);
      if (url.pathname === "/api/health") { assertParams(url.searchParams, []); return json({ ok: true, service: "s1s", live: Boolean(env.TYPESAFE_API_KEY) }); }
      if (url.pathname.startsWith("/api/")) {
        if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
        // Heavy parsing, snapshot hydration and all judgments run under the DO CPU budget.
        if (["/api/file", "/api/search", "/api/explain"].includes(url.pathname)) {
          return await env.ADMISSION.getByName("paid-demo-v1").fetch(request);
        }
        const repos = await catalog(env);
        if (url.pathname === "/api/repos") { assertParams(url.searchParams, []); return json(repos); }
        const repo = repos.repos.find((item) => item.id === (url.searchParams.get("repo") ?? repos.defaultRepo));
        if (!repo) return json({ error: "Unknown repository" }, 404);
        if (url.pathname === "/api/tree") {
          assertParams(url.searchParams, ["repo"]);
          return asset(env, `${repo.id}.tree.json`);
        }
        return json({ error: "Unknown API endpoint" }, 404);
      }
      const path = url.pathname === "/" ? "/index.html" : url.pathname === "/app" || url.pathname === "/app/" ? "/app.html" : url.pathname === "/about" || url.pathname === "/about/" ? "/about.html" : url.pathname;
      if (!/^\/[a-zA-Z0-9._/-]+$/.test(path) || path.includes("..")) return json({ error: "Not found" }, 404);
      url.pathname = path;
      const response = await env.ASSETS.fetch(new Request(url, request));
      const headers = new Headers(response.headers);
      headers.set("X-Content-Type-Options", "nosniff");
      headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
      // Cloudflare Bot Fight Mode parses this nonce for its injected detection script.
      const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
      headers.set("Content-Security-Policy", `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`);
      return new Response(response.body, { status: response.status, headers });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Request failed";
      const validation = /parameter|whole number|Expected a number|question between|scope|strategy|tests must|Provide question/.test(message);
      return json({ error: validation ? message : "The demo is temporarily unavailable. Please try again." }, validation ? 400 : 503);
    }
  },
} satisfies ExportedHandler<DemoEnv>;
