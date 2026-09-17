import { describe, expect, it } from "vitest";
import { extend, isBacktrack, newTally, walk, type Cand } from "../src/nav/walk.ts";
import type { NavEvent } from "../src/nav/events.ts";
import { fakeClient, fakeIndex } from "./fake.ts";

const PATHS = [
  "apps/api/src/index.ts",
  "apps/api/src/lib/auth.ts",
  "packages/db/src/auth-base.ts",
  "packages/db/src/schema.prisma",
  "packages/shared/src/index.ts",
  "README.md",
];

describe("path scoring", () => {
  it("uses the geometric mean of edge probabilities", () => {
    const root: Cand = { path: "", kind: "dir", probProduct: 1, decisions: 0, score: 1, finished: false, edgeP: 1 };
    const a = extend(root, { name: "packages", path: "packages", kind: "dir", size: 0, files: 0 }, 0.5);
    const b = extend(a, { name: "db", path: "packages/db", kind: "dir", size: 0, files: 0 }, 0.5);
    expect(a.score).toBeCloseTo(0.5);
    expect(b.probProduct).toBeCloseTo(0.25);
    expect(b.score).toBeCloseTo(0.5); // sqrt(0.25)
    expect(b.decisions).toBe(2);
  });

  it("marks files as finished and zero-probability edges as score 0", () => {
    const root: Cand = { path: "", kind: "dir", probProduct: 1, decisions: 0, score: 1, finished: false, edgeP: 1 };
    const f = extend(root, { name: "x.ts", path: "x.ts", kind: "file", size: 1, files: 1 }, 0);
    expect(f.finished).toBe(true);
    expect(f.score).toBe(0);
  });
});

describe("backtrack detection", () => {
  const cand = (path: string, kind: "dir" | "file"): Cand => ({ path, kind, probProduct: 1, decisions: 1, score: 1, finished: kind === "file", edgeP: 1 });
  it("is not a backtrack when the new leader descends from the old one", () => {
    expect(isBacktrack(cand("packages", "dir"), cand("packages/db", "dir"))).toBe(false);
    expect(isBacktrack(cand("", "dir"), cand("apps", "dir"))).toBe(false);
  });
  it("is a backtrack when the leader jumps to a sibling branch", () => {
    expect(isBacktrack(cand("packages/shared", "dir"), cand("packages/db", "dir"))).toBe(true);
    expect(isBacktrack(cand("packages/shared/src/index.ts", "file"), cand("packages/db", "dir"))).toBe(true);
  });
});

describe("walk", () => {
  it("follows the scripted preferences to the target and reports it first", async () => {
    const client = fakeClient({ choicePrefs: { packages: 5, db: 5, src: 5, "auth-base.ts": 5 }, defaultNoul: 0.9 });
    const events: NavEvent[] = [];
    const out = await walk({ client, index: fakeIndex(PATHS), query: "q", scope: "", beam: 2, maxDepth: 10, emit: (e) => events.push(e), tally: newTally() });
    expect(out.finished[0].path).toBe("packages/db/src/auth-base.ts");
    expect(out.visited[0]).toBe("");
    expect(events.some((e) => e.type === "expand" && e.path === "packages/db/src")).toBe(true);
    expect(out.heat.get("packages/db/src/auth-base.ts")).toBeGreaterThan(0.5);
    expect(out.separation).toBeGreaterThan(1);
  });

  it("prunes a branch whose under-here Noul is below the threshold and never prunes the root", async () => {
    const client = fakeClient({ choicePrefs: { packages: 5, shared: 5, db: 4, src: 5, "index.ts": 5, "auth-base.ts": 5 }, nouls: { "located somewhere under": 0.9 }, defaultNoul: 0.9 });
    // Make the under-here Noul low only when the fake sees "packages/shared/" in the state? The fake keys on
    // instructions, so instead we set a global low and check the root survives.
    const low = fakeClient({ choicePrefs: { packages: 5, shared: 5, db: 4, src: 5, "index.ts": 5 }, defaultNoul: 0.0 });
    const events: NavEvent[] = [];
    const out = await walk({ client: low, index: fakeIndex(PATHS), query: "q", scope: "", beam: 2, maxDepth: 10, emit: (e) => events.push(e), tally: newTally() });
    const prunes = events.filter((e) => e.type === "prune" && e.reason === "under_here");
    expect(prunes.length).toBeGreaterThan(0);
    expect(prunes.some((e) => e.type === "prune" && e.path === "")).toBe(false);
    expect(out.visited).toContain("");
    void client;
  });

  it("emits a backtrack when the leading path changes branch", async () => {
    // packages/shared leads at first (higher pref) but its files split the probability; db/auth-base wins later.
    const client = fakeClient({ choicePrefs: { packages: 5, shared: 6, db: 5, src: 5, "auth-base.ts": 9, "index.ts": 1, "other.ts": 1 }, defaultNoul: 0.9 });
    const events: NavEvent[] = [];
    await walk({ client, index: fakeIndex([...PATHS, "packages/shared/src/other.ts"]), query: "q", scope: "", beam: 2, maxDepth: 10, emit: (e) => events.push(e), tally: newTally() });
    const bt = events.filter((e) => e.type === "backtrack");
    expect(bt.length).toBeGreaterThan(0);
  });

  it("rejects a file or unknown scope", async () => {
    const client = fakeClient({});
    await expect(walk({ client, index: fakeIndex(PATHS), query: "q", scope: "README.md", beam: 2, maxDepth: 3, emit: () => {}, tally: newTally() })).rejects.toThrow(/scope/);
  });
});
