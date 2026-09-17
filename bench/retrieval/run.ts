import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { buildIndex } from "../../src/index/build.ts";
import { createClient } from "../../src/client.ts";
import { find } from "../../src/library.ts";
import { grep, bm25f, plainBM25, metrics } from "./baselines.ts";
import type { Manifest } from "./prepare.ts";
import { FINGERPRINT_SCHEMA, implementationFingerprints, tasksFingerprint, assertReusableImplementations, reusableCorpus, type ReuseEvidence } from "./provenance.ts";

const { values } = parseArgs({ options: {
  manifest: { type: "string", default: ".cache/bench/repoqa/manifest.json" },
  out: { type: "string", default: ".cache/bench/retrieval-results.json" },
  methods: { type: "string", default: "grep,bm25,bm25f,s1s" },
  runs: { type: "string", default: "3" },
  "dense-results": { type: "string" },
  "export-corpus": { type: "string" },
  "reuse-results": { type: "string" },
} });
const methods = values.methods.split(",");
if (methods.some((m) => !["grep", "bm25", "bm25f", "s1s", "dense"].includes(m))) throw new Error("Methods: grep,bm25,bm25f,s1s,dense");
const runs = Number(values.runs);
if (!Number.isInteger(runs) || runs < 1 || runs > 10) throw new Error("runs must be 1–10");
const manifest = JSON.parse(readFileSync(values.manifest, "utf8")) as Manifest;
if (manifest.schema !== 1 || !manifest.corpora.length) throw new Error("Invalid benchmark manifest");
const corpusExport: { limit: number; corpora: Array<{ id: string; files: Array<{path: string; text: string}>; queries: Array<{id: string; query: string}> }> } = { limit: 10, corpora: [] };
const client = methods.includes("s1s") && !values["export-corpus"] ? createClient({ concurrency: 6 }) : undefined;
type DenseResults = { model: string; revision: string; setupMs: number; device: string; corpora: Array<{ id: string; buildMs: number; cacheHit: boolean; chunks: number; contentHash?: string; queriesHash?: string; rows: Array<{id: string; ranked: string[]; latencyMs: number}> }> };
const dense = values["dense-results"] ? JSON.parse(readFileSync(values["dense-results"], "utf8")) as DenseResults : undefined;
if (methods.includes("dense") && !dense) throw new Error("Run dense.py first and pass --dense-results");
type Row = ReturnType<typeof metrics> & { corpus: string; language: string; id: string; method: string; run: number; ranked: string[]; latencyMs: number; calls: number; inputTokens: number; costUsd: number; contextBytes5: number; error?: string };
const previous = values["reuse-results"] ? JSON.parse(readFileSync(values["reuse-results"], "utf8")) as ReuseEvidence & {datasetSha256:string;seed:string;rows:Row[]} : undefined;
const methodFingerprints = values["export-corpus"] ? {} : implementationFingerprints(methods);
if (previous) assertReusableImplementations(previous, methodFingerprints, methods);
if (previous && (previous.datasetSha256 !== manifest.sha256 || previous.seed !== manifest.seed)) throw new Error("Previous results have different dataset provenance");
const rows: Row[] = [];
const preparations: Array<{ corpus: string; files: number; indexMs: number; bm25Ms: number; contentHash: string; tasksHash: string }> = [];
function persist() {
  const average = (rs: Row[], field: keyof Row) => rs.reduce((n, r) => n + Number(r[field]), 0) / (rs.length || 1);
  const summary = methods.map((method) => {
    const rs = rows.filter((r) => r.method === method);
    const times = rs.map((r) => r.latencyMs).sort((a,b) => a-b);
    return { method, evaluatedRows: rs.length, uniqueQueries: new Set(rs.map((r) => r.id)).size, errors: rs.filter((r) => r.error).length,
      hit1: average(rs,"hit1"), hit5: average(rs,"hit5"), hit10: average(rs,"hit10"), recall5: average(rs,"recall5"), recall10: average(rs,"recall10"), mrr10: average(rs,"mrr10"), ndcg10: average(rs,"ndcg10"), latencyP50Ms: times[Math.floor(times.length/2)] ?? 0,
      latencyP95Ms: times[Math.min(times.length-1,Math.floor(times.length*.95))] ?? 0,
      callsMean: average(rs,"calls"), inputTokensMean: average(rs,"inputTokens"), costUsd: rs.reduce((n,r)=>n+r.costUsd,0), contextBytes5Mean: average(rs,"contextBytes5"),
      perRun: [...new Set(rs.map(r=>r.run))].map(run=>({run,hit1:average(rs.filter(r=>r.run===run),"hit1"),hit5:average(rs.filter(r=>r.run===run),"hit5")})),
    };
  });
  mkdirSync(dirname(resolve(values.out)), { recursive: true });
  writeFileSync(values.out, JSON.stringify({ schema: 1, fingerprintSchema: FINGERPRINT_SCHEMA, methodFingerprints, createdAt: new Date().toISOString(), dataset: manifest.dataset, source: manifest.source, datasetSha256: manifest.sha256, seed: manifest.seed, task: manifest.task, runs,
    notes: ["File-localization adaptation, not official RepoQA SNF scores or SWE-bench issue-resolution rates.","Fixed queries and same source files across methods; gold labels are used only after ranking.","grep is a deterministic literal OR/count baseline, not agentic grep.","Dense is retrieval only (no generator); model and build costs recorded separately. Deterministic baselines run once; s1s repeats.","Errors count as misses. Context bytes measure full top-5 files, not tokenizer-accurate prompt length.","TypeSafe cost is estimated from reported successful usage; failed/retried calls may have unreported cost."],
    corpora: manifest.corpora.map(({directory:_,tasks,...c})=>({...c,queries:tasks.length})), preparations, dense: dense ? { model: dense.model, revision: dense.revision, device: dense.device, setupMs: dense.setupMs, corpora: dense.corpora.map(({rows:_,...c})=>c) } : undefined, summary, rows },null,2)+"\n");
  return summary;
}
for (const corpus of manifest.corpora) {
  const index = buildIndex(corpus.directory);
  // All methods receive exactly the textual corpus actually indexed by s1s.
  const files = index.lex.paths.map((path) => ({ path, text: index.text(path) ?? "" }));
  for (const task of corpus.tasks) for (const path of task.relevant) if (!index.byPath.has(path)) throw new Error(`Gold target not in snapshot: ${task.id} ${path}`);
  if (values["export-corpus"]) { corpusExport.corpora.push({ id: corpus.id, files, queries: corpus.tasks.map(({id,query})=>({id,query})) }); continue; }
  const start = performance.now(); const bm25 = plainBM25(index); const bm25Ms = performance.now()-start;
  preparations.push({corpus:corpus.id,files:index.fileCount,indexMs:index.buildMs,bm25Ms,contentHash:createHash("sha256").update(JSON.stringify(files)).digest("hex"),tasksHash:tasksFingerprint(corpus.tasks)});
  const allowed = new Set(index.lex.paths);
  const contentHash = preparations.at(-1)!.contentHash;
  const queriesHash = createHash("sha256").update(JSON.stringify(corpus.tasks.map(({id,query})=>({id,query})))).digest("hex");
  const denseCorpus = dense?.corpora.find(c=>c.id===corpus.id);
  if (methods.includes("dense") && (denseCorpus?.contentHash !== contentHash || denseCorpus?.queriesHash !== queriesHash)) throw new Error(`Dense source/query fingerprint mismatch for ${corpus.id}`);
  const reusable = previous ? reusableCorpus(previous, corpus.id, contentHash, preparations.at(-1)!.tasksHash) : false;
  for (const method of methods) {
    for (let run = 1; run <= (method === "s1s" ? runs : 1); run++) {
      for (const task of corpus.tasks) {
        const prior = reusable ? previous?.rows.find(r=>r.corpus===corpus.id && r.id===task.id && r.method===method && r.run===run && !r.error) : undefined;
        if (prior && method !== "dense") { rows.push(prior); continue; }
        const t0 = performance.now(); let ranked: string[] = []; let calls=0,inputTokens=0,costUsd=0,latencyMs=0,error: string|undefined;
        try {
          if (method === "grep") ranked = grep(index,task.query,10);
          else if (method === "bm25") ranked = bm25(task.query,10);
          else if (method === "bm25f") ranked = bm25f(index,task.query,10);
          else if (method === "dense") {
            const match = dense?.corpora.find(c=>c.id===corpus.id)?.rows.find(r=>r.id===task.id);
            if (!match) throw new Error("Missing dense result"); ranked=match.ranked;latencyMs=match.latencyMs;
          } else {
            const result = await find(index,client!,task.query); ranked=result.results.map(r=>r.path).slice(0,10);calls=result.stats.calls;inputTokens=result.stats.inputTokens;costUsd=result.stats.estCostUsd;
          }
          if (ranked.some(path=>!allowed.has(path))) throw new Error("Retriever returned an out-of-corpus path");
        } catch(err) { error=err instanceof Error?err.message:String(err); ranked=[]; }
        latencyMs ||= performance.now()-t0;
        const row: Row={corpus:corpus.id,language:corpus.language,id:task.id,method,run,ranked,latencyMs,calls,inputTokens,costUsd,contextBytes5:ranked.slice(0,5).reduce((n,p)=>n+Buffer.byteLength(index.text(p)??""),0),...metrics(ranked,task.relevant),...(error?{error}:{})};
        rows.push(row); persist();
        console.log(`${method.padEnd(6)} run${run} ${task.id} @1=${row.hit1} @5=${row.hit5} ${Math.round(latencyMs)}ms${error?` ERROR ${error}`:""}`);
      }
    }
  }
}
if (values["export-corpus"]) { mkdirSync(dirname(resolve(values["export-corpus"])),{recursive:true}); writeFileSync(values["export-corpus"],JSON.stringify(corpusExport)); console.log(`Exported source/query-only input to ${values["export-corpus"]}`); }
else { console.table(persist()); if(rows.some(r=>r.error)) process.exitCode=1; }
