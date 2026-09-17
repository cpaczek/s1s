/** Paired architectural experiments. Gold labels are only read by scoring/diagnostics. */
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import type { Manifest } from "./prepare.ts";
import type { NavEvent, SearchResult } from "../../src/nav/events.ts";
import { tasksFingerprint } from "./provenance.ts";

const { values } = parseArgs({
  options: {
    engine: { type: "string", default: "." },
    manifest: { type: "string", default: ".cache/bench/repoqa/manifest.json" },
    runs: { type: "string", default: "3" },
    out: { type: "string", default: ".cache/iteration/results.json" },
    label: { type: "string", default: "candidate" },
  },
});
const engine = resolve(values.engine),
  runs = Number(values.runs);
if (!Number.isSafeInteger(runs) || runs < 1 || runs > 10)
  throw new Error("runs must be 1–10");
const manifest = JSON.parse(readFileSync(values.manifest, "utf8")) as Manifest;
const library = (await import(
  pathToFileURL(join(engine, "src/library.ts")).href
)) as typeof import("../../src/library.ts");
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory()
        ? sourceFiles(join(directory, e.name))
        : e.name.endsWith(".ts")
          ? [join(directory, e.name)]
          : [],
    )
    .sort();
}
const engineHash = hash(
  sourceFiles(join(engine, "src")).map((p) => [
    p.slice(engine.length + 1),
    readFileSync(p, "utf8"),
  ]),
);
const commit = execFileSync("git", ["-C", engine, "rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const client = library.createClient({ concurrency: 6 });
const ks = [1, 5, 10, 20] as const;
type Row = {
  id: string;
  corpus: string;
  run: number;
  ranked: string[];
  verdict?: string;
  model?: string;
  hit: Record<string, number>;
  recall: Record<string, number>;
  calls: number;
  inputTokens: number;
  costUsd: number;
  wallMs: number;
  returned: number;
  unverified: number;
  diagnostics: unknown;
  warnings?: SearchResult["warnings"];
  error?: string;
};
const rows: Row[] = [];
const corpora: Array<{
  id: string;
  repo: string;
  revision: string;
  files: number;
  sourceHash: string;
  tasksHash: string;
  buildMs: number;
}> = [];
function diagnostics(
  events: NavEvent[],
  result: SearchResult | undefined,
  relevant: string[],
) {
  const pooled = new Set<string>();
  const shortlisted = new Map<string, number>();
  const verified = new Map<string, number[]>();
  for (const e of events) {
    if (e.type === "lexical") for (const p of e.paths) pooled.add(p);
    if (e.type === "shortlist")
      for (const c of e.candidates) shortlisted.set(c.path, c.noul);
    if (e.type === "verify")
      for (const c of e.candidates)
        verified.set(c.path, [...(verified.get(c.path) || []), c.match]);
  }
  const shortRank = [...shortlisted]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([p]) => p);
  return relevant.map((path) => ({
    path,
    pooled: pooled.has(path),
    shortlistRank:
      shortRank.indexOf(path) < 0 ? null : shortRank.indexOf(path) + 1,
    shortlist: shortlisted.get(path),
    verify: verified.get(path) || [],
    resultRank:
      result?.results.findIndex((r) => r.path === path)! >= 0
        ? result!.results.findIndex((r) => r.path === path) + 1
        : null,
  }));
}
function summary(rs: Row[]) {
  const avg = (read: (r: Row) => number) =>
    rs.reduce((n, r) => n + read(r), 0) / (rs.length || 1);
  const times = rs.map((r) => r.wallMs).sort((a, b) => a - b);
  return {
    n: rs.length,
    errors: rs.filter((r) => r.error).length,
    degraded: rs.filter((r) => r.warnings?.length).length,
    hit: Object.fromEntries(ks.map((k) => [k, avg((r) => r.hit[k])])),
    recall: Object.fromEntries(ks.map((k) => [k, avg((r) => r.recall[k])])),
    calls: avg((r) => r.calls),
    inputTokens: avg((r) => r.inputTokens),
    costUsd: rs.reduce((n, r) => n + r.costUsd, 0),
    wallP50: times[Math.floor(times.length / 2)] ?? 0,
    returned: avg((r) => r.returned),
    unverified: rs.reduce((n, r) => n + r.unverified, 0),
  };
}
function save() {
  mkdirSync(dirname(resolve(values.out)), { recursive: true });
  writeFileSync(
    values.out,
    JSON.stringify(
      {
        schema: 1,
        label: values.label,
        createdAt: new Date().toISOString(),
        engineCommit: commit,
        engineHash,
        node: process.version,
        dataset: manifest.dataset,
        datasetSha256: manifest.sha256,
        seed: manifest.seed,
        runs,
        corpora,
        summary: summary(rows),
        perRun: Array.from({ length: runs }, (_, i) => ({
          run: i + 1,
          ...summary(rows.filter((r) => r.run === i + 1)),
        })),
        rows,
      },
      null,
      2,
    ) + "\n",
  );
}
for (const corpus of manifest.corpora) {
  const index = library.buildIndex(corpus.directory);
  corpora.push({
    id: corpus.id,
    repo: corpus.repo,
    revision: corpus.revision,
    files: index.fileCount,
    sourceHash: hash(
      index.lex.paths.map((path) => [path, index.text(path) ?? null]),
    ),
    tasksHash: tasksFingerprint(corpus.tasks),
    buildMs: index.buildMs,
  });
  for (const t of corpus.tasks)
    for (const p of t.relevant)
      if (!index.byPath.has(p))
        throw new Error(`Gold path outside source snapshot: ${t.id}`);
  for (let run = 1; run <= runs; run++)
    for (const task of corpus.tasks) {
      const events: NavEvent[] = [];
      let result: SearchResult | undefined, error: string | undefined;
      const start = performance.now();
      try {
        result = await library.find(index, client, task.query, {
          onEvent: (e) => {
            if (["lexical", "shortlist", "verify", "escalate"].includes(e.type))
              events.push(e);
          },
        });
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      const ranked = [
        ...new Set(result?.results.map((r) => r.path) || []),
      ].slice(0, 20);
      const gold = new Set(task.relevant);
      const hits = (k: number) =>
        ranked.slice(0, k).filter((p) => gold.has(p)).length;
      const row: Row = {
        id: task.id,
        corpus: corpus.id,
        run,
        ranked,
        verdict: result?.verdict,
        model: result?.stats.model,
        warnings: result?.warnings,
        hit: Object.fromEntries(ks.map((k) => [k, hits(k) > 0 ? 1 : 0])),
        recall: Object.fromEntries(
          ks.map((k) => [k, gold.size ? hits(k) / gold.size : 0]),
        ),
        calls: result?.stats.calls ?? 0,
        inputTokens: result?.stats.inputTokens ?? 0,
        costUsd: result?.stats.estCostUsd ?? 0,
        wallMs: Math.round(performance.now() - start),
        returned: result?.results.length ?? 0,
        unverified:
          result?.results.filter((r) => r.verify === undefined).length ?? 0,
        diagnostics: diagnostics(events, result, task.relevant),
        ...(error ? { error } : {}),
      };
      rows.push(row);
      save();
      console.log(
        `${values.label} ${task.id} run${run} @1=${row.hit[1]} @5=${row.hit[5]} @10=${row.hit[10]} @20=${row.hit[20]} calls=${row.calls}${error ? " ERROR " + error : ""}`,
      );
    }
}
console.log(JSON.stringify(summary(rows)));
if (rows.some((r) => r.error)) process.exitCode = 1;
