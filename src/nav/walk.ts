import type { Client } from "../client.ts";
import type { RepoIndex, TreeNode } from "../index/build.ts";
import type { ChoiceAnswer, NoulAnswer, Structured } from "../types.ts";
import type { BeamEntry, NavEvent, OptionSeen } from "./events.ts";
import { NONE, REPO_DOMAIN, T, describeOption, walkQuestions, walkState, type Domain } from "../questions.ts";
import { settleAll } from "./settle.ts";
import { optionBudget } from "../index/signature.ts";

export type Emit = (e: NavEvent) => void;

/** Running totals across every call of one search. */
export type Tally = { calls: number; inputTokens: number; outputTokens: number; apiMs: number; model: string };

export function newTally(): Tally {
  return { calls: 0, inputTokens: 0, outputTokens: 0, apiMs: 0, model: "" };
}

export type Cand = {
  path: string;
  kind: "dir" | "file";
  /** Product of edge probabilities from the scope root. */
  probProduct: number;
  decisions: number;
  /** Geometric mean of the edge probabilities — length-normalised path score. */
  score: number;
  finished: boolean;
  /** The edge probability that produced this candidate. */
  edgeP: number;
};

export type WalkOutcome = {
  /** Every file ever reached, best score first. */
  finished: Cand[];
  heat: Map<string, number>;
  visited: string[];
  separation?: number;
  beam: Cand[];
};

/** Max options in one Choice (the API ceiling is 255 including `none`). */
const CHOICE_CAP = 254;
/** Prune events per step, so the trace stays readable. */
const PRUNE_EVENTS_CAP = 5;

export function extend(parent: Cand, node: TreeNode, p: number): Cand {
  const decisions = parent.decisions + 1;
  const probProduct = parent.probProduct * p;
  return {
    path: node.path,
    kind: node.kind,
    probProduct,
    decisions,
    score: probProduct > 0 ? Math.exp(Math.log(probProduct) / decisions) : 0,
    finished: node.kind === "file",
    edgeP: p,
  };
}

/** True when the new leader is not the old leader nor one of its descendants. */
export function isBacktrack(prev: Cand | undefined, next: Cand | undefined): boolean {
  if (!prev || !next) return false;
  if (next.path === prev.path) return false;
  if (prev.kind === "dir" && (prev.path === "" || next.path.startsWith(prev.path + "/"))) return false;
  return true;
}

export type AskResult = {
  /** option name → probability (includes `__none__`). */
  probs: Record<string, number>;
  underHere: number;
  confidence: number;
  latencyMs: number;
  tokens: number;
  /** The options as the UI sees them, best first, `__none__` included. */
  seen: OptionSeen[];
};

/**
 * One expansion: a Choice over `kids` (the children of `node`, possibly minus exclusions)
 * plus the "is the target under here" Noul. Chunks at the 255-option ceiling.
 */
export async function askChildren(
  client: Client,
  query: Structured,
  node: TreeNode,
  kids: TreeNode[],
  tally: Tally,
  domain: Domain = REPO_DOMAIN,
): Promise<AskResult> {
  const state = walkState(query, node.path, kids.map((k) => (k.kind === "dir" ? k.name + "/" : k.name)), node.themes ?? []);
  const chunks: TreeNode[][] = [];
  for (let i = 0; i < kids.length; i += CHOICE_CAP) chunks.push(kids.slice(i, i + CHOICE_CAP));
  if (chunks.length === 0) chunks.push([]);

  const probs: Record<string, number> = {};
  let underHere = 0;
  let confidence = 0;
  let latencyMs = 0;
  let tokens = 0;
  const responses = await settleAll(
    chunks.map(async (chunk) => {
      const options: Record<string, Structured> = {};
      const budget = optionBudget(chunk.length); // many children → shorter options, so one Choice stays affordable
      for (const k of chunk) options[k.name] = describeOption(k, domain, budget);
      const res = await client(state, walkQuestions(options, domain));
      // Record a completed call even when another chunk fails. The whole batch is
      // drained below before failure can reach the request's completion handler.
      tally.calls++;
      tally.inputTokens += res.usage.input_tokens;
      tally.outputTokens += res.usage.output_tokens;
      tally.apiMs += res.latencyMs;
      tally.model = res.model;
      return res;
    }),
  );
  for (const res of responses) {
    const pick = res.answers.pick as ChoiceAnswer;
    const under = res.answers.under_here as NoulAnswer;
    for (const [k, p] of Object.entries(pick.probabilities)) probs[k] = (probs[k] ?? 0) + p / responses.length;
    underHere = Math.max(underHere, under.noul);
    confidence = Math.max(confidence, pick.confidence);
    latencyMs = Math.max(latencyMs, res.latencyMs);
    tokens += res.usage.input_tokens + res.usage.output_tokens;
  }
  const seen: OptionSeen[] = kids.map((k) => ({ name: k.name, path: k.path, kind: k.kind, p: probs[k.name] ?? 0 }));
  seen.push({ name: NONE, path: "", kind: "none", p: probs[NONE] ?? 0 });
  seen.sort((a, b) => b.p - a.p);
  return { probs, underHere, confidence, latencyMs, tokens, seen };
}

