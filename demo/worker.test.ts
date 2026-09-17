import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./coordinator.ts", () => ({ AdmissionCoordinator: class {} }));
import worker from "./worker.ts";
import { compute } from "./executor.ts";

const enter = vi.fn();
const fetchAsset = vi.fn(async (request: Request) => {
  const path = new URL(request.url).pathname;
  if (path.endsWith("catalog.json")) return Response.json({ defaultRepo: "demo", repos: [{ id: "demo", name: "Demo", revision: "abc", files: 1 }] });
  if (path.endsWith("demo.tree.json")) return Response.json({ files: 1, root: { path: "", kind: "dir" } });
  if (path.includes(".source-")) return Response.json({ "src/app.ts": { text: "one\ntwo\nthree", node: { path: "src/app.ts", kind: "file" } } });
  return new Response(`<html>${path}</html>`, { headers: { "Content-Type": "text/html" } });
});
function request(path: string, headers: Record<string, string> = {}, method = "GET") {
  return new Request(`https://s1s.example${path}`, { method, headers: { "CF-Connecting-IP": "203.0.113.1", ...headers } });
}
// The Worker receives only the minimal binding methods this route actually uses.
const ctx = { waitUntil: vi.fn() };
const forward = vi.fn((req: Request): Promise<Response> => compute(req, env as unknown as Env & { TYPESAFE_API_KEY: string }, ctx, { enter, poll: () => "expired", finish: () => {} }));
const env = { ASSETS: { fetch: fetchAsset }, ADMISSION: { getByName: () => ({ fetch: forward }) }, TYPESAFE_API_KEY: "unit-test-key" };
function run(req: Request) { return worker.fetch(req, env as unknown as Env & { TYPESAFE_API_KEY: string }, ctx as unknown as ExecutionContext); }

beforeEach(() => { enter.mockReset(); fetchAsset.mockClear(); ctx.waitUntil.mockClear(); forward.mockClear(); });
describe("demo HTTP boundary", () => {
  it("routes the three pages and adds a restrictive content policy", async () => {
    for (const [url, file] of [["/", "/index.html"], ["/app", "/app.html"], ["/about", "/about.html"]]) {
      const response = await run(request(url));
      expect(await response.text()).toContain(file);
      expect(response.headers.get("Content-Security-Policy")).toContain("script-src 'self'");
    }
  });
  it("blocks private assets including duplicate-slash and encoded routes", async () => {
    for (const path of ["/_snapshots/demo.json.gz", "//_snapshots/demo.json.gz", "/%5fsnapshots/demo.json.gz", "/_snapshots/catalog.json"]) expect((await run(request(path))).status).toBe(404);
    expect(fetchAsset).not.toHaveBeenCalled();
  });
  it("validates repositories, rebuild requests, repeated parameters and file paths", async () => {
    expect((await run(request("/api/tree?repo=unknown"))).status).toBe(404);
    expect((await run(request("/api/tree?repo=demo&rebuild=1"))).status).toBe(400);
    expect((await run(request("/api/tree?repo=demo&repo=demo"))).status).toBe(400);
    expect((await run(request("/api/file?repo=demo&path=../secret"))).status).toBe(400);
    expect(enter).not.toHaveBeenCalled();
  });
  it("returns actual physical file line windows without hydrating a repo", async () => {
    const response = await run(request("/api/file?repo=demo&path=src/app.ts&from=2&to=3"));
    expect(await response.json()).toMatchObject({ path: "src/app.ts", from: 2, to: 3, lines: ["two", "three"] });
    expect((await run(request("/api/file?repo=demo&path=src/app.ts&to=99999"))).status).toBe(400);
    expect(forward).toHaveBeenCalledTimes(2);
  });
  it("rejects invalid paid input, cross-site triggers and unsupported methods before admission", async () => {
    for (const path of ["/api/search?query=", "/api/search?query=hello&strategy=explore", "/api/explain?question=hello&depth=8", "/api/explain?question=hello&tests=yes", "/api/search?query=hello&extra=x"]) expect((await run(request(path))).status).toBe(400);
    expect((await run(request("/api/search?query=hello", { Origin: "https://other.example" }))).status).toBe(403);
    expect((await run(request("/api/search?query=hello", {}, "POST"))).status).toBe(405);
    expect(enter).not.toHaveBeenCalled();
  });
  it("replays successful global cache responses without a paid call and never passes raw IP", async () => {
    enter.mockResolvedValue({ status: "cached", body: "event: done\ndata: {}\n\n" });
    const response = await run(request("/api/search?repo=demo&query=hello"));
    expect(response.headers.get("X-S1S-Cache")).toBe("hit");
    expect(await response.text()).toBe("event: done\ndata: {}\n\n");
    const [ipHash, key] = enter.mock.calls[0];
    expect(ipHash).toMatch(/^[a-f0-9]{64}$/); expect(ipHash).not.toContain("203.0.113.1");
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(ctx.waitUntil).not.toHaveBeenCalled();
    expect(forward).toHaveBeenCalledTimes(1);
  });
  it("includes mode, options and normalized question in the cache key", async () => {
    enter.mockResolvedValue({ status: "cached", body: "event: done\ndata: {}\n\n" });
    for (const path of ["/api/search?query=hello%20world", "/api/search?query=%20hello%20%20world%20", "/api/search?query=hello%20world&strategy=map", "/api/search?query=hello%20world&scope=src", "/api/explain?question=hello%20world&depth=1"]) await run(request(path));
    const keys = enter.mock.calls.map((call) => call[1]);
    expect(keys[0]).toBe(keys[1]); expect(new Set(keys).size).toBe(4);
  });
  it("sends retry metadata and fails closed on coordinator failures", async () => {
    enter.mockResolvedValue({ status: "rejected", message: "Budget reached", retryAfter: 60 });
    const limited = await run(request("/api/search?query=hello"));
    expect(limited.status).toBe(429); expect(limited.headers.get("Retry-After")).toBe("60");
    enter.mockRejectedValue(new Error("Internal storage unavailable"));
    const failed = await run(request("/api/search?query=hello"));
    expect(failed.status).toBe(503); expect(await failed.text()).not.toContain("Internal storage");
  });
});
