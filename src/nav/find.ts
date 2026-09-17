import type { Client } from "../client.ts";
import { filesUnder, type RepoIndex } from "../index/build.ts";
import { anchors, evidenceLines, parseQuery, pool, type QueryTerm } from "../index/lex.ts";
import type { NoulAnswer, Question, Structured } from "../types.ts";
import type { ResultRow } from "./events.ts";
import { REPO_DOMAIN, T, candidatesState, describeOption, shortlistQuestion } from "../questions.ts";
import { walk, type Emit, type Tally } from "./walk.ts";
import { verify, type Unverified } from "./verify.ts";

/**
 * FIND — recall is code, precision is TypeSafe.
 *
 *   1. lexical pool   zero calls: BM25F over every unit's path, content facts and body.
 *   2. shortlist      one Noul per pooled unit, judged on its content descriptor.
 *   3. verify         a bounded semantic/lexical union, compared against each other on evidence AIMED at the query.
 *   4. escalate       only when that did not find it: a walk from the root and the lexical anchors.
 *
 * A tree (or scope) small enough to shortlist whole skips the pool. (A vocabulary step — TypeSafe
 * judging which of the tree's own words belong to the query, to widen the pool — was benched on
 * 2026-09-16 and changed no row at +1 call; `termQuestion` lives on in explain.)
 */
export type FindOutcome = {
  results: ResultRow[];
  heat: Map<string, number>;
  visited: string[];
  separation?: number;
  /** The lexical terms the query became. */
  terms: QueryTerm[];
  escalated: boolean;
};

function record(tally: Tally, res: { usage: { input_tokens: number; output_tokens: number }; latencyMs: number; model: string }): void {
  tally.calls++;
  tally.inputTokens += res.usage.input_tokens;
  tally.outputTokens += res.usage.output_tokens;
  tally.apiMs += res.latencyMs;
  tally.model = res.model;
}

