import { describe, expect, it, vi } from "vitest";
import { gzipSync } from "node:zlib";
import type { SearchResult } from "../src/nav/events.ts";

const harness = vi.hoisted(() => ({ warnings: false }));
vi.mock("../src/index/snapshot.ts", () => ({ hydrateIndex: () => ({ byPath: new Map() }) }));
vi.mock("../src/nav/search.ts", () => ({
  normalizeParams: (value: unknown) => value,
  runSearch: async ({ emit }: { emit: (event: unknown) => void }) => {
    const result: SearchResult = {
      params: { query: "auth", scope: "", strategy: "find", beam: 3, maxDepth: 8 },
      results: [{ path: "auth.ts", score: .5, verify: .5, via: "lexical" }],
      heat: {}, visited: [], verdict: "partial", mode: "find",
      stats: { calls: 1, inputTokens: 1, outputTokens: 0, apiMs: 1, wallMs: 1, estCostUsd: 0, model: "fake" },
      ...(harness.warnings ? { warnings: [{ code: "expansion_timeout" as const, stage: "walk" as const, message: "Optional exploration timed out" }] } : {}),
    };
    emit({ type: "done", result });
    return result;
  },
}));
import { compute, type DemoEnv } from "./executor.ts";

describe("public degraded responses", () => {
  it("serves checked candidates but never persists a provider-degraded response as a cached answer", async () => {
    const fetchAsset = async (request: Request) => new URL(request.url).pathname.endsWith("catalog.json")
      ? Response.json({ defaultRepo: "demo", engineRevision: "v1", repos: [{ id: "demo", revision: "a" }] })
      : new Response(gzipSync("{}"));
    const env = { ASSETS: { fetch: fetchAsset }, TYPESAFE_API_KEY: "test-key" } as unknown as DemoEnv;
    for (const warnings of [false, true]) {
      harness.warnings = warnings;
      const pending: Promise<unknown>[] = [];
      const finish = vi.fn();
      const response = await compute(new Request("https://example.test/api/search?repo=demo&query=auth", { headers: { "CF-Connecting-IP": "203.0.113.5" } }), env,
        { waitUntil: work => { pending.push(work); } },
        { enter: () => ({ status: "active", id: "lease" }), poll: () => "active", finish });
      const body = await response.text();
      await Promise.all(pending);
      expect(body).toContain('"path":"auth.ts"');
      expect(body).toContain('"verdict":"partial"');
      expect(body.includes("expansion_timeout")).toBe(warnings);
      expect(finish).toHaveBeenCalledWith("lease", warnings ? undefined : expect.stringContaining("event: done"));
    }
  });
});
