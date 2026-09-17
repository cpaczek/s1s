// ui/flow.js layoutFlow: pure, deterministic, and geometrically sound on the three fixtures and on
// degenerate graphs. Runs under Node with the default character-width measurement (no DOM).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FLOW_ROLE_ORDER, type FlowEdge, type FlowGraph, type FlowNode } from "../src/flow/types.ts";
import { layoutFlow, type FlowLayout } from "../ui/flow.js";

const here = new URL(".", import.meta.url).pathname;
const fixture = (name: string): FlowGraph => JSON.parse(readFileSync(`${here}../ui/fixtures/flow-${name}.json`, "utf8")) as FlowGraph;
const FIXTURES = ["tiny", "auth", "stress"] as const;

const overlaps = (p: { x: number; y: number; w: number; h: number }, q: { x: number; y: number; w: number; h: number }) =>
  p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h;

const node = (id: string, over: Partial<FlowNode> = {}): FlowNode => ({
  id, kind: "file", path: id, title: id.split("/").pop() ?? id, summary: "The author's sentence about " + id + ".",
  role: "service", roleConfidence: 0.9, part: 0.7, cluster: id.split("/").slice(0, 2).join("/"), seed: false, terminal: false,
  evidence: [{ path: id, line: 3, lines: ["// a comment", "export const x = 1;"], kind: "comment", score: 0.8 }], ...over,
});
const edge = (from: string, to: string, over: Partial<FlowEdge> = {}): FlowEdge => ({ from, to, kind: "import", names: ["x"], at: from + ":1", carries: 0.8, ...over });
const graph = (nodes: FlowNode[], edges: FlowEdge[], extra: Partial<FlowGraph> = {}): FlowGraph => {
  const ids = [...new Set(nodes.map((n) => n.cluster))];
  return { topic: "synthetic", nodes, edges, clusters: ids.map((c) => ({ id: c, title: c, nodes: nodes.filter((n) => n.cluster === c).map((n) => n.id) })), order: nodes.map((n) => n.id), dropped: { nodes: 0, edges: 0, hubs: [] }, verdict: "found", ...extra };
};
const finite = (L: FlowLayout) => {
  expect(Number.isFinite(L.width) && Number.isFinite(L.height)).toBe(true);
  expect(/NaN|Infinity|undefined/.test(JSON.stringify(L))).toBe(false);
};

