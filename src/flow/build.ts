// FlowGraph assembly — pure code over TypeSafe's judgments: titles, clusters, edge direction,
// reading order, caps. Nothing here asks a question or invents a word.
import type { RepoIndex } from "../index/build.ts";
import { F, type FlowBlock } from "../questions.ts";
import { firstSentence } from "./blocks.ts";
import { FLOW_ROLE_ORDER, type FlowEdge, type FlowEvidence, type FlowGraph, type FlowNode, type FlowRole } from "./types.ts";

/** What the expansion learned about one unit. */
export type Judged = {
  path: string;
  part: number;
  plumbing: number;
  role: FlowRole;
  roleConfidence: number;
  hop: number;
  seed: boolean;
  /** Hub (fan-in) or plumbing: drawn as a leaf, never expanded through. */
  terminal: boolean;
  /** How many importers it has in the whole tree. */
  fanIn: number;
};

export type JudgedEdge = { from: string; to: string; names: string[]; at: string; carries: number; kind: FlowEdge["kind"]; via?: string[] };

export type JudgedBlock = FlowBlock & { score: number };

const rank = (role: FlowRole): number => FLOW_ROLE_ORDER.indexOf(role);

/** The workspace package a unit belongs to: the nearest ancestor holding a package.json, else its top-level directory. */
export function clusterOf(index: RepoIndex, path: string): string {
  for (let i = path.lastIndexOf("/"); i > 0; i = path.lastIndexOf("/", i - 1)) {
    const dir = path.slice(0, i);
    if (index.byPath.has(dir + "/package.json") || index.byPath.has(dir + "/pyproject.toml") || index.byPath.has(dir + "/go.mod") || index.byPath.has(dir + "/Cargo.toml")) return dir;
  }
  const top = path.split("/");
  return top.length > 1 ? top[0] : "";
}

/** Titles are basenames; a collision gets its parent folder in front. */
export function titles(paths: string[]): Map<string, string> {
  const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);
  const count = new Map<string, number>();
  for (const p of paths) count.set(base(p), (count.get(base(p)) ?? 0) + 1);
  return new Map(
    paths.map((p) => {
      if ((count.get(base(p)) ?? 0) < 2) return [p, base(p)];
      const parts = p.split("/");
      return [p, parts.slice(-2).join("/")];
    }),
  );
}

/**
 * Build the chart. `nodes` are every accepted unit (part ≥ F.MEMBER); the cap keeps seeds first,
 * then the surest. Edges are the judged references among drawn units; a handler's import of a
 * guard is drawn guard → handler (the guard runs first) when both roles are confident. A unit's
 * summary is the comment its per-unit Choice crowned; its evidence is that plus its strongest blocks.
 */
