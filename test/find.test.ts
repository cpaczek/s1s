import { describe, expect, it } from "vitest";
import { find } from "../src/nav/find.ts";
import { newTally } from "../src/nav/walk.ts";
import type { NavEvent } from "../src/nav/events.ts";
import { T } from "../src/questions.ts";
import { fakeClient, fakeIndex } from "./fake.ts";

const PATHS = [
  "apps/api/src/index.ts",
  "apps/api/src/lib/dev-login.ts",
  "apps/horse-api/src/mcp/verifier.ts",
  "packages/db/src/auth-base.ts",
  "packages/db/src/auth-horse.ts",
  "packages/db/src/index.ts",
  "README.md",
];
const TEXTS: Record<string, string> = {
  "apps/horse-api/src/mcp/verifier.ts": "// verifies the jwt on every mcp request\nexport const verify = (token: string) => jwtVerify(token);",
  "packages/db/src/auth-horse.ts": "// horse-api's better-auth instance: jwt() signs the access tokens\nimport { admin, bearer, jwt } from 'better-auth/plugins';\nexport const horseAuth = betterAuth({ plugins: [admin(), bearer(), jwt()] });",
  "packages/db/src/auth-base.ts": "// Shared better-auth options both instances spread\nexport function baseAuthOptions() {}",
  "apps/api/src/lib/dev-login.ts": "// mints a dev session cookie for local api calls\nexport function handleDevLogin() {}",
  "README.md": "# Cubby\nRun pnpm dev.",
};
/** What "where do we mint jwts" retrieves lexically: the two files that say jwt, and the one that "mints". */
const JWT_POOL = ["apps/api/src/lib/dev-login.ts", "apps/horse-api/src/mcp/verifier.ts", "packages/db/src/auth-horse.ts"];
/** Three hundred filler units: a scope too large to shortlist whole. */
const FILLER = Array.from({ length: 300 }, (_, i) => `packages/big/src/file${i}.ts`);

const run = (client: ReturnType<typeof fakeClient>, query = "where do we mint jwts", extra: Partial<Parameters<typeof find>[0]> = {}) => {
  const events: NavEvent[] = [];
  const index = fakeIndex(PATHS, TEXTS);
  return find({ client, index, query, scope: "", beam: 3, maxDepth: 12, emit: (e) => events.push(e), tally: newTally(), ...extra }).then((out) => ({ out, events, index }));
};