describe.each(FIXTURES)("layoutFlow(%s)", (name) => {
  const g = fixture(name);
  const L = layoutFlow(g);

  it("is deterministic and independent of input order", () => {
    expect(JSON.stringify(layoutFlow(g))).toBe(JSON.stringify(L));
    const shuffled: FlowGraph = { ...g, nodes: g.nodes.slice().reverse(), edges: g.edges.slice().reverse(), clusters: g.clusters.slice().reverse().map((c) => ({ ...c, nodes: c.nodes.slice().reverse() })) };
    const M = layoutFlow(shuffled);
    for (const n of L.nodes) {
      const m = M.nodes.find((q) => q.id === n.id);
      expect(m, n.id).toBeDefined();
      expect(Math.abs(m!.x - n.x) < 1e-6 && Math.abs(m!.y - n.y) < 1e-6, `${n.id} moved`).toBe(true);
    }
  });

  it("draws every node once with finite geometry and no overlaps", () => {
    finite(L);
    expect(L.nodes.length).toBe(g.nodes.length);
    for (const n of L.nodes) expect(n.w > 0 && n.h > 0).toBe(true);
    for (let i = 0; i < L.nodes.length; i++) for (let j = i + 1; j < L.nodes.length; j++) expect(overlaps(L.nodes[i], L.nodes[j]), `${L.nodes[i].id} / ${L.nodes[j].id}`).toBe(false);
  });

  it("keeps every node inside its own cluster and out of foreign ones", () => {
    for (const n of L.nodes) {
      const c = L.clusters.find((k) => (n.floor ? k.floor : k.id === n.cluster));
      expect(c, n.id).toBeDefined();
      expect(n.x >= c!.x && n.y >= c!.y && n.x + n.w <= c!.x + c!.w && n.y + n.h <= c!.y + c!.h, `${n.id} outside ${c!.id}`).toBe(true);
      for (const k of L.clusters) if (k !== c) expect(overlaps(n, k), `${n.id} inside ${k.id}`).toBe(false);
    }
    for (let i = 0; i < L.clusters.length; i++) for (let j = i + 1; j < L.clusters.length; j++) expect(overlaps(L.clusters[i], L.clusters[j])).toBe(false);
  });

  it("gives every edge path data, an arrow and a hover label when it carries names", () => {
    expect(L.edges.length).toBe(g.edges.filter((e) => e.from !== e.to).length);
    for (const e of L.edges) {
      expect(e.d.startsWith("M") && e.d.length > 8, `${e.from} -> ${e.to}`).toBe(true);
      expect(["down", "up", "left", "right"]).toContain(e.arrow.dir);
      if (e.names.length && e.kind !== "mention") expect(e.label, `${e.from} -> ${e.to}`).toBeDefined();
    }
  });

  it("points static references down the stage order and never against a role floor", () => {
    const layer = new Map(L.nodes.map((n) => [n.id, n.layer]));
    const rank = (id: string) => FLOW_ROLE_ORDER.indexOf(g.nodes.find((n) => n.id === id)!.role);
    for (const e of g.edges) {
      if (e.back || e.kind === "mention" || e.from === e.to) continue;
      const from = g.nodes.find((n) => n.id === e.from)!;
      if (from.role === "test") continue;
      expect(layer.get(e.to)! > layer.get(e.from)!, `${e.from} -> ${e.to} (${e.kind})`).toBe(true);
    }
    // a row is labelled by its stage: a node in a GUARD row is a guard, or was pushed there by an importer
    const importers = new Set(g.edges.filter((e) => !e.back && e.kind !== "mention").map((e) => e.to));
    for (const n of L.nodes) {
      if (n.floor || n.role === "test" || importers.has(n.id)) continue;
      const band = L.stages.find((s) => n.y >= s.y - 1 && n.y + n.h <= s.y + s.h + 1);
      expect(band && band.text === n.role, `${n.id} (${n.role}) sits in the ${band?.text} band`).toBe(true);
      for (const m of L.nodes) if (!m.floor && m.role !== "test" && rank(m.id) > rank(n.id)) expect(m.layer > n.layer, `${m.id} (${m.role}) is not below ${n.id} (${n.role})`).toBe(true);
    }
  });

  it("routes wires and labels clear of unrelated nodes", () => {
    let under = 0;
    for (const e of L.edges) for (let i = 1; i < e.points.length; i++) {
      const [x0, y0] = e.points[i - 1], [x1, y1] = e.points[i];
      for (let t = 0.05; t < 1; t += 0.05) {
        const s = t * t * (3 - 2 * t);
        const x = x0 + (x1 - x0) * s, y = y0 + (y1 - y0) * t;
        for (const n of L.nodes) if (n.id !== e.from && n.id !== e.to && x > n.x && x < n.x + n.w && y > n.y && y < n.y + n.h) { under++; break; }
      }
    }
    expect(under).toBe(0);
    for (const e of L.edges) {
      if (!e.label || !e.label.shown) continue;
      const l = e.label;
      const x0 = l.anchor === "middle" ? l.x - l.w / 2 : l.x;
      for (const n of L.nodes) expect(overlaps({ x: x0, y: l.y - l.h / 2, w: l.w, h: l.h }, n), `label "${l.text}" over ${n.id}`).toBe(false);
    }
  });

  it("puts third-party packages on the floor and the spine on static references only", () => {
    for (const n of L.nodes) expect(n.floor).toBe(n.kind === "package");
    if (L.spine.length) {
      expect(L.spine.length).toBeGreaterThanOrEqual(3);
      for (let i = 1; i < L.spine.length; i++) {
        const e = g.edges.find((x) => x.from === L.spine[i - 1] && x.to === L.spine[i] && !x.back && x.kind !== "mention");
        expect(e, `${L.spine[i - 1]} -> ${L.spine[i]}`).toBeDefined();
      }
    }
  });
});

