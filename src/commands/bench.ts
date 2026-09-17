import { defineCommand } from "citty";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { createClient } from "../client.ts";
import { STRATEGIES, type NavEvent, type SearchResult, type Strategy } from "../nav/events.ts";
import { attributeLoss, type Loss } from "../nav/attribution.ts";
import { normalizeParams, runSearch } from "../nav/search.ts";
import { loadTree, treeArgs } from "./common.ts";

export type GoldRow = { id: string; query: string; accept: string[]; scope?: string; note?: string };

export type BenchRow = {
  id: string;
  strategy: Strategy;
  hit1: boolean;
  hitK: boolean;
  top: string | undefined;
  /** Every candidate path the search returned, best first (lets results be re-scored offline). */
  topK?: string[];
  topVerify: number | undefined;
  verdict: SearchResult["verdict"];
  calls: number;
  inputTokens: number;
  apiMs: number;
  wallMs: number;
  /** Where the accepted unit was lost (absent gold rows have none). */
  loss?: Loss;
  error?: string;
};

export function scoreRow(id: string, strategy: Strategy, gold: GoldRow, r: SearchResult, events: NavEvent[] = []): BenchRow {
  const top = r.results[0]?.path;
  // An "absent" gold row (empty accept list) is a hit when the verdict says absent.
  const absentOk = gold.accept.length === 0 && r.verdict === "absent";
  return {
    id,
    strategy,
    hit1: absentOk || (top !== undefined && gold.accept.includes(top)),
    hitK: absentOk || r.results.some((x) => gold.accept.includes(x.path)),
    top,
    topK: r.results.map((x) => x.path),
    topVerify: r.results[0]?.verify,
    verdict: r.verdict,
    calls: r.stats.calls,
    inputTokens: r.stats.inputTokens,
    apiMs: r.stats.apiMs,
    wallMs: r.stats.wallMs,
    loss: attributeLoss(events, r, gold.accept),
  };
}

/** "first_hop @/ p=3% #4" — where a missed row lost the accepted unit. */
export function lossLabel(l: Loss | undefined): string {
  if (!l || l.stage === "hit") return "";
  const where = l.at !== undefined ? ` @${l.at || "/"} p=${Math.round((l.childP ?? 0) * 100)}% #${l.childRank}` : "";
  const v = l.verify !== undefined ? ` v=${l.verify.toFixed(2)}` : "";
  return `lost: ${l.stage}${where}${v}`;
}

export function summarize(rows: BenchRow[]) {
  const by = new Map<Strategy, BenchRow[]>();
  for (const r of rows) by.set(r.strategy, [...(by.get(r.strategy) ?? []), r]);
  const p50 = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0);
  return [...by.entries()].map(([strategy, rs]) => ({
    strategy,
    n: rs.length,
    hit1: rs.filter((r) => r.hit1).length / rs.length,
    hitK: rs.filter((r) => r.hitK).length / rs.length,
    errors: rs.filter((r) => r.error).length,
    callsMean: rs.reduce((a, r) => a + r.calls, 0) / rs.length,
    inputTokensMean: Math.round(rs.reduce((a, r) => a + r.inputTokens, 0) / rs.length),
    wallP50: p50(rs.map((r) => r.wallMs)),
    /** Loss stage → how many rows ended there (rows with a known answer only). */
    lostAt: rs.reduce<Record<string, number>>((acc, r) => (r.loss ? { ...acc, [r.loss.stage]: (acc[r.loss.stage] ?? 0) + 1 } : acc), {}),
  }));
}

export const bench = defineCommand({
  meta: { name: "bench", description: "Run the gold queries through each strategy and report hit@1 / hit@K" },
  args: {
    ...treeArgs,
    gold: { type: "string", description: "Gold JSON file", default: resolve(import.meta.dirname, "../../bench/public/ripgrep.json") },
    strategy: { type: "string", description: "find | walk | all (comma-separated ok)", default: "all" },
    out: { type: "string", description: "Results JSON path (default: results[-<gold name>].json beside the gold file)", default: "" },
    only: { type: "string", description: "Comma-separated gold ids to run", default: "" },
  },
  async run({ args }) {
    const gold = JSON.parse(readFileSync(args.gold, "utf8")) as GoldRow[];
    const ids = args.only ? new Set(args.only.split(",")) : undefined;
    // "all" = every strategy that finds ONE unit; map answers a different question (no hit@1).
    const strategies: Strategy[] = args.strategy === "all" ? STRATEGIES.filter((s) => s !== "map") : (args.strategy.split(",") as Strategy[]);
    const index = loadTree(args);
    const client = createClient({ concurrency: 6 });
    const rows: BenchRow[] = [];
    for (const strategy of strategies) {
      for (const g of gold) {
        if (ids && !ids.has(g.id)) continue;
        const params = normalizeParams({ query: g.query, strategy, scope: g.scope ?? "" });
        try {
          // Only these matter to loss attribution; a battery batch's heat payload is large.
          const events: NavEvent[] = [];
          const kept = new Set<NavEvent["type"]>(["expand", "lexical", "shortlist", "terms", "escalate"]);
          const r = await runSearch({ client, index, params, emit: (e) => void (kept.has(e.type) && events.push(e)) });
          const row = scoreRow(g.id, strategy, g, r, events);
          rows.push(row);
          console.log(`${strategy.padEnd(7)} ${row.hit1 ? "✓" : row.hitK ? "~" : "✗"} ${g.id.padEnd(28)} → ${row.top ?? "(none)"}  verify ${row.topVerify?.toFixed(2) ?? "–"}  ${row.calls} calls ${row.wallMs}ms${row.hit1 ? "" : `  ${lossLabel(row.loss)}`}`);
        } catch (err) {
          rows.push({ id: g.id, strategy, hit1: false, hitK: false, top: undefined, topVerify: undefined, verdict: "absent", calls: 0, inputTokens: 0, apiMs: 0, wallMs: 0, error: (err as Error).message });
          console.log(`${strategy.padEnd(7)} ! ${g.id.padEnd(28)} ERROR ${(err as Error).message}`);
        }
      }
    }
    const summary = summarize(rows);
    console.log("\nstrategy  n   hit@1  hit@K  calls  in-tokens  wall p50");
    for (const s of summary) {
      console.log(`${s.strategy.padEnd(9)} ${String(s.n).padEnd(3)} ${(s.hit1 * 100).toFixed(0).padStart(4)}%  ${(s.hitK * 100).toFixed(0).padStart(4)}%  ${s.callsMean.toFixed(1).padStart(5)}  ${String(s.inputTokensMean).padStart(9)}  ${String(s.wallP50).padStart(6)}ms`);
    }
    console.log("\nwhere the accepted unit was lost:");
    for (const s of summary) console.log(`${s.strategy.padEnd(9)} ${Object.entries(s.lostAt).map(([k, n]) => `${k} ${n}`).join(" · ") || "–"}`);
    const goldName = basename(args.gold).replace(/(-gold)?\.json$/, "");
    const out = args.out || resolve(dirname(args.gold), goldName === "gold" ? "results.json" : `results-${goldName}.json`);
    writeFileSync(out, JSON.stringify({ ranAt: new Date().toISOString(), rows, summary }, null, 2));
    console.log(`\nwrote ${out}`);
  },
});
