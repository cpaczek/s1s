import type { Client } from "../client.ts";
import type { RepoIndex } from "../index/build.ts";
import type { NavEvent, ResultRow, SearchParams, SearchResult, SearchWarning } from "./events.ts";
import { T, USD_PER_M_INPUT_TOKENS, topicFromQuery, type Topic } from "../questions.ts";
import { newTally, walk, type Emit, type Tally } from "./walk.ts";
import { map, mapResults } from "./map.ts";
import { find } from "./find.ts";
import { verify } from "./verify.ts";

export function normalizeParams(p: Partial<SearchParams>): SearchParams {
  const strategy = p.strategy === "walk" || p.strategy === "map" ? p.strategy : "find";
  return {
    query: (p.query ?? "").trim(),
    strategy,
    scope: (p.scope ?? "").replace(/^\/+|\/+$/g, ""),
    beam: Math.min(10, Math.max(1, Math.floor(Number.isFinite(p.beam) ? p.beam! : T.BEAM))),
    maxDepth: Math.min(30, Math.max(1, Math.floor(Number.isFinite(p.maxDepth) ? p.maxDepth! : T.MAX_DEPTH))),
  };
}

export function verdictOf(top: number | undefined): SearchResult["verdict"] {
  const v = top ?? 0;
  return v >= T.FOUND ? "found" : v >= T.PARTIAL ? "partial" : "absent";
}

type One = { results: ResultRow[]; heat: Map<string, number>; visited: string[]; separation?: number; verdict: SearchResult["verdict"]; truncated?: number; warnings?: SearchWarning[] };

/** Map mode: the heat map IS the answer; every unit ≥ PARTIAL is a result. */
export async function runMap(opts: { client: Client; index: RepoIndex; params: SearchParams; topic: Topic; emit: Emit; tally: Tally }): Promise<One> {
  const { client, index, params, topic, emit, tally } = opts;
  const m = await map({ client, index, topic, scope: params.scope, emit, tally });
  return { results: mapResults(m.scored), heat: m.heat, visited: m.visited, verdict: verdictOf(m.scored[0]?.noul), truncated: m.truncated };
}

/** One unit is wanted: `find` (lexical pool → shortlist → verify → walk if needed), or a bare descent (walk) → verify. */
async function runFind(opts: { client: Client; index: RepoIndex; params: SearchParams; emit: Emit; tally: Tally }): Promise<One> {
  const { client, index, params, emit, tally } = opts;
  const base = { client, index, query: params.query, scope: params.scope, emit, tally };

  if (params.strategy === "find") {
    const f = await find({ ...base, beam: params.beam, maxDepth: params.maxDepth });
    return { results: f.results, heat: f.heat, visited: f.visited, separation: f.separation, verdict: verdictOf(f.results[0]?.verify), warnings: f.warnings };
  }

  const w = await walk({ ...base, beam: params.beam, maxDepth: params.maxDepth });
  const candidates = w.finished.slice(0, T.VERIFY_TOP).map((c) => ({ path: c.path, via: "walk" as const, pathScore: c.score }));
  const results = await verify({ client, index, query: params.query, candidates, emit, tally });
  const heat = new Map(w.heat);
  for (const r of results) if (r.verify !== undefined) heat.set(r.path, r.verify);
  return { results, heat, visited: w.visited, separation: w.separation, verdict: verdictOf(results[0]?.verify) };
}

export async function runSearch(opts: { client: Client; index: RepoIndex; params: SearchParams; emit: Emit }): Promise<SearchResult> {
  const { client, index, params, emit } = opts;
  if (!params.query) throw new Error("query is empty");
  const t0 = performance.now();
  const tally = newTally();
  emit({ type: "start", params, at: Date.now() });

  const mode: SearchResult["mode"] = params.strategy === "map" ? "map" : "find";
  const topic = topicFromQuery(params.query);
  const one = mode === "map" ? await runMap({ client, index, params, topic, emit, tally }) : await runFind({ client, index, params, emit, tally });

  const result: SearchResult = {
    params,
    results: one.results,
    heat: Object.fromEntries(one.heat),
    visited: one.visited,
    stats: {
      calls: tally.calls,
      inputTokens: tally.inputTokens,
      outputTokens: tally.outputTokens,
      apiMs: Math.round(tally.apiMs),
      wallMs: Math.round(performance.now() - t0),
      estCostUsd: (tally.inputTokens / 1e6) * USD_PER_M_INPUT_TOKENS,
      model: tally.model,
    },
    separation: one.separation,
    verdict: one.verdict,
    mode,
    topic: mode === "map" ? topic : undefined,
    truncated: one.truncated,
    ...(one.warnings?.length ? { warnings: one.warnings } : {}),
  };
  emit({ type: "done", result });
  return result;
}

export type { NavEvent };