describe("layoutFlow on degenerate graphs", () => {
  it("survives an empty graph", () => {
    const L = layoutFlow(graph([], []));
    finite(L);
    expect(L.nodes.length).toBe(0);
    expect(L.edges.length).toBe(0);
  });
  it("survives empty clusters and a missing order", () => {
    const g = graph([], [], { clusters: [{ id: "apps/x", title: "apps/x", nodes: [] }] });
    finite(layoutFlow(g));
    const h = graph([node("apps/a/x.ts"), node("apps/a/y.ts")], [edge("apps/a/x.ts", "apps/a/y.ts")]);
    delete (h as Partial<FlowGraph>).order;
    finite(layoutFlow(h));
  });
  it("lays out a single node and a single package", () => {
    finite(layoutFlow(graph([node("apps/a/index.ts", { role: "entrypoint", seed: true })], [])));
    const L = layoutFlow(graph([node("pkg:jose", { kind: "package", role: "external", title: "jose", path: "jose", cluster: "third-party", summary: undefined })], []));
    finite(L);
    expect(L.nodes[0].floor).toBe(true);
  });
  it("drops self edges and dangling ids without throwing", () => {
    const L = layoutFlow(graph([node("apps/a/index.ts", { role: "entrypoint" }), node("apps/a/svc.ts")], [edge("apps/a/index.ts", "apps/a/svc.ts"), edge("apps/a/svc.ts", "apps/a/svc.ts"), edge("apps/a/index.ts", "nope.ts"), edge("ghost.ts", "apps/a/svc.ts")]));
    finite(L);
    expect(L.edges.length).toBe(1);
  });
  it("breaks an unflagged cycle instead of looping", () => {
    const L = layoutFlow(graph([node("apps/a/x.ts"), node("apps/a/y.ts"), node("apps/a/z.ts")], [edge("apps/a/x.ts", "apps/a/y.ts"), edge("apps/a/y.ts", "apps/a/z.ts"), edge("apps/a/z.ts", "apps/a/x.ts")]));
    finite(L);
    expect(L.edges.filter((e) => e.back).length).toBe(1);
    finite(layoutFlow(graph([node("apps/a/x.ts"), node("apps/a/y.ts")], [edge("apps/a/y.ts", "apps/a/x.ts", { back: true })])));
  });
  it("fits every text to its card, even an unbreakable 100-character token", () => {
    const long = "a".repeat(60) + "VeryLongIdentifierNameThatGoesOnAndOn" + "b".repeat(100);
    const L = layoutFlow(graph(
      [node("apps/a/index.ts", { role: "entrypoint", seed: true, title: long, part: 0.99, summary: ("Extremely long summary sentence that never ends " + long + " ").repeat(3) }), node("apps/a/" + "deeply/nested/".repeat(10) + "svc.ts", { title: "svc.ts" })],
      [edge("apps/a/index.ts", "apps/a/" + "deeply/nested/".repeat(10) + "svc.ts", { names: Array.from({ length: 12 }, (_, i) => "identifierNumber" + i) })],
    ));
    finite(L);
    for (const n of L.nodes) {
      expect(n.text.title.length).toBeLessThan(80);
      for (const line of n.text.lines) expect(line.length).toBeLessThan(80);
      expect(n.text.sub.length).toBeLessThan(80);
    }
    const lbl = L.edges[0].label!;
    expect(lbl.text.includes("…")).toBe(false);
    expect(lbl.text).toMatch(/\+\d+$/);
  });
  it("keeps a 36-node chain and a 20-way fan-in finite and overlap-free", () => {
    const roles = FLOW_ROLE_ORDER.slice(0, 9);
    const chain = Array.from({ length: 36 }, (_, i) => node(`packages/p${i % 4}/f${i}.ts`, { role: roles[Math.floor(i / 4)], part: 0.5 + (i % 5) / 10 }));
    const es: FlowEdge[] = [];
    for (let i = 1; i < 36; i++) es.push(edge(chain[i - 1].id, chain[i].id));
    for (let i = 0; i + 7 < 36; i += 3) es.push(edge(chain[i].id, chain[i + 7].id, { carries: 0.4 }));
    const L = layoutFlow(graph(chain, es));
    finite(L);
    const hub = node("pkg:hub", { kind: "package", role: "external", title: "hub", path: "hub", cluster: "third-party", terminal: true });
    const fan = [hub, ...Array.from({ length: 20 }, (_, i) => node(`apps/a${i % 3}/f${i}.ts`))];
    const M = layoutFlow(graph(fan, fan.slice(1).map((n) => edge(n.id, "pkg:hub"))));
    finite(M);
    for (const X of [L, M]) for (let i = 0; i < X.nodes.length; i++) for (let j = i + 1; j < X.nodes.length; j++) expect(overlaps(X.nodes[i], X.nodes[j])).toBe(false);
  });
  it("places tests just above what they exercise and groups as cards", () => {
    const L = layoutFlow(graph([node("apps/a/x.test.ts", { role: "test" }), node("apps/a/x.ts", { role: "guard" }), node("group:1", { kind: "group", title: "components", path: "apps/a/components", members: ["apps/a/components/a.tsx"], role: "ui", cluster: "apps/a", summary: undefined })], [edge("apps/a/x.test.ts", "apps/a/x.ts"), edge("group:1", "apps/a/x.ts")]));
    finite(L);
    const by = new Map(L.nodes.map((n) => [n.id, n]));
    expect(by.get("apps/a/x.test.ts")!.layer).toBeLessThan(by.get("apps/a/x.ts")!.layer);
    expect(L.stages.map((s) => s.text)).toEqual(["ui", "test", "guard"]);
  });
});
