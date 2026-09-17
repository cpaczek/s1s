import type { Client } from "../client.ts";
import type { RepoIndex } from "../index/build.ts";
import type { ExplainResult, NavEvent } from "../nav/events.ts";
import { newTally } from "../nav/walk.ts";
import { explain } from "./explain.ts";
import { USD_PER_M_INPUT_TOKENS } from "../questions.ts";

export async function runExplain(opts: { client: Client; index: RepoIndex; params: ExplainResult["params"]; emit: (e: NavEvent) => void }): Promise<ExplainResult> {
  const t0 = performance.now();
  const tally = newTally();
  const out = await explain({ client: opts.client, index: opts.index, question: opts.params.question, scope: opts.params.scope, depth: opts.params.depth, tests: opts.params.tests, emit: opts.emit, tally });
  const result: ExplainResult = {
    params: opts.params,
    graph: out.graph,
    heat: Object.fromEntries(out.heat),
    stats: { calls: tally.calls, inputTokens: tally.inputTokens, outputTokens: tally.outputTokens, apiMs: Math.round(tally.apiMs), wallMs: Math.round(performance.now() - t0), estCostUsd: (tally.inputTokens / 1e6) * USD_PER_M_INPUT_TOKENS, model: tally.model, members: out.members, judged: out.judged, blocks: out.blocks },
  };
  opts.emit({ type: "explain_done", result });
  return result;
}
