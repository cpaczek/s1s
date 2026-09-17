import { execFileSync } from "node:child_process";
import type { RepoIndex } from "../../src/index/build.ts";
import { parseQuery, search } from "../../src/index/lex.ts";
const STOP = new Set("a an the is are be to of for in on and or with this that it from as by at not into its function method purpose input output takes returns accepts given designed used using specified some any can will has have which when if each their such without through".split(" "));
/** Non-oracle query reduction shared by the mechanical grep and plain BM25 baselines. */
export function words(query: string): string[] { return [...new Set((query.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().match(/[a-z][a-z0-9_]{2,}/g) ?? []).filter((w) => !STOP.has(w)))]; }
export function grep(index: RepoIndex, query: string, limit: number): string[] {
  const terms = words(query);
  const paths = index.lex.paths.filter((path) => index.text(path) !== undefined);
  // Only source bodies visible to every retriever. An empty list must not make rg scan cwd.
  if (!terms.length || !paths.length) return [];
  // Literal OR, count matching lines per file, stable path tie-break. One deterministic
  // command, not a claim to simulate an LLM choosing/adapting grep queries.
  const args = ["--no-config", "--no-ignore", "--hidden", "--text", "--with-filename", "--count", "--null", "--ignore-case", "--fixed-strings", ...terms.flatMap((term) => ["-e", term]), "--", ...paths];
  let output: string;
  try { output = execFileSync("rg", args, { cwd: index.repo, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }); }
  catch (error) { if ((error as { status?: number }).status === 1) return []; throw error; }
  return [...output.matchAll(/([^\0\n]+)\0(\d+)\n/g)].map((m) => ({ path: m[1], count: Number(m[2]) })).sort((a, b) => b.count - a.count || a.path.localeCompare(b.path)).slice(0, limit).map((x) => x.path);
}
export function bm25f(index: RepoIndex, query: string, limit: number): string[] { return search(index.lex, parseQuery(index.lex, query), { limit }).map((r) => r.path); }
/** Plain file BM25, k1=1.2 b=.75. No TypeSafe facts, stemming, or query expansion. */
export function plainBM25(index: RepoIndex): (query: string, limit: number) => string[] {
  const docs = index.lex.paths.map((path) => {
    const tokens = (index.text(path) ?? "").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().match(/[a-z][a-z0-9_]{2,}/g) ?? [];
    const counts = new Map<string, number>(); for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
    return { path, length: tokens.length, counts };
  });
  const df = new Map<string, number>(); for (const doc of docs) for (const term of doc.counts.keys()) df.set(term, (df.get(term) ?? 0) + 1);
  const average = docs.reduce((n, d) => n + d.length, 0) / (docs.length || 1) || 1;
  return (query, limit) => docs.map((d) => ({ path: d.path, score: words(query).reduce((sum, term) => {
    const tf = d.counts.get(term) ?? 0; const n = df.get(term) ?? 0;
    return sum + Math.log(1 + (docs.length - n + .5) / (n + .5)) * tf * 2.2 / (tf + 1.2 * (.25 + .75 * d.length / average));
  }, 0) })).filter((x) => x.score > 0).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, limit).map((d) => d.path);
}
export function metrics(ranked: string[], relevant: string[]) {
  const unique = [...new Set(ranked)]; const gold = new Set(relevant);
  const hits = (k: number) => unique.slice(0, k).filter((p) => gold.has(p)).length;
  const first = unique.findIndex((p) => gold.has(p));
  const dcg = unique.slice(0, 10).reduce((sum, p, i) => sum + (gold.has(p) ? 1 / Math.log2(i + 2) : 0), 0);
  const ideal = Array.from({ length: Math.min(10, gold.size) }, (_, i) => 1 / Math.log2(i + 2)).reduce((a, b) => a + b, 0);
  return { hit1: hits(1) > 0 ? 1 : 0, hit5: hits(5) > 0 ? 1 : 0, hit10: hits(10) > 0 ? 1 : 0, recall5: gold.size ? hits(5) / gold.size : 0, recall10: gold.size ? hits(10) / gold.size : 0, mrr10: first >= 0 && first < 10 ? 1 / (first + 1) : 0, ndcg10: ideal ? dcg / ideal : 0 };
}
