import { describe, expect, it } from "vitest";
import { scoreRow, summarize, type GoldRow } from "../src/commands/bench.ts";
import type { SearchResult } from "../src/nav/events.ts";

const base = (over: Partial<SearchResult>): SearchResult => ({
  params: { query: "q", strategy: "walk", scope: "", beam: 3, maxDepth: 12 },
  results: [],
  heat: {},
  visited: [],
  stats: { calls: 1, inputTokens: 10, outputTokens: 1, apiMs: 1, wallMs: 2, estCostUsd: 0, model: "fake" },
  verdict: "absent",
  mode: "find",
  ...over,
});

describe("scoreRow", () => {
  const gold: GoldRow = { id: "x", query: "q", accept: ["a.ts", "b.ts"] };
  it("hit@1 when the top result is accepted, hit@K when any is", () => {
    const r = base({ results: [{ path: "z.ts", score: 0.5, via: "walk" }, { path: "b.ts", score: 0.4, via: "walk" }], verdict: "found" });
    const row = scoreRow("x", "walk", gold, r);
    expect(row.hit1).toBe(false);
    expect(row.hitK).toBe(true);
  });
  it("an absent gold row is a hit only when the verdict is absent", () => {
    const absent: GoldRow = { id: "none", query: "q", accept: [] };
    expect(scoreRow("none", "walk", absent, base({ verdict: "absent" })).hit1).toBe(true);
    expect(scoreRow("none", "walk", absent, base({ verdict: "found", results: [{ path: "a.ts", score: 0.9, via: "walk" }] })).hit1).toBe(false);
  });
});

describe("summarize", () => {
  it("groups by strategy", () => {
    const rows = [
      { id: "1", strategy: "walk" as const, hit1: true, hitK: true, top: "a", topVerify: 0.9, verdict: "found" as const, calls: 4, inputTokens: 100, apiMs: 10, wallMs: 20 },
      { id: "2", strategy: "walk" as const, hit1: false, hitK: true, top: "b", topVerify: 0.2, verdict: "absent" as const, calls: 6, inputTokens: 300, apiMs: 10, wallMs: 40 },
    ];
    const s = summarize(rows);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ strategy: "walk", n: 2, hit1: 0.5, hitK: 1, callsMean: 5, inputTokensMean: 200, wallP50: 40 });
  });
});
