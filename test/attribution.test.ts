import { describe, expect, it } from "vitest";
import { attributeLoss } from "../src/nav/attribution.ts";
import type { NavEvent, OptionSeen, SearchResult } from "../src/nav/events.ts";

const result = (over: Partial<SearchResult>): SearchResult => ({
  params: { query: "q", strategy: "walk", scope: "", beam: 3, maxDepth: 12 },
  results: [],
  heat: {},
  visited: [],
  stats: { calls: 1, inputTokens: 10, outputTokens: 1, apiMs: 1, wallMs: 2, estCostUsd: 0, model: "fake" },
  verdict: "absent",
  mode: "find",
  ...over,
});

const opt = (path: string, p: number, kind: OptionSeen["kind"] = "dir"): OptionSeen => ({ name: path.split("/").pop()!, path, kind, p });
const expand = (path: string, options: OptionSeen[]): NavEvent => ({ type: "expand", step: 0, path, parentScore: 1, options, underHere: 0.5, confidence: 0.5, latencyMs: 1, tokens: 1 });

const TARGET = "packages/db/src/auth-horse.ts";

describe("attributeLoss", () => {
  it("has nothing to say about an absent gold row", () => {
    expect(attributeLoss([], result({}), [])).toBeUndefined();
  });

  it("hit when the accepted path leads the results", () => {
    const r = result({ results: [{ path: TARGET, score: 0.9, verify: 0.9, via: "walk" }] });
    expect(attributeLoss([], r, [TARGET])).toMatchObject({ stage: "hit", verify: 0.9 });
  });

  it("rank when it verified but was out-ranked; verify when the verifier rejected it", () => {
    const other = { path: "apps/api/x.ts", score: 0.8, verify: 0.8, via: "walk" as const };
    expect(attributeLoss([], result({ results: [other, { path: TARGET, score: 0.5, verify: 0.5, via: "walk" }] }), [TARGET])?.stage).toBe("rank");
    expect(attributeLoss([], result({ results: [other, { path: TARGET, score: 0.1, verify: 0.1, via: "walk" }] }), [TARGET])?.stage).toBe("verify");
  });

  it("first_hop when the root was expanded and the right top-level container never was", () => {
    const events = [expand("", [opt("apps", 0.92), opt("docs", 0.04), opt("packages", 0.03)]), expand("apps", [opt("apps/api", 0.9)])];
    expect(attributeLoss(events, result({}), [TARGET])).toEqual({ stage: "first_hop", path: TARGET, at: "", childP: 0.03, childRank: 3 });
  });

  it("descent when it was lost further down; a repeated expansion keeps the best probability", () => {
    const events: NavEvent[] = [
      expand("", [opt("packages", 0.6), opt("apps", 0.4)]),
      expand("packages", [opt("packages/nekuda", 0.7), opt("packages/db", 0.1)]),
      expand("packages", [opt("packages/db", 0.3)]),
    ];
    expect(attributeLoss(events, result({}), [TARGET])).toEqual({ stage: "descent", path: TARGET, at: "packages", childP: 0.3, childRank: 2 });
  });

  it("unverified when its own container was expanded but the unit never reached verification", () => {
    const events = [
      expand("", [opt("packages", 1)]),
      expand("packages", [opt("packages/db", 1)]),
      expand("packages/db", [opt("packages/db/src", 1)]),
      expand("packages/db/src", [opt("packages/db/src/auth.ts", 0.8, "file"), opt(TARGET, 0.1, "file")]),
    ];
    expect(attributeLoss(events, result({}), [TARGET])).toMatchObject({ stage: "unverified", at: "packages/db/src", childP: 0.1, childRank: 2 });
  });

  it("a battery has no descent: unverified with its score, unseen without one", () => {
    expect(attributeLoss([], result({ heat: { [TARGET]: 0.15 } }), [TARGET])).toEqual({ stage: "unverified", path: TARGET, verify: 0.15 });
    expect(attributeLoss([], result({}), [TARGET])).toEqual({ stage: "unseen", path: TARGET });
  });

  it("reports the accepted path that got furthest, and respects the scope", () => {
    const events = [expand("packages", [opt("packages/db", 0.2), opt("packages/nekuda", 0.8)])];
    const r = result({ params: { query: "q", strategy: "walk", scope: "packages", beam: 3, maxDepth: 12 } });
    expect(attributeLoss(events, r, ["packages/other/missing.ts", TARGET])).toMatchObject({ stage: "first_hop", path: TARGET, at: "packages", childP: 0.2, childRank: 2 });
    const hit = result({ results: [{ path: "b.ts", score: 0.9, verify: 0.9, via: "walk" }] });
    expect(attributeLoss([expand("", [opt("a", 1)])], hit, ["a/x.ts", "b.ts"])?.stage).toBe("hit");
  });
});
