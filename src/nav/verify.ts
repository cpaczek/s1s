import type { Client } from "../client.ts";
import type { RepoIndex } from "../index/build.ts";
import type { ChoiceAnswer, NoulAnswer, Structured } from "../types.ts";
import type { ResultRow } from "./events.ts";
import type { Emit, Tally } from "./walk.ts";
import { REPO_DOMAIN, T, verifyQuestions, verifyState, type Candidate } from "../questions.ts";
import { evidenceFor } from "../index/build.ts";
import { clip } from "../index/facts.ts";
import { evidenceLines, tokenize, type QueryTerm } from "../index/lex.ts";

/**
 * Everything the verifier shows TypeSafe about one leaf. With the query's terms the evidence is
 * AIMED: a short head plus numbered windows around the lines matching the rarest query words —
 * the defining lines are often hundreds of lines in. Without terms it is the plain head.
 */
export function candidateFor(index: RepoIndex, path: string, terms?: QueryTerm[]): Candidate {
  const node = index.byPath.get(path);
  const text = terms?.length ? index.text(path) : undefined;
  const facts = index.facts.get(path);
  const declarations = facts?.decls.map((d) => {
    const tokens = new Set(tokenize(d.name));
    const score = (terms ?? []).reduce((sum, t) => sum + (t.group.some((v) => tokens.has(v)) ? t.weight / Math.log(2 + t.df) : 0), 0);
    return { d, score };
  }).sort((a, b) => b.score - a.score || a.d.line - b.d.line)
    .slice(0, T.EVIDENCE_DECLS).map(({ d }) => ({ name: d.name, kind: d.kind, line: d.line }));
  return {
    path,
    ext: node?.ext,
    lines: node?.lines,
    exports: node?.exports?.slice(0, T.EXPORTS_MAX),
    hint: facts?.about ? clip(facts.about, T.EVIDENCE_ABOUT) : node?.hint,
    declarations,
    head: text ? evidenceLines(text, terms!, { head: T.EVIDENCE_HEAD, windows: T.EVIDENCE_WINDOWS, radius: T.EVIDENCE_RADIUS }) : evidenceFor(index, path, T.HEAD_LINES),
  };
}

export type Unverified = { path: string; via: ResultRow["via"]; pathScore?: number; noul?: number };

/** One call: a Noul per candidate (comparable, same criteria) + a Choice across them. */
export async function verify(opts: {
  client: Client;
  index: RepoIndex;
  query: Structured;
  candidates: Unverified[];
  /** The query's lexical terms: aims each candidate's evidence at the lines that matter. */
  terms?: QueryTerm[];
  emit: Emit;
  tally: Tally;
}): Promise<ResultRow[]> {
  const { client, index, query, emit, tally } = opts;
  if (opts.candidates.length === 0) return [];
  const domain = index.domain ?? REPO_DOMAIN;
  const descriptors: Candidate[] = opts.candidates.map((c) => candidateFor(index, c.path, opts.terms));

  const res = await client(verifyState(query, descriptors), verifyQuestions(descriptors, domain));
  tally.calls++;
  tally.inputTokens += res.usage.input_tokens;
  tally.outputTokens += res.usage.output_tokens;
  tally.apiMs += res.latencyMs;
  tally.model = res.model;

  const best = res.answers.best as ChoiceAnswer;
  const rows: ResultRow[] = opts.candidates.map((c, i) => {
    const match = (res.answers[`match_${i}`] as NoulAnswer | undefined)?.noul ?? 0;
    const pick = best.probabilities[c.path] ?? 0;
    return { path: c.path, score: match, verify: match, pick, pathScore: c.pathScore, noul: c.noul, via: c.via };
  });
  rows.sort((a, b) => b.score - a.score || (b.pick ?? 0) - (a.pick ?? 0));

  emit({
    type: "verify",
    candidates: rows.map((r) => ({ path: r.path, match: r.verify ?? 0, pick: r.pick ?? 0 })),
    latencyMs: res.latencyMs,
    tokens: res.usage.input_tokens + res.usage.output_tokens,
  });
  return rows;
}