describe("find", () => {
  it("shortlists the whole scope when it is small, verifies the best, and stops when found", async () => {
    const client = fakeClient({ byPath: { shortlist: { "packages/db/src/auth-horse.ts": 0.8, "apps/horse-api/src/mcp/verifier.ts": 0.5 } }, verify: { "packages/db/src/auth-horse.ts": 0.9, "apps/horse-api/src/mcp/verifier.ts": 0.2 }, defaultNoul: 0.03 });
    const { out, events } = await run(client);
    const lexical = events.find((e) => e.type === "lexical");
    expect(lexical?.type === "lexical" && lexical.whole).toBe(true);
    expect(lexical?.type === "lexical" && lexical.paths.slice(0, 3).sort()).toEqual(JWT_POOL);
    expect(lexical?.type === "lexical" && lexical.paths).toHaveLength(PATHS.length); // small scope: every unit judged
    expect(out.results[0]).toMatchObject({ path: "packages/db/src/auth-horse.ts", verify: 0.9, via: "lexical", shortlist: 0.8 });
    expect(out.escalated).toBe(false);
    expect(events.map((e) => e.type)).toEqual(["lexical", "shortlist", "verify"]);
    expect(client.calls).toBe(2); // one shortlist batch + one verify, no walk
    // The verify state carried the descriptor's evidence, aimed by the query's terms: line numbers appear.
    const verifyState = client.states[1] as { candidates: Array<{ path: string; head: string[] }> };
    const horse = verifyState.candidates.find((c) => c.path === "packages/db/src/auth-horse.ts")!;
    expect(horse.head.some((l) => /^\d+: .*jwt\(\)/.test(l))).toBe(true);
    // Heat: judged units and their containers, never the untouched.
    expect(out.heat.get("packages/db")).toBeCloseTo(0.9);
  });

  it("escalates to a seeded walk when verify does not find it, and the walk's finishers get verified", async () => {
    // The words of the query occur nowhere in auth-base.ts, so the pool cannot hold it; the walk
    // (Choice prefs) leads there, and its finisher verifies.
    const client = fakeClient({
      byPath: { shortlist: { "apps/horse-api/src/mcp/verifier.ts": 0.3 } },
      verify: { "packages/db/src/auth-base.ts": 0.85 },
      choicePrefs: { packages: 5, db: 5, src: 5, "auth-base.ts": 5 },
      nouls: { "located somewhere under": 0.8 },
      defaultNoul: 0.05,
    });
    const events: NavEvent[] = [];
    const index = fakeIndex([...PATHS, ...FILLER], TEXTS);
    const out = await find({ client, index, query: "where do we mint jwts", scope: "", beam: 3, maxDepth: 12, emit: (e) => events.push(e), tally: newTally() });
    expect(out.escalated).toBe(true);
    const escalate = events.find((e) => e.type === "escalate");
    expect(escalate?.type === "escalate" && escalate.reason).toBe("absent");
    expect(events.some((e) => e.type === "expand")).toBe(true);
    expect(out.results[0]).toMatchObject({ path: "packages/db/src/auth-base.ts", via: "walk" });
    expect(out.results[0].verify).toBeCloseTo(0.85);
    expect(out.visited.length).toBeGreaterThan(0);
    // The second verify compared the walk's finisher with the first pass's survivors, and the lexical rows kept their origin.
    expect(out.results.some((r) => r.via === "lexical")).toBe(true);
  });

  it("pools rather than shortlisting everything once the scope is large", async () => {
    const client = fakeClient({ verify: { "packages/db/src/auth-horse.ts": 0.9 }, defaultNoul: 0.02 });
    const events: NavEvent[] = [];
    const index = fakeIndex([...PATHS, ...FILLER], TEXTS);
    const out = await find({ client, index, query: "where do we mint jwts", scope: "", beam: 3, maxDepth: 12, emit: (e) => events.push(e), tally: newTally() });
    const lexical = events.find((e) => e.type === "lexical");
    expect(lexical?.type === "lexical" && lexical.whole).toBe(false);
    expect(lexical?.type === "lexical" && [...lexical.paths].sort()).toEqual(JWT_POOL);
    expect(out.escalated).toBe(false);
    expect(client.calls).toBe(2);
  });

  it("evidence-judges candidates beyond eight even when an early descriptor favorite looks confident", async () => {
    const paths = Array.from({ length: 30 }, (_, i) => `src/route-${String(i).padStart(2, "0")}.ts`);
    const texts = Object.fromEntries(paths.map((p) => [p, "export function routeRequest() {}"]));
    const shortlist = Object.fromEntries(paths.map((p, i) => [p, 0.95 - i / 100]));
    const target = paths[15];
    const client = fakeClient({ byPath: { shortlist }, verify: { [paths[0]]: 0.8, [target]: 0.98 }, defaultNoul: 0.01 });
    const { out, events } = await run(client, "route request", { index: fakeIndex(paths, texts) });
    expect(out.results[0]).toMatchObject({ path: target, verify: 0.98, shortlist: shortlist[target] });
    expect(out.results.length).toBeGreaterThan(10);
    expect(out.results.length).toBeLessThanOrEqual(T.SHORTLIST_KEEP + T.LEX_KEEP);
    const judged = events.filter((e) => e.type === "verify").flatMap((e) => e.candidates.map((c) => c.path));
    expect(out.results.every((r) => r.verify !== undefined && judged.includes(r.path))).toBe(true);
    expect(out.escalated).toBe(false);
    expect(client.calls).toBe(2);
  });

  it("reserves independent lexical evidence slots when the descriptor shortlist misses the answer", async () => {
    const paths = ["src/needle.ts", ...Array.from({ length: 35 }, (_, i) => `src/filler-${String(i).padStart(2, "0")}.ts`)];
    const target = paths[0];
    const texts = Object.fromEntries(paths.map((p) => [p, "export function operation() {}"]));
    const shortlist = Object.fromEntries(paths.slice(1).map((p) => [p, 0.9]));
    const client = fakeClient({ byPath: { shortlist }, verify: { [target]: 0.99 }, defaultNoul: 0.01 });
    const { out } = await run(client, "needle", { index: fakeIndex(paths, texts) });
    expect(out.results[0]).toMatchObject({ path: target, verify: 0.99, shortlist: 0.01 });
    expect(out.results).toHaveLength(T.SHORTLIST_KEEP + 1);
  });

  it("rejects a scope that is not a container", async () => {
    await expect(run(fakeClient({}), "q", { scope: "README.md" })).rejects.toThrow(/scope is not a directory/);
  });
});
