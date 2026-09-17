import type { Client } from "../client.ts";
import { graphOf, type RepoIndex } from "../index/build.ts";
import { parseQuery, type QueryTerm } from "../index/lex.ts";
import { fanIn, type CodeGraph, type GraphEdge } from "../graph/build.ts";
import type { ChoiceAnswer, NoulAnswer, Question, Structured } from "../types.ts";
import type { NavEvent } from "../nav/events.ts";
import { map } from "../nav/map.ts";
import type { Emit, Tally } from "../nav/walk.ts";
import { F, NONE, REPO_DOMAIN, bestBlockQuestion, blockQuestion, blockState, describeOption, edgeQuestion, edgeState, flowQuestions, flowState, topicFromQuestion, type FlowBlock, type FlowCandidate, type FlowEdgeEvidence, type Topic } from "../questions.ts";
import { blocksOf } from "./blocks.ts";
import { buildFlow, clusterOf, type Judged, type JudgedBlock, type JudgedEdge } from "./build.ts";
import { FLOW_ROLE_ORDER, type FlowGraph, type FlowRole } from "./types.ts";

/**
 * EXPLAIN — "how does X work?" answered from the tree itself.
 *
 *   1. gather    map: every unit the subject lives in (lexical prefilter → membership Nouls); the
 *                surest become seeds.
 *   2. expand    breadth-first over the import graph from the seeds. Each reached unit is judged in
 *                one round trip — is it a step of the subject (`part`), is it plumbing, which role —
 *                with the real reference that led there in the state. Hubs and plumbing are kept
 *                as leaves, never expanded through.
 *   3. evidence  the line-by-line search inside every drawn unit: its comment blocks and the code
 *                windows around the subject's words, each judged — does it explain / carry out a
 *                step? The best become the unit's evidence; the best comment's first sentence is
 *                its summary.
 *   4. edges     every real reference between drawn units, judged: does it carry the subject's work?
 *   5. build     code: titles, clusters, direction, order, caps → FlowGraph.
 */
export type ExplainOutcome = { graph: FlowGraph; heat: Map<string, number>; terms: QueryTerm[]; members: number; judged: number; blocks: number };

const TEST_PATH = /(^|\/)(test|tests|__tests__|e2e|spec|fixtures?|mocks?|stories)(\/|$)|\.(test|spec|stories)\.[a-z]+$/;
/** Prose is read for evidence, never drawn: a flow is made of the units that run. */
const PROSE = /\.(md|mdx|txt|rst|adoc)$/i;

function record(tally: Tally, res: { usage: { input_tokens: number; output_tokens: number }; latencyMs: number; model: string }): number {
  tally.calls++;
  tally.inputTokens += res.usage.input_tokens;
  tally.outputTokens += res.usage.output_tokens;
  tally.apiMs += res.latencyMs;
  tally.model = res.model;
  return res.usage.input_tokens + res.usage.output_tokens;
}

/** A hub is a unit far more imported than its tree's norm: the fan-in at F.HUB_PERCENTILE among units that have importers, never below F.HUB_FAN_IN_MIN. */
export function hubFanIn(graph: CodeGraph): number {
  const cached = hubCache.get(graph);
  if (cached !== undefined) return cached;
  const fans = [...graph.in.values()].map((edges) => edges.length).filter((n) => n > 0).sort((a, b) => a - b);
  const at = fans.length ? fans[Math.min(fans.length - 1, Math.floor(fans.length * F.HUB_PERCENTILE))] : 0;
  const threshold = Math.max(F.HUB_FAN_IN_MIN, at);
  hubCache.set(graph, threshold);
  return threshold;
}
const hubCache = new WeakMap<CodeGraph, number>();

/** Does a source line use one of the imported names? Namespace and default imports carry no name to look for. */
function usesName(line: string, names: string[]): boolean {
  return names.some((name) => /^[A-Za-z_$][\w$]*$/.test(name) && name !== "default" && new RegExp(`(?<![\\w$])${name.replace(/\$/g, "\\$")}(?![\\w$])`).test(line));
}

