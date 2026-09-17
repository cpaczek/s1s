import type { Client } from "../client.ts";
import type { RepoIndex, TreeNode } from "../index/build.ts";
import { parseQuery, search, type QueryTerm } from "../index/lex.ts";
import type { NoulAnswer, Question, Structured } from "../types.ts";
import type { ResultRow } from "./events.ts";
import { F, REPO_DOMAIN, T, candidatesState, describeOption, memberQuestion, topicState, type Topic } from "../questions.ts";
import type { Emit, Tally } from "./walk.ts";

/**
 * MAP — every unit a subject lives in. Code narrows the tree to the units whose path or
 * content share the subject's words (zero calls), then TypeSafe judges each one on its content
 * descriptor: "is this one of the places where `topic` is implemented, configured or used?".
 * The heat map is the answer; every unit ≥ PARTIAL is a result.
 */
export type MapOutcome = {
  /** Every judged unit, best first. */
  scored: Array<{ path: string; noul: number }>;
  heat: Map<string, number>;
  visited: string[];
  /** The lexical prefilter's terms (typed words + their relatives in the tree's vocabulary). */
  terms: QueryTerm[];
  /** How many units matched lexically but were not judged (the prefilter cap). */
  truncated: number;
};

/**
 * A subject word's relatives in the tree's own vocabulary: the words it begins with or that
 * begin with it ("authentication" → auth, authenticate, authenticated; "flashcard" → flashcards).
 * Code, not judgment: a prefix of 4+ letters shared with a typed word of 5+ letters.
 */
export function relatives(vocabulary: Iterable<string>, words: string[], min = 4): string[] {
  const typed = words.map((w) => w.toLowerCase()).filter((w) => w.length >= 5);
  const out = new Set<string>();
  for (const v of vocabulary) {
    if (v.length < min) continue;
    for (const w of typed) if (v !== w && (w.startsWith(v) || v.startsWith(w))) out.add(v);
  }
  return [...out].sort();
}

/** Directory heat = max heat of any unit beneath it; returns the containers that got a value. */
export function rollUpDirHeat(scopeNode: TreeNode, heat: Map<string, number>): string[] {
  const visited: string[] = [];
  const roll = (n: TreeNode): number => {
    if (n.kind === "file") return heat.get(n.path) ?? 0;
    let best = 0;
    for (const c of n.children ?? []) best = Math.max(best, roll(c));
    if (n.files > 0) {
      heat.set(n.path, best);
      visited.push(n.path);
    }
    return best;
  };
  roll(scopeNode);
  return visited;
}

export async function map(opts: { client: Client; index: RepoIndex; topic: Topic; scope: string; emit: Emit; tally: Tally }): Promise<MapOutcome> {
  const { client, index, topic, scope, emit, tally } = opts;
  const domain = index.domain ?? REPO_DOMAIN;
  const scopeNode = index.byPath.get(scope);
  if (!scopeNode || scopeNode.kind !== "dir") throw new Error(`scope is not a ${domain.container}: ${scope || "/"}`);

  // 1. Prefilter (no calls): the subject's words, their vocabulary relatives, and what it includes.
  const words = [topic.name, ...topic.includes].join(" ");
  const extra = relatives(index.lex.vocab.keys(), words.split(/[^A-Za-z0-9]+/)).map((term) => ({ term, weight: F.TERM_WEIGHT }));
  const terms = parseQuery(index.lex, words, extra);
  const byContent = search(index.lex, terms, { scope, limit: F.MEMBER_PREFILTER });
  const byPath = search(index.lex, terms, { scope, fields: "path" });
  const candidates = [...new Set([...byPath.map((h) => h.path), ...byContent.map((h) => h.path)])];
  const truncated = Math.max(0, search(index.lex, terms, { scope }).length - candidates.length);

  // 2. Membership: one Noul per candidate on its descriptor, F.MEMBER_BATCH per call.
  const heat = new Map<string, number>();
  const batches: string[][] = [];
  for (let i = 0; i < candidates.length; i += F.MEMBER_BATCH) batches.push(candidates.slice(i, i + F.MEMBER_BATCH));
  await Promise.all(
    batches.map(async (batch, bi) => {
      const shown = batch.map((path) => ({ path, ...(describeOption(index.byPath.get(path)!, domain) as { [k: string]: Structured }) }));
      const questions: Record<string, Question> = {};
      batch.forEach((_, i) => (questions[`member_${i}`] = memberQuestion(i, domain)));
      const res = await client(candidatesState(topicState(topic), shown), questions);
      tally.calls++;
      tally.inputTokens += res.usage.input_tokens;
      tally.outputTokens += res.usage.output_tokens;
      tally.apiMs += res.latencyMs;
      tally.model = res.model;
      const rows = batch.map((path, i) => ({ path, noul: (res.answers[`member_${i}`] as NoulAnswer | undefined)?.noul ?? 0 }));
      for (const r of rows) heat.set(r.path, r.noul);
      emit({
        type: "batch",
        batch: bi,
        batches: batches.length,
        units: batch.length,
        top: [...rows].sort((a, b) => b.noul - a.noul).slice(0, 5),
        heat: Object.fromEntries(rows.map((r) => [r.path, r.noul])),
        latencyMs: res.latencyMs,
        tokens: res.usage.input_tokens + res.usage.output_tokens,
      });
    }),
  );

  const scored = candidates.map((path) => ({ path, noul: heat.get(path) ?? 0 })).sort((a, b) => b.noul - a.noul || (a.path < b.path ? -1 : 1));
  const visited = rollUpDirHeat(scopeNode, heat);
  return { scored, heat, visited, terms, truncated };
}

/** The result rows a map produces: every unit judged at least partly part of the subject. */
export function mapResults(scored: MapOutcome["scored"], cap = T.MAP_RESULTS): ResultRow[] {
  return scored
    .filter((r) => r.noul >= T.PARTIAL)
    .slice(0, cap)
    .map((r) => ({ path: r.path, score: r.noul, noul: r.noul, via: "map" }));
}