export async function find(opts: {
  client: Client;
  index: RepoIndex;
  query: string;
  scope: string;
  beam: number;
  maxDepth: number;
  emit: Emit;
  tally: Tally;
}): Promise<FindOutcome> {
  const { client, index, query, scope, emit, tally } = opts;
  const domain = index.domain ?? REPO_DOMAIN;
  const scopeNode = index.byPath.get(scope);
  if (!scopeNode || scopeNode.kind !== "dir") throw new Error(`scope is not a ${domain.container}: ${scope || "/"}`);

  const heat = new Map<string, number>();
  const shortlisted = new Map<string, number>();

  /** One Noul per unit, on its descriptor; batches run concurrently. */
  const shortlist = async (paths: string[]): Promise<void> => {
    const batches: string[][] = [];
    for (let i = 0; i < paths.length; i += T.SHORTLIST_BATCH) batches.push(paths.slice(i, i + T.SHORTLIST_BATCH));
    await Promise.all(
      batches.map(async (batch) => {
        const candidates = batch.map((path) => {
          const descriptor = { path, ...(describeOption(index.byPath.get(path)!, domain) as { [k: string]: Structured }) };
          const text = index.text(path);
          // A file-level signature can omit the relevant method in a large module. Show a
          // bounded, query-specific source view before deciding whether to verify the file.
          const evidence = text ? evidenceLines(text, terms, { head: 0, windows: T.SHORTLIST_WINDOWS, radius: T.SHORTLIST_RADIUS }) : [];
          return evidence.length ? { ...descriptor, evidence } : descriptor;
        });
        const questions: Record<string, Question> = {};
        batch.forEach((_, i) => (questions[`shortlist_${i}`] = shortlistQuestion(i, domain)));
        const res = await client(candidatesState({ query }, candidates), questions);
        record(tally, res);
        const rows = batch.map((path, i) => ({ path, noul: (res.answers[`shortlist_${i}`] as NoulAnswer | undefined)?.noul ?? 0 }));
        for (const r of rows) {
          shortlisted.set(r.path, r.noul);
          heat.set(r.path, r.noul);
        }
        emit({ type: "shortlist", candidates: [...rows].sort((a, b) => b.noul - a.noul), latencyMs: res.latencyMs, tokens: res.usage.input_tokens + res.usage.output_tokens });
      }),
    );
  };

  // 1. Lexical pool (or the whole scope, when it is small enough to shortlist outright).
  const t0 = performance.now();
  const terms = parseQuery(index.lex, query);
  const hits = pool(index.lex, terms, { scope, all: T.LEX_ALL, path: T.LEX_PATH, sig: T.LEX_SIG });
  const leaves = filesUnder(scopeNode);
  const whole = leaves.length <= T.SHORTLIST_ALL_UNDER;
  const pooled = hits.map((h) => h.path);
  const first = whole ? [...pooled, ...leaves.map((l) => l.path).filter((p) => !pooled.includes(p))] : pooled;
  emit({
    type: "lexical",
    terms: terms.map((t) => ({ label: t.label, df: t.df, weight: t.weight })),
    paths: first,
    top: hits.slice(0, 10).map((h) => ({ path: h.path, score: h.score })),
    anchors: anchors(hits),
    whole,
    ms: performance.now() - t0,
  });

  // 2. Shortlist the pool.
  await shortlist(first);

  // 3. Verify the best of the shortlist, plus the best lexical hits it would have left out.
  const byNoul = [...shortlisted.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const chosen = new Map<string, Unverified>();
  for (const [path, noul] of byNoul.slice(0, T.SHORTLIST_KEEP)) chosen.set(path, { path, via: "lexical", noul });
  let lexicalAdded = 0;
  for (const h of hits) {
    if (lexicalAdded >= T.LEX_KEEP) break;
    if (chosen.has(h.path)) continue;
    chosen.set(h.path, { path: h.path, via: "lexical", noul: shortlisted.get(h.path) });
    lexicalAdded++;
  }
  let results = await verify({ client, index, query, candidates: [...chosen.values()], terms, emit, tally });
  const stamp = (rows: ResultRow[]): ResultRow[] => rows.map((r) => ({ ...r, shortlist: shortlisted.get(r.path) }));

  // 4. Not found → walk from the scope root and the lexical anchors; its finishers face the survivors.
  let visited: string[] = [];
  let separation: number | undefined;
  let escalated = false;
  const top = results[0]?.verify ?? 0;
  if (top < T.FOUND) {
    escalated = true;
    const seeds = anchors(hits);
    emit({ type: "escalate", reason: top >= T.PARTIAL ? "partial" : "absent", seeds });
    const w = await walk({ client, index, query, scope, beam: opts.beam, maxDepth: opts.maxDepth, seeds, emit, tally });
    visited = w.visited;
    separation = w.separation;
    for (const [k, v] of w.heat) heat.set(k, Math.max(heat.get(k) ?? 0, v));
    const seen = new Set(results.map((r) => r.path));
    const fresh = w.finished.filter((c) => !seen.has(c.path)).slice(0, T.WALK_KEEP);
    if (fresh.length) {
      const again: Unverified[] = [
        ...results.filter((r) => (r.verify ?? 0) >= T.PARTIAL).slice(0, T.VERIFY_TOP - fresh.length).map((r) => ({ path: r.path, via: r.via, noul: r.noul })),
        ...fresh.map((c) => ({ path: c.path, via: "walk" as const, pathScore: c.score })),
      ];
      const second = await verify({ client, index, query, candidates: again, terms, emit, tally });
      const judged = new Set(second.map((r) => r.path));
      results = [...second, ...results.filter((r) => !judged.has(r.path))].sort((a, b) => b.score - a.score || (b.pick ?? 0) - (a.pick ?? 0));
    }
  }

  for (const r of results) if (r.verify !== undefined) heat.set(r.path, r.verify);
  // A container is as warm as the warmest unit TypeSafe judged beneath it.
  for (const [path, v] of [...heat]) {
    if (index.byPath.get(path)?.kind !== "file") continue;
    for (let i = path.lastIndexOf("/"); i > 0; i = path.lastIndexOf("/", i - 1)) {
      const dir = path.slice(0, i);
      heat.set(dir, Math.max(heat.get(dir) ?? 0, v));
    }
  }
  return { results: stamp(results), heat, visited, separation, terms, escalated };
}