const chunks = <A>(items: A[], size: number): A[][] => {
  const out: A[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

export async function explain(opts: { client: Client; index: RepoIndex; question: string; scope: string; depth?: number; tests?: boolean; emit: Emit; tally: Tally }): Promise<ExplainOutcome> {
  const { client, index, question, scope, emit, tally } = opts;
  const domain = index.domain ?? REPO_DOMAIN;
  const depth = opts.depth ?? F.DEPTH;
  const topic: Topic = topicFromQuestion(question);
  const graph = graphOf(index);
  const lineOf = (path: string, line: number): string => (index.text(path) ?? "").split("\n")[line - 1]?.trim().slice(0, F.LINE_WIDTH) ?? "";
  const skip = (path: string): boolean => !index.byPath.has(path) || PROSE.test(path) || (!opts.tests && TEST_PATH.test(path));
  const startCalls = tally.calls;

  // 1. Gather.
  const m = await map({ client, index, topic, scope, emit, tally });
  const heat = new Map(m.heat);
  const members = m.scored.filter((s) => s.noul >= F.MEMBER && !skip(s.path));
  const perCluster = new Map<string, number>();
  const seeds: string[] = [];
  for (const s of members) {
    if (s.noul < F.EXPAND || seeds.length >= F.SEED_MAX) break;
    const c = clusterOf(index, s.path);
    if ((perCluster.get(c) ?? 0) >= F.SEEDS_PER_CLUSTER) continue;
    perCluster.set(c, (perCluster.get(c) ?? 0) + 1);
    seeds.push(s.path);
  }
  emit({ type: "explain_seeds", members: members.slice(0, 40).map((s) => ({ path: s.path, noul: s.noul })), seeds, truncated: m.truncated });

  // 2. Expand.
  const judged = new Map<string, Judged>();
  const reachedVia = new Map<string, FlowCandidate["reached"]>();
  const hubs: string[] = [];
  const isHub = (path: string) => fanIn(graph, path) > hubFanIn(graph);
  let frontier = seeds.filter((p) => !skip(p));
  for (let hop = 0; hop <= depth && frontier.length && tally.calls - startCalls < F.MAX_CALLS; hop++) {
    const candidates: FlowCandidate[] = frontier.map((path) => ({ path, descriptor: describeOption(index.byPath.get(path)!, domain), reached: reachedVia.get(path) }));
    const accepted = [...judged.values()].filter((j) => j.part >= F.MEMBER).map((j) => j.path);
    const rows: Judged[] = [];
    let latencyMs = 0;
    let tokens = 0;
    await Promise.all(
      chunks(candidates, F.CANDIDATES_PER_CALL).map(async (batch) => {
        const res = await client(flowState(topic, batch, accepted), flowQuestions(batch.length));
        tokens += record(tally, res);
        latencyMs = Math.max(latencyMs, res.latencyMs);
        batch.forEach((c, i) => {
          const part = (res.answers[`part_${i}`] as NoulAnswer | undefined)?.noul ?? 0;
          const plumbing = (res.answers[`plumbing_${i}`] as NoulAnswer | undefined)?.noul ?? 0;
          const role = res.answers[`role_${i}`] as ChoiceAnswer | undefined;
          const chosen = (role?.choice ?? "service") as FlowRole;
          const hub = isHub(c.path);
          if (hub && !hubs.includes(c.path)) hubs.push(c.path);
          rows.push({ path: c.path, part, plumbing, role: FLOW_ROLE_ORDER.includes(chosen) ? chosen : "service", roleConfidence: role?.confidence ?? 0, hop, seed: hop === 0, terminal: hub || plumbing >= F.PLUMBING, fanIn: fanIn(graph, c.path) });
        });
      }),
    );
    for (const r of rows) {
      judged.set(r.path, r);
      heat.set(r.path, Math.max(heat.get(r.path) ?? 0, r.part));
    }
    // The next frontier: neighbours of what was accepted AND is worth expanding through.
    const expandable = rows.filter((r) => r.part >= F.EXPAND && !r.terminal);
    const next = new Map<string, FlowCandidate["reached"]>();
    for (const r of expandable) {
      const edges: Array<{ e: GraphEdge; relation: "imports" | "imported_by"; other: string }> = [
        ...(graph.out.get(r.path) ?? []).map((e) => ({ e, relation: "imports" as const, other: e.to })),
        ...(graph.in.get(r.path) ?? []).map((e) => ({ e, relation: "imported_by" as const, other: e.from })),
      ];
      // Prefer the references that carry names, and the less-imported units (a hub says little).
      edges.sort((a, b) => b.e.names.length - a.e.names.length || fanIn(graph, a.other) - fanIn(graph, b.other));
      let taken = 0;
      for (const { e, relation, other } of edges) {
        if (e.typeOnly || judged.has(other) || skip(other) || next.has(other)) continue;
        if (taken++ >= F.FAN_OUT_CAP) break;
        next.set(other, { from: r.path, relation, at: `${e.from}:${e.line}`, line: lineOf(e.from, e.line), names: e.names });
      }
    }
    emit({ type: "explain_hop", hop, judged: rows.map((r) => ({ path: r.path, part: r.part, plumbing: r.plumbing, role: r.role, roleConfidence: r.roleConfidence, reachedFrom: reachedVia.get(r.path)?.from })), expanded: expandable.map((r) => r.path), next: next.size, latencyMs, tokens });
    for (const [path, via] of next) reachedVia.set(path, via);
    frontier = [...next.keys()];
  }

  // 3. Evidence: the line-by-line search inside the units that will be drawn.
  const drawn = [...judged.values()].filter((j) => j.part >= F.MEMBER).sort((a, b) => Number(b.seed) - Number(a.seed) || b.part - a.part).slice(0, F.NODE_CAP);
  const terms = parseQuery(index.lex, topic.name, m.terms.filter((t) => t.weight < 1).map((t) => ({ term: t.label, weight: t.weight })));
  // A unit's blocks travel together, so the per-unit Choice ("which comment says it best?") sees them all.
  const perUnit = drawn.map((j) => blocksOf(j.path, index.text(j.path) ?? "", terms)).filter((b) => b.length);
  const batches: FlowBlock[][] = [[]];
  for (const unit of perUnit) {
    if (batches[batches.length - 1].length + unit.length > F.BLOCKS_PER_CALL && batches[batches.length - 1].length) batches.push([]);
    batches[batches.length - 1].push(...unit);
  }
  const blocks = new Map<string, JudgedBlock[]>();
  const summaries = new Map<string, JudgedBlock>();
  let blocksKept = 0;
  await Promise.all(
    batches.filter((b) => b.length).map(async (batch) => {
      const questions: Record<string, Question> = {};
      batch.forEach((b, i) => (questions[`block_${i}`] = blockQuestion(i, b.kind)));
      const units = [...new Set(batch.map((b) => b.path))];
      units.forEach((path, u) => {
        const comments = batch.map((b, i) => (b.path === path && b.kind === "comment" ? i : -1)).filter((i) => i >= 0);
        if (comments.length) questions[`best_${u}`] = bestBlockQuestion(comments);
      });
      const res = await client(blockState(topic, batch), questions);
      const tokens = record(tally, res);
      const rows = batch.map((b, i) => ({ ...b, score: (res.answers[`block_${i}`] as NoulAnswer | undefined)?.noul ?? 0 }));
      for (const r of rows) {
        blocks.set(r.path, [...(blocks.get(r.path) ?? []), r]);
        if (r.score >= F.BLOCK_MIN) blocksKept++;
      }
      units.forEach((path, u) => {
        const best = res.answers[`best_${u}`] as ChoiceAnswer | undefined;
        const i = best && best.choice !== NONE ? Number(best.choice.slice(1)) : -1;
        if (i >= 0 && rows[i] && rows[i].score >= F.SUMMARY_MIN) summaries.set(path, rows[i]);
      });
      emit({ type: "explain_evidence", judged: rows.length, kept: rows.filter((r) => r.score >= F.BLOCK_MIN).length, top: rows.filter((r) => r.score >= F.BLOCK_MIN).sort((a, b) => b.score - a.score).slice(0, 5).map((r) => ({ path: r.path, line: r.line, kind: r.kind, score: r.score, text: r.text[0] })), latencyMs: res.latencyMs, tokens });
    }),
  );

  // 4. Edges: every real reference between drawn units, with the lines that use it.
  const drawnSet = new Set(drawn.map((j) => j.path));
  const evidence: FlowEdgeEvidence[] = [];
  for (const j of drawn) {
    for (const e of graph.out.get(j.path) ?? []) {
      if (!drawnSet.has(e.to) || e.typeOnly || e.to === j.path) continue;
      const text = (index.text(e.from) ?? "").split("\n");
      const uses = e.names.length
        ? text.map((l, i) => ({ l: l.trim(), n: i + 1 })).filter(({ l, n }) => n !== e.line && l.length <= 400 && usesName(l, e.names)).slice(0, 2)
        : [];
      evidence.push({ from: e.from, to: e.to, names: e.names, at: `${e.from}:${e.line}`, lines: [lineOf(e.from, e.line), ...uses.map((u) => `${u.n}: ${u.l.slice(0, F.LINE_WIDTH)}`)].filter(Boolean) });
    }
    // A comment that names another drawn unit is a reference too (cross-process hops have no import) —
    // only for names that are unique among the drawn units, so "index.ts" never points at two places.
    const about = index.facts.get(j.path)?.about ?? "";
    for (const other of drawn) {
      const base = other.path.slice(other.path.lastIndexOf("/") + 1);
      if (other.path === j.path || base.length < 8 || !about.includes(base) || drawn.filter((d) => d.path.endsWith("/" + base)).length > 1) continue;
      if (evidence.some((x) => x.from === j.path && x.to === other.path)) continue;
      evidence.push({ from: j.path, to: other.path, names: [], at: `${j.path}:1`, lines: [about.slice(0, F.LINE_WIDTH)] });
    }
  }
  const judgedEdges: JudgedEdge[] = [];
  await Promise.all(
    chunks(evidence, F.EDGES_PER_CALL).map(async (batch) => {
      const questions: Record<string, Question> = {};
      batch.forEach((_, i) => (questions[`carries_${i}`] = edgeQuestion(i)));
      const res = await client(edgeState(topic, batch), questions);
      const tokens = record(tally, res);
      batch.forEach((e, i) => judgedEdges.push({ from: e.from, to: e.to, names: e.names, at: e.at, carries: (res.answers[`carries_${i}`] as NoulAnswer | undefined)?.noul ?? 0, kind: e.names.length || !e.at.endsWith(":1") ? "import" : "mention" }));
      emit({ type: "explain_edges", judged: batch.length, kept: judgedEdges.filter((e) => e.carries >= F.EDGE_MIN).length, latencyMs: res.latencyMs, tokens });
    }),
  );

  // 5. Build.
  const graphOut = buildFlow({ index, topic: topic.name, nodes: [...judged.values()], edges: judgedEdges, blocks, summaries, hubs });
  return { graph: graphOut, heat, terms, members: members.length, judged: judged.size, blocks: blocksKept };
}

export type { NavEvent, Structured };
