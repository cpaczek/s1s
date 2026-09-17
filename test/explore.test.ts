import { describe, expect, it } from "vitest";
import { explore } from "../src/nav/explore.ts";
import { newTally } from "../src/nav/walk.ts";
import type { NavEvent } from "../src/nav/events.ts";
import { fakeClient, fakeIndex } from "./fake.ts";

// A name trap: `packages/shared` looks far better than `packages/db` by name, but every
// leaf under it fails verification. The target lives under db.
const PATHS = [
  "apps/api/src/index.ts",
  "packages/db/src/auth-base.ts",
  "packages/db/src/schema.prisma",
  "packages/shared/src/index.ts",
  "packages/shared/src/other.ts",
  "packages/shared/src/third.ts",
  "README.md",
];

const TRAP = {
  choicePrefs: { packages: 5, apps: 0.05, shared: 9, db: 1, src: 5, "index.ts": 3, "other.ts": 1.3, "third.ts": 1.3, "auth-base.ts": 5, "schema.prisma": 0.3, "packages/db/src/auth-base.ts": 5 },
  nouls: { "located somewhere under": 0.9 },
  verify: { "packages/db/src/auth-base.ts": 0.95 },
  defaultNoul: 0.05,
};

describe("explore", () => {
  it("walks back up after the trap branch dies and finds the target under the sibling", async () => {
    const client = fakeClient(TRAP);
    const events: NavEvent[] = [];
    const out = await explore({ client, index: fakeIndex(PATHS), query: "q", scope: "", width: 2, maxCalls: 40, emit: (e) => events.push(e), tally: newTally() });
    expect(out.found).toBe("packages/db/src/auth-base.ts");
    expect(out.verified[0].path).toBe("packages/db/src/auth-base.ts");
    // leaves under the trap died on verification …
    expect(out.dead).toContain("packages/shared/src/index.ts");
    // … the walk went back UP and re-decided with the dead leaves excluded …
    const up = events.filter((e): e is Extract<NavEvent, { type: "walk_up" }> => e.type === "walk_up");
    expect(up.some((e) => e.path === "packages/shared/src" && e.excluded.includes("packages/shared/src/index.ts"))).toBe(true);
    // … and the leader changed branch.
    expect(events.some((e) => e.type === "backtrack")).toBe(true);
    expect(out.walkUps).toBeGreaterThan(0);
    expect(out.heat.get("packages/db/src/auth-base.ts")).toBeCloseTo(0.95);
    // the comparative endgame ran: a pick probability exists and a verify event lists the finalists together
    expect(out.pick?.get("packages/db/src/auth-base.ts")).toBeGreaterThan(0.5);
    const verifies = events.filter((e): e is Extract<NavEvent, { type: "verify" }> => e.type === "verify");
    expect(verifies.at(-1)!.candidates.some((c) => c.path === "packages/db/src/auth-base.ts")).toBe(true);
  });

  it("exhausts a trap branch and re-decides all the way up to its grandparent", async () => {
    // db is nearly invisible by name (p ≈ 0.002), so the target is only reachable once
    // `shared` is exhausted and `packages` is re-asked without it.
    const client = fakeClient({ ...TRAP, choicePrefs: { ...TRAP.choicePrefs, db: 0.02 } });
    const events: NavEvent[] = [];
    const out = await explore({ client, index: fakeIndex(PATHS), query: "q", scope: "", width: 2, maxCalls: 40, emit: (e) => events.push(e), tally: newTally() });
    expect(out.found).toBe("packages/db/src/auth-base.ts");
    const deadEv = events.filter((e): e is Extract<NavEvent, { type: "dead" }> => e.type === "dead");
    expect(deadEv.some((e) => e.reason === "exhausted" && e.path === "packages/shared/src")).toBe(true);
    const up = events.filter((e): e is Extract<NavEvent, { type: "walk_up" }> => e.type === "walk_up");
    expect(up.some((e) => e.path === "packages" && e.excluded.includes("packages/shared"))).toBe(true);
  });

  it("never re-decides a parent because of a child that was never a real pick", async () => {
    const client = fakeClient({ ...TRAP, choicePrefs: { ...TRAP.choicePrefs, apps: 0.001 } });
    const events: NavEvent[] = [];
    await explore({ client, index: fakeIndex(PATHS), query: "q", scope: "", width: 2, maxCalls: 40, emit: (e) => events.push(e), tally: newTally() });
    const up = events.filter((e): e is Extract<NavEvent, { type: "walk_up" }> => e.type === "walk_up");
    expect(up.some((e) => e.path === "" && e.excluded.includes("README.md"))).toBe(false);
  });

  it("stops at the call budget and still returns what it verified", async () => {
    const client = fakeClient(TRAP);
    const tally = newTally();
    const out = await explore({ client, index: fakeIndex(PATHS), query: "q", scope: "", width: 2, maxCalls: 3, emit: () => {}, tally });
    expect(tally.calls).toBeLessThanOrEqual(4);
    expect(out.found).toBeUndefined();
    expect(Array.isArray(out.verified)).toBe(true);
  });

  it("rejects a leaf scope", async () => {
    await expect(explore({ client: fakeClient(TRAP), index: fakeIndex(PATHS), query: "q", scope: "README.md", emit: () => {}, tally: newTally() })).rejects.toThrow(/scope/);
  });
});
