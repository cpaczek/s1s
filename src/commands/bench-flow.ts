import { defineCommand } from "citty";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { createClient } from "../client.ts";
import { graphOf } from "../index/build.ts";
import type { FlowGraph } from "../flow/types.ts";
import { F } from "../questions.ts";
import { loadTree, treeArgs } from "./common.ts";
import { runExplain } from "../flow/run.ts";

/** One explain question with what its chart must, should and must not contain. */
export type FlowGoldRow = { id: string; question: string; depth?: number; must: string[]; should: string[]; mustNot: string[]; mustEdges: Array<[string, string]>; note?: string };

export type FlowBenchRow = {
  id: string;
  run: number;
  verdict: FlowGraph["verdict"];
  nodes: number;
  edges: number;
  /** Fractions recalled / hit. */
  must: number;
  should: number;
  mustNot: number;
  mustEdges: number;
  /** Non-mention/non-via edges absent from the reference graph; expected to be 0. */
  invented: number;
  /** Drawn units with a summary. */
  summaries: number;
  calls: number;
  inputTokens: number;
  wallMs: number;
  missingMust: string[];
  hitMustNot: string[];
  error?: string;
};

/** Scores one chart against gold. `real` checks references in either direction; mention/via edges are excluded from the invented-edge count. */
export function scoreFlow(id: string, run: number, gold: FlowGoldRow, g: FlowGraph, real: (from: string, to: string) => boolean, stats: { calls: number; inputTokens: number; wallMs: number }): FlowBenchRow {
  const drawn = new Set(g.nodes.map((n) => n.id));
  const has = (p: string) => drawn.has(p);
  const edge = (a: string, b: string) => g.edges.some((e) => (e.from === a && e.to === b) || (e.from === b && e.to === a));
  const frac = (xs: string[], f: (x: string) => boolean) => (xs.length ? xs.filter(f).length / xs.length : 1);
  return {
    id,
    run,
    verdict: g.verdict,
    nodes: g.nodes.length,
    edges: g.edges.length,
    must: frac(gold.must, has),
    should: frac(gold.should, has),
    mustNot: gold.mustNot.length ? gold.mustNot.filter(has).length / gold.mustNot.length : 0,
    mustEdges: gold.mustEdges.length ? gold.mustEdges.filter(([a, b]) => edge(a, b)).length / gold.mustEdges.length : 1,
    invented: g.edges.filter((e) => e.kind !== "mention" && e.kind !== "via" && !real(e.from, e.to)).length,
    summaries: g.nodes.filter((n) => n.summary).length,
    calls: stats.calls,
    inputTokens: stats.inputTokens,
    wallMs: stats.wallMs,
    missingMust: gold.must.filter((p) => !has(p)),
    hitMustNot: gold.mustNot.filter(has),
  };
}

/** Node-set agreement between runs of the same question. */
export function jaccard(a: Iterable<string>, b: Iterable<string>): number {
  const A = new Set(a);
  const B = new Set(b);
  const both = [...A].filter((x) => B.has(x)).length;
  const all = A.size + B.size - both;
  return all ? both / all : 1;
}

export const benchFlow = defineCommand({
  meta: { name: "bench-flow", description: "Run the explain questions and score their charts: must / should / must-not units, must edges, invented edges, run-to-run agreement" },
  args: {
    ...treeArgs,
    gold: { type: "string", description: "Flow gold JSON", default: resolve(import.meta.dirname, "../../bench/public/flow-ripgrep.json") },
    runs: { type: "string", description: "Runs per question (agreement needs ≥ 2)", default: "2" },
    only: { type: "string", description: "Comma-separated ids", default: "" },
    out: { type: "string", description: "Results JSON path", default: "" },
  },
  async run({ args }) {
    const gold = JSON.parse(readFileSync(args.gold, "utf8")) as FlowGoldRow[];
    const ids = args.only ? new Set(args.only.split(",")) : undefined;
    const runs = Math.max(1, Number(args.runs) || 2);
    const index = loadTree(args);
    const graph = graphOf(index);
    const real = (a: string, b: string) => (graph.out.get(a) ?? []).some((e) => e.to === b) || (graph.out.get(b) ?? []).some((e) => e.to === a);
    const client = createClient({ concurrency: 6 });
    const rows: FlowBenchRow[] = [];
    const agreement: Record<string, number[]> = {};
    for (const g of gold) {
      if (ids && !ids.has(g.id)) continue;
      const sets: string[][] = [];
      for (let run = 1; run <= runs; run++) {
        try {
          const r = await runExplain({ client, index, params: { question: g.question, scope: "", depth: g.depth ?? F.DEPTH, tests: false }, emit: () => {} });
          const row = scoreFlow(g.id, run, g, r.graph, real, r.stats);
          rows.push(row);
          sets.push(r.graph.nodes.map((n) => n.id));
          console.log(`${g.id.padEnd(16)} run ${run}: ${row.verdict.padEnd(7)} ${String(row.nodes).padStart(2)} units ${String(row.edges).padStart(2)} refs · must ${pct(row.must)} should ${pct(row.should)} must-not ${pct(row.mustNot)} must-edges ${pct(row.mustEdges)} invented ${row.invented} · ${row.calls} calls ${row.wallMs}ms${row.missingMust.length ? `  missing: ${row.missingMust.map((p) => p.split("/").pop()).join(", ")}` : ""}${row.hitMustNot.length ? `  MUST-NOT: ${row.hitMustNot.map((p) => p.split("/").pop()).join(", ")}` : ""}`);
        } catch (err) {
          rows.push({ id: g.id, run, verdict: "absent", nodes: 0, edges: 0, must: 0, should: 0, mustNot: 0, mustEdges: 0, invented: 0, summaries: 0, calls: 0, inputTokens: 0, wallMs: 0, missingMust: g.must, hitMustNot: [], error: (err as Error).message });
          console.log(`${g.id.padEnd(16)} run ${run}: ERROR ${(err as Error).message}`);
        }
      }
      agreement[g.id] = [];
      for (let i = 0; i < sets.length; i++) for (let j = i + 1; j < sets.length; j++) agreement[g.id].push(jaccard(sets[i], sets[j]));
    }
    const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
    console.log("\nid                must   should must-not must-edges invented summaries  calls  tokens   wall   agreement");
    for (const g of gold) {
      const rs = rows.filter((r) => r.id === g.id && !r.error);
      if (!rs.length) continue;
      console.log(`${g.id.padEnd(16)} ${pct(mean(rs.map((r) => r.must)))}  ${pct(mean(rs.map((r) => r.should)))}   ${pct(mean(rs.map((r) => r.mustNot)))}     ${pct(mean(rs.map((r) => r.mustEdges)))}      ${mean(rs.map((r) => r.invented)).toFixed(1)}      ${mean(rs.map((r) => r.summaries / Math.max(1, r.nodes))).toFixed(2)}   ${mean(rs.map((r) => r.calls)).toFixed(1)}  ${Math.round(mean(rs.map((r) => r.inputTokens))).toString().padStart(7)}  ${Math.round(mean(rs.map((r) => r.wallMs))).toString().padStart(5)}ms  ${agreement[g.id]?.length ? mean(agreement[g.id]).toFixed(2) : "–"}`);
    }
    const out = args.out || resolve(dirname(args.gold), `results-${basename(args.gold).replace(/(-gold)?\.json$/, "")}.json`);
    writeFileSync(out, JSON.stringify({ ranAt: new Date().toISOString(), rows, agreement }, null, 2));
    console.log(`\nwrote ${out}`);
  },
});

const pct = (x: number) => `${Math.round(x * 100)}%`.padStart(4);
