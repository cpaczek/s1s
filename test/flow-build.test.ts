import { describe, expect, it } from "vitest";
import { buildFlow, clusterOf, titles, type Judged, type JudgedBlock, type JudgedEdge } from "../src/flow/build.ts";
import { fakeIndex } from "./fake.ts";

const PATHS = [
  "apps/api/package.json",
  "apps/api/src/index.ts",
  "apps/api/src/trpc.ts",
  "apps/api/src/routers/mcp.ts",
  "packages/db/package.json",
  "packages/db/src/auth-base.ts",
  "packages/db/src/auth.ts",
  "packages/db/src/index.ts",
  "scripts/dev-auth.sh",
];
const index = fakeIndex(PATHS);

const j = (path: string, over: Partial<Judged> = {}): Judged => ({ path, part: 0.9, plumbing: 0.1, role: "service", roleConfidence: 0.8, hop: 1, seed: false, terminal: false, fanIn: 1, ...over });
const e = (from: string, to: string, over: Partial<JudgedEdge> = {}): JudgedEdge => ({ from, to, names: ["x"], at: `${from}:1`, carries: 0.8, kind: "import", ...over });

describe("clusterOf / titles", () => {
  it("clusters by the nearest package.json, else the top-level directory", () => {
    expect(clusterOf(index, "apps/api/src/trpc.ts")).toBe("apps/api");
    expect(clusterOf(index, "packages/db/src/auth.ts")).toBe("packages/db");
    expect(clusterOf(index, "scripts/dev-auth.sh")).toBe("scripts");
  });
  it("disambiguates colliding basenames with the parent folder", () => {
    const t = titles(["apps/api/src/index.ts", "packages/db/src/index.ts", "apps/api/src/trpc.ts"]);
    expect(t.get("apps/api/src/index.ts")).toBe("src/index.ts");
    expect(t.get("apps/api/src/trpc.ts")).toBe("trpc.ts");
  });
});

