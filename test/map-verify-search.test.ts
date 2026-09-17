import { describe, expect, it } from "vitest";
import { map, relatives, rollUpDirHeat } from "../src/nav/map.ts";
import { candidateFor, verify } from "../src/nav/verify.ts";
import { runSearch, normalizeParams } from "../src/nav/search.ts";
import { newTally } from "../src/nav/walk.ts";
import type { NavEvent } from "../src/nav/events.ts";
import { T, topicFromQuery } from "../src/questions.ts";
import { fakeClient, fakeIndex } from "./fake.ts";
import { parseQuery } from "../src/index/lex.ts";

const PATHS = [
  "apps/api/src/index.ts",
  "apps/api/src/lib/auth.ts",
  "packages/db/src/auth-base.ts",
  "packages/db/src/schema.prisma",
  "packages/shared/src/index.ts",
  "README.md",
];
/** Bodies, so the lexical prefilter has something to match. */
const TEXTS: Record<string, string> = {
  "apps/api/src/lib/auth.ts": "export const auth = betterAuth({ session: { cookieCache: true } });",
  "packages/db/src/auth-base.ts": "// Shared better-auth options: authentication for both apps\nexport function baseAuthOptions() {}",
  "README.md": "# Cubby\nRun pnpm dev. Authentication uses better-auth.",
  "packages/db/src/schema.prisma": "model User { id String @id }",
};

describe("map", () => {
  it("relatives finds the vocabulary words a subject word begins with or extends", () => {
    expect(relatives(["auth", "authenticated", "author", "oauth", "flashcards", "card"], ["authentication", "flashcard"])).toEqual(["auth", "flashcards"]); // "authenticated" is a sibling, not a prefix
    expect(relatives(["auth"], ["auth"])).toEqual([]); // too short to have relatives, and never itself
  });

  it("prefilters lexically, judges every candidate on its descriptor, and rolls heat up", async () => {
    const client = fakeClient({ byPath: { member: { "packages/db/src/auth-base.ts": 0.93, "apps/api/src/lib/auth.ts": 0.4 } }, defaultNoul: 0.02 });
    const events: NavEvent[] = [];
    const out = await map({ client, index: fakeIndex(PATHS, TEXTS), topic: topicFromQuery("authentication"), scope: "", emit: (e) => events.push(e), tally: newTally() });
    expect(out.scored[0]).toEqual({ path: "packages/db/src/auth-base.ts", noul: 0.93 });
    // Only units that share the subject's words (auth ⊂ authentication) were judged — never the whole tree.
    expect(out.scored.map((s) => s.path)).not.toContain("packages/shared/src/index.ts");
    expect(out.terms.map((t) => t.label)).toContain("auth");
    expect(out.heat.get("packages/db")).toBeCloseTo(0.93);
    expect(out.heat.get("apps")).toBeCloseTo(0.4);
    const batches = events.filter((e) => e.type === "batch");
    expect(batches).toHaveLength(1);
    expect(batches[0].type === "batch" && Object.keys(batches[0].heat)).toHaveLength(out.scored.length);
    // The descriptor, not just the path, reached the state.
    const state = client.states[0] as { topic: string; candidates: Array<{ path: string; kind: string }> };
    expect(state.topic).toBe("authentication");
    expect(state.candidates.every((c) => c.kind === "file")).toBe(true);
    expect(out.visited).toContain("packages/db/src");
  });

  it("restricts to the scope directory", async () => {
    const client = fakeClient({ defaultNoul: 0.1 });
    const out = await map({ client, index: fakeIndex(PATHS, TEXTS), topic: topicFromQuery("auth"), scope: "packages", emit: () => {}, tally: newTally() });
    expect(out.scored.length).toBeGreaterThan(0);
    expect(out.scored.map((s) => s.path).every((p) => p.startsWith("packages/"))).toBe(true);
  });

  it("rollUpDirHeat only marks directories that contain files", () => {
    const idx = fakeIndex(PATHS);
    const heat = new Map<string, number>([["README.md", 0.5]]);
    const visited = rollUpDirHeat(idx.root, heat);
    expect(visited).toContain("");
    expect(heat.get("apps")).toBe(0);
  });
});