export async function walk(opts: {
  client: Client;
  index: RepoIndex;
  query: Structured;
  scope: string;
  beam: number;
  maxDepth: number;
  /** Extra starting containers under the scope (lexical anchors): the walk begins there AND at the scope root. */
  seeds?: string[];
  emit: Emit;
  tally: Tally;
}): Promise<WalkOutcome> {
  const { client, index, query, emit, tally } = opts;
  const domain = index.domain ?? REPO_DOMAIN;
  const scopeNode = index.byPath.get(opts.scope);
  if (!scopeNode || scopeNode.kind !== "dir") throw new Error(`scope is not a ${domain.container}: ${opts.scope || "/"}`);

  const heat = new Map<string, number>();
  const visited: string[] = [];
  const finishedPool = new Map<string, Cand>();
  const bump = (path: string, v: number) => heat.set(path, Math.max(heat.get(path) ?? 0, v));

  const start = (path: string): Cand => ({ path, kind: "dir", probProduct: 1, decisions: 0, score: 1, finished: false, edgeP: 1 });
  const seeds = (opts.seeds ?? []).filter((p) => p !== opts.scope && index.byPath.get(p)?.kind === "dir" && (opts.scope === "" || p.startsWith(opts.scope + "/")));
  let beam: Cand[] = [start(opts.scope), ...seeds.map(start)];
  // Seeds widen the beam rather than compete for its slots: the root's own picks keep their K.
  const width = opts.beam + seeds.length;
  let prevTop: Cand | undefined;

  for (let step = 0; step < opts.maxDepth; step++) {
    const expandable = beam.filter((c) => !c.finished);
    if (expandable.length === 0) break;
    const pool: Cand[] = beam.filter((c) => c.finished);

    const results = await settleAll(
      expandable.map(async (cand) => {
        const node = index.byPath.get(cand.path)!;
        return { cand, ...(await askChildren(client, query, node, node.children ?? [], tally, domain)) };
      }),
    );

    for (const r of results) {
      const node = index.byPath.get(r.cand.path)!;
      const kids = node.children ?? [];
      visited.push(r.cand.path);
      emit({
        type: "expand",
        step,
        path: r.cand.path,
        parentScore: r.cand.score,
        options: r.seen,
        underHere: r.underHere,
        confidence: r.confidence,
        latencyMs: r.latencyMs,
        tokens: r.tokens,
      });

      // Never prune a starting point (the scope root, a seed): the walk has nowhere else to go.
      if (r.cand.decisions > 0 && r.underHere < T.UNDER_HERE_PRUNE) {
        emit({ type: "prune", step, path: r.cand.path, reason: "under_here", score: r.cand.score });
        continue;
      }
      for (const k of kids) {
        const child = extend(r.cand, k, r.probs[k.name] ?? 0);
        bump(child.path, child.score);
        pool.push(child);
        if (child.finished) {
          const prev = finishedPool.get(child.path);
          if (!prev || prev.score < child.score) finishedPool.set(child.path, child);
        }
      }
    }

    pool.sort((a, b) => b.score - a.score);
    const next = pool.slice(0, width);
    const dropped = pool.slice(width).filter((c) => c.score > 0);
    for (const d of dropped.slice(0, PRUNE_EVENTS_CAP)) emit({ type: "prune", step, path: d.path, reason: "beam", score: d.score });

    const entries: BeamEntry[] = next.map((c) => ({ path: c.path, kind: c.kind, score: c.score, depth: c.decisions, finished: c.finished }));
    emit({ type: "beam", step, candidates: entries });

    const top = next[0];
    if (isBacktrack(prevTop, top)) emit({ type: "backtrack", step, from: prevTop!.path, to: top.path });
    prevTop = top;
    beam = next;
    if (beam.length === 0 || beam.every((c) => c.finished)) break;
  }

  const finished = [...finishedPool.values()].sort((a, b) => b.score - a.score);
  const separation = finished.length >= 2 && finished[1].score > 0 ? finished[0].score / finished[1].score : undefined;
  return { finished, heat, visited, separation, beam };
}