describe("buildFlow", () => {
  const nodes = [
    j("apps/api/src/index.ts", { role: "entrypoint", seed: true, part: 0.95 }),
    j("apps/api/src/trpc.ts", { role: "guard", part: 0.8 }),
    j("apps/api/src/routers/mcp.ts", { role: "handler", part: 0.7 }),
    j("packages/db/src/auth-base.ts", { role: "service", part: 0.96, seed: true }),
    j("packages/db/src/auth.ts", { role: "config", part: 0.9 }),
    j("packages/db/src/index.ts", { role: "persistence", part: 0.6, terminal: true, fanIn: 400 }),
    j("scripts/dev-auth.sh", { part: 0.3 }), // below MEMBER: never drawn
  ];
  const edges = [
    e("apps/api/src/index.ts", "packages/db/src/auth.ts"),
    e("apps/api/src/index.ts", "apps/api/src/routers/mcp.ts"),
    e("apps/api/src/routers/mcp.ts", "apps/api/src/trpc.ts", { names: ["protectedProcedure"] }), // handler imports its guard → drawn guard → handler
    e("packages/db/src/auth.ts", "packages/db/src/auth-base.ts"),
    e("packages/db/src/auth-base.ts", "packages/db/src/index.ts", { carries: 0.2 }), // weak, but the store's only edge
    e("packages/db/src/auth-base.ts", "apps/api/src/index.ts", { carries: 0.9, kind: "mention", names: [] }), // against the flow → back
    e("apps/api/src/index.ts", "scripts/dev-auth.sh"), // to an undrawn unit → dropped
  ];
  const summary: JudgedBlock = { path: "packages/db/src/auth-base.ts", line: 1, kind: "comment", text: ["The one source of truth for how Cubby authenticates. Both instances spread it.", "→ export function baseAuthOptions() {}"], score: 0.9 };
  const weak: JudgedBlock = { path: "packages/db/src/auth-base.ts", line: 40, kind: "code", text: ["cookieCache: true"], score: 0.4 };
  const strong: JudgedBlock = { path: "packages/db/src/auth-base.ts", line: 60, kind: "code", text: ["databaseHooks: {"], score: 0.8 };
  const g = buildFlow({ index, topic: "authentication", nodes, edges, blocks: new Map([["packages/db/src/auth-base.ts", [summary, weak, strong]]]), summaries: new Map([["packages/db/src/auth-base.ts", summary]]), hubs: ["packages/db/src/index.ts", "apps/api/src/appRouter.ts"] });

  it("draws the accepted units with real titles, clusters and roles", () => {
    expect(g.nodes.map((n) => n.id)).not.toContain("scripts/dev-auth.sh");
    expect(g.nodes).toHaveLength(6);
    expect(g.clusters.map((c) => c.id)).toEqual(expect.arrayContaining(["apps/api", "packages/db"]));
    expect(g.nodes.find((n) => n.id === "apps/api/src/index.ts")).toMatchObject({ title: "src/index.ts", role: "entrypoint", seed: true, cluster: "apps/api" });
    expect(g.nodes.find((n) => n.id === "packages/db/src/index.ts")).toMatchObject({ terminal: true, role: "persistence" });
  });

  it("orders by role rank then reference depth; clusters follow the order", () => {
    const pos = (id: string) => g.order.indexOf(id);
    expect(pos("apps/api/src/index.ts")).toBeLessThan(pos("apps/api/src/trpc.ts"));
    expect(pos("apps/api/src/trpc.ts")).toBeLessThan(pos("apps/api/src/routers/mcp.ts"));
    expect(pos("packages/db/src/auth-base.ts")).toBeLessThan(pos("packages/db/src/index.ts"));
    expect(g.clusters[0].id).toBe("apps/api");
    expect(g.nodes.map((n) => n.id)).toEqual(g.order);
  });

  it("turns a handler's guard import around, keeps a store's only edge, flags edges against the flow, drops edges to undrawn units", () => {
    const guard = g.edges.find((x) => x.names.includes("protectedProcedure"))!;
    expect([guard.from, guard.to]).toEqual(["apps/api/src/trpc.ts", "apps/api/src/routers/mcp.ts"]);
    expect(guard.at).toBe("apps/api/src/routers/mcp.ts:1"); // the reference still points where it really is
    expect(g.edges.some((x) => x.to === "packages/db/src/index.ts" && x.carries === 0.2)).toBe(true);
    expect(g.edges.find((x) => x.kind === "mention")?.back).toBe(true);
    expect(g.edges.some((x) => x.to === "scripts/dev-auth.sh")).toBe(false);
    expect(g.dropped.edges).toBe(0);
    expect(g.dropped.hubs).toEqual(["apps/api/src/appRouter.ts"]); // the drawn hub is not "left out"
    expect(g.edges.filter((x) => x.back).every((x, i, arr) => g.edges.indexOf(x) >= g.edges.length - arr.length)).toBe(true); // back edges last
  });

  it("summaries come from the crowned comment (first sentence, no anchor line); evidence is the summary plus the strong blocks", () => {
    const n = g.nodes.find((x) => x.id === "packages/db/src/auth-base.ts")!;
    expect(n.summary).toBe("The one source of truth for how Cubby authenticates.");
    expect(n.evidence.map((ev) => ev.line)).toEqual([1, 60]);
    expect(g.nodes.find((x) => x.id === "apps/api/src/index.ts")!.summary).toBeUndefined();
  });

  it("verdict and determinism", () => {
    expect(g.verdict).toBe("found");
    expect(buildFlow({ index, topic: "authentication", nodes: [], edges: [], blocks: new Map(), summaries: new Map(), hubs: [] }).verdict).toBe("absent");
    const again = buildFlow({ index, topic: "authentication", nodes: [...nodes].reverse(), edges: [...edges].reverse(), blocks: new Map([["packages/db/src/auth-base.ts", [strong, weak, summary]]]), summaries: new Map([["packages/db/src/auth-base.ts", summary]]), hubs: ["apps/api/src/appRouter.ts", "packages/db/src/index.ts"] });
    expect(JSON.stringify(again)).toBe(JSON.stringify(g));
  });
});