describe("verify", () => {
  it("ranks by the match Noul, breaking ties on the pick probability", async () => {
    const client = fakeClient({ nouls: { "candidates[1]": 0.9, "candidates[0]": 0.9 }, choicePrefs: { "packages/db/src/auth-base.ts": 5 } });
    const tally = newTally();
    const rows = await verify({
      client,
      index: fakeIndex(PATHS),
      query: "q",
      candidates: [
        { path: "apps/api/src/lib/auth.ts", via: "walk", pathScore: 0.7 },
        { path: "packages/db/src/auth-base.ts", via: "walk", pathScore: 0.6 },
      ],
      emit: () => {},
      tally,
    });
    expect(rows[0].path).toBe("packages/db/src/auth-base.ts");
    expect(rows[0].verify).toBeCloseTo(0.9);
    expect(rows[0].pick).toBeGreaterThan(rows[1].pick!);
    expect(tally.calls).toBe(1);
  });

  it("preserves source comments and late private declarations hidden by export-only descriptors", () => {
    const path = "src/operations.ts";
    const about = "These routines manage credential lifecycle and rotate expired tokens.";
    const text = [`// ${about}`, ...Array.from({ length: 20 }, (_, i) => `export function routine${i}() {}`), "function rotateCredential() {}"].join("\n");
    const index = fakeIndex([path], { [path]: text });
    const candidate = candidateFor(index, path, parseQuery(index.lex, "rotate credentials"));
    expect(candidate.hint).toBe(about);
    expect(candidate.declarations?.[0]).toEqual({ name: "rotateCredential", kind: "function", line: 22 });
    expect(candidate.declarations).toHaveLength(T.EVIDENCE_DECLS);
    expect(candidate.head).toContain("22: function rotateCredential() {}");
  });

  it("returns nothing for no candidates without calling the API", async () => {
    const client = fakeClient({});
    const rows = await verify({ client, index: fakeIndex(PATHS), query: "q", candidates: [], emit: () => {}, tally: newTally() });
    expect(rows).toEqual([]);
    expect(client.calls).toBe(0);
  });
});

describe("runSearch", () => {
  it("normalizes params", () => {
    expect(normalizeParams({ query: " x ", strategy: "nope" as never, scope: "/apps/", beam: 99, maxDepth: 0 })).toEqual({
      query: "x", strategy: "find", scope: "apps", beam: 10, maxDepth: 1,
    });
  });

  it("walks, verifies the finished units, overrides heat with verify, and sets the verdict", async () => {
    const client = fakeClient({
      choicePrefs: { packages: 5, db: 5, src: 5, "auth-base.ts": 5, "packages/db/src/auth-base.ts": 5 },
      verify: { "packages/db/src/auth-base.ts": 0.88 },
      nouls: { "located somewhere under": 0.8 },
      defaultNoul: 0.03,
    });
    const events: NavEvent[] = [];
    const r = await runSearch({ client, index: fakeIndex(PATHS), params: normalizeParams({ query: "q", strategy: "walk" }), emit: (e) => events.push(e) });
    expect(r.results[0].path).toBe("packages/db/src/auth-base.ts");
    expect(r.results[0].via).toBe("walk");
    expect(r.verdict).toBe("found");
    expect(r.heat["packages/db/src/auth-base.ts"]).toBeCloseTo(0.88);
    expect(r.stats.calls).toBeGreaterThan(2);
    expect(r.stats.estCostUsd).toBeGreaterThan(0);
    expect(events.at(-1)?.type).toBe("done");
  });

  it("reports absent when nothing verifies", async () => {
    const client = fakeClient({ defaultNoul: 0.02 });
    const r = await runSearch({ client, index: fakeIndex(PATHS), params: normalizeParams({ query: "q", strategy: "walk" }), emit: () => {} });
    expect(r.verdict).toBe("absent");
  });
});

describe("map mode", () => {
  it("returns every unit judged part of the topic and paints the scope", async () => {
    const client = fakeClient({ byPath: { member: { "packages/db/src/auth-base.ts": 0.9, "apps/api/src/lib/auth.ts": 0.8, "README.md": 0.4 } }, defaultNoul: 0.02 });
    const r = await runSearch({ client, index: fakeIndex(PATHS, TEXTS), params: normalizeParams({ query: "authentication", strategy: "map" }), emit: () => {} });
    expect(r.mode).toBe("map");
    expect(r.topic?.name).toBe("authentication");
    expect(r.results.map((x) => x.path)).toEqual(["packages/db/src/auth-base.ts", "apps/api/src/lib/auth.ts", "README.md"]);
    expect(r.results.every((x) => x.via === "map")).toBe(true);
    expect(r.verdict).toBe("found");
    expect(Object.keys(r.heat).length).toBeGreaterThan(3); // units + rolled-up containers
    expect(client.calls).toBe(1); // one batch, no verify call
  });
});