export function buildFlow(opts: {
  index: RepoIndex;
  topic: string;
  nodes: Judged[];
  edges: JudgedEdge[];
  blocks: Map<string, JudgedBlock[]>;
  /** Per unit, the comment the per-unit Choice crowned (already above SUMMARY_MIN). */
  summaries: Map<string, JudgedBlock>;
  hubs: string[];
}): FlowGraph {
  const { index, topic } = opts;
  const accepted = opts.nodes.filter((n) => n.part >= F.MEMBER);
  const ordered = [...accepted].sort((a, b) => Number(b.seed) - Number(a.seed) || b.part - a.part || (a.path < b.path ? -1 : 1));
  const drawn = ordered.slice(0, F.NODE_CAP);
  const drawnSet = new Set(drawn.map((n) => n.path));
  const title = titles(drawn.map((n) => n.path));
  const clusterId = new Map(drawn.map((n) => [n.path, clusterOf(index, n.path)]));

  // Edges among drawn units: keep the ones that carry the subject, or a unit's last edge.
  const among = opts.edges.filter((e) => drawnSet.has(e.from) && drawnSet.has(e.to) && e.from !== e.to);
  const degree = new Map<string, number>();
  for (const e of among) for (const p of [e.from, e.to]) degree.set(p, (degree.get(p) ?? 0) + 1);
  const kept = among.filter((e) => e.carries >= F.EDGE_MIN || degree.get(e.from) === 1 || degree.get(e.to) === 1);
  const byPath = new Map(drawn.map((n) => [n.path, n]));
  const flowEdges: FlowEdge[] = kept.map((e) => {
    const from = byPath.get(e.from)!;
    const to = byPath.get(e.to)!;
    // A handler imports the guard that wraps it; the flow runs guard → handler.
    const flip = e.kind === "import" && to.role === "guard" && from.role === "handler" && to.roleConfidence >= F.ROLE_MIN_CONFIDENCE && from.roleConfidence >= F.ROLE_MIN_CONFIDENCE;
    return { from: flip ? e.to : e.from, to: flip ? e.from : e.to, kind: e.kind, names: e.names, at: e.at, carries: e.carries, ...(e.via ? { via: e.via } : {}) };
  });
  const dropped = { nodes: accepted.length - drawn.length, edges: among.length - kept.length, hubs: opts.hubs.filter((h) => !drawnSet.has(h)) };
  const edgeCut = flowEdges.sort((a, b) => b.carries - a.carries).slice(0, F.EDGE_CAP);
  dropped.edges += flowEdges.length - edgeCut.length;

  // Reading order: role rank, then depth along forward references, then path.
  const forward = edgeCut.filter((e) => rank(byPath.get(e.from)!.role) <= rank(byPath.get(e.to)!.role));
  const depth = new Map<string, number>(drawn.map((n) => [n.path, 0]));
  for (let round = 0; round < drawn.length; round++) {
    let changed = false;
    for (const e of forward) {
      const d = depth.get(e.from)! + 1;
      if (d > depth.get(e.to)! && d < drawn.length) {
        depth.set(e.to, d);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const order = [...drawn].sort((a, b) => rank(a.role) - rank(b.role) || depth.get(a.path)! - depth.get(b.path)! || (a.path < b.path ? -1 : 1)).map((n) => n.path);
  const position = new Map(order.map((p, i) => [p, i]));
  for (const e of edgeCut) if (position.get(e.from)! > position.get(e.to)!) e.back = true;

  const nodes: FlowNode[] = drawn.map((n) => {
    const summary = opts.summaries.get(n.path);
    const strong = (opts.blocks.get(n.path) ?? []).filter((b) => b.score >= F.BLOCK_MIN && b !== summary).sort((a, b) => b.score - a.score);
    const evidence: FlowEvidence[] = [...(summary ? [summary] : []), ...strong]
      .slice(0, F.EVIDENCE_PER_UNIT)
      .sort((a, b) => a.line - b.line)
      .map((b) => ({ path: b.path, line: b.line, lines: b.text, kind: b.kind, score: b.score }));
    return {
      id: n.path,
      kind: "file",
      path: n.path,
      title: title.get(n.path)!,
      ...(summary ? { summary: summaryOf(summary) } : {}),
      role: n.role,
      roleConfidence: n.roleConfidence,
      part: n.part,
      cluster: clusterId.get(n.path)!,
      seed: n.seed,
      terminal: n.terminal,
      evidence,
    };
  });
  const clusterIds = [...new Set(nodes.map((n) => n.cluster))];
  const clusters = clusterIds
    .map((id) => ({ id, title: id || "(root)", nodes: order.filter((p) => clusterId.get(p) === id) }))
    .sort((a, b) => position.get(a.nodes[0])! - position.get(b.nodes[0])!);

  // Found = at least one unit TypeSafe is sure of, connected to something; partial = units but no story; absent = nothing.
  const sure = nodes.filter((n) => n.part >= F.EXPAND).length;
  const verdict: FlowGraph["verdict"] = sure >= 1 && edgeCut.length >= 1 ? "found" : nodes.length ? "partial" : "absent";
  return { topic, nodes: nodes.sort((a, b) => position.get(a.id)! - position.get(b.id)!), edges: edgeCut.sort((a, b) => Number(a.back ?? false) - Number(b.back ?? false) || position.get(a.from)! - position.get(b.from)! || position.get(a.to)! - position.get(b.to)!), clusters, order, dropped, verdict };
}

/** The chart's one line about a unit: the first sentence of its best explaining comment (never the "→" anchor code line). */
function summaryOf(block: JudgedBlock): string {
  return firstSentence(block.text.filter((l) => !l.startsWith("→ ")));
}
