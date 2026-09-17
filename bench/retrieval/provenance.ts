/** Reuse is an evidence claim: source, task and implementation must all match. */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import type { RetrievalTask } from "./prepare.ts";

export const FINGERPRINT_SCHEMA = 1;
const root = fileURLToPath(new URL("../../", import.meta.url));
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function tasksFingerprint(tasks: RetrievalTask[]): string {
  return digest(tasks.map(({ id, query, relevant }) => ({ id, query, relevant: [...relevant].sort() })));
}
function sourceFiles(directory: string): string[] {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? sourceFiles(`${directory}/${entry.name}`) : entry.name.endsWith(".ts") ? [`${directory}/${entry.name}`] : []).sort();
}
/** Hash executable source and relevant runtime versions, not merely a Git HEAD or method name. */
export function implementationFingerprints(methods: string[]): Record<string, string> {
  const common = ["bench/retrieval/run.ts", "bench/retrieval/provenance.ts", "bench/retrieval/baselines.ts"];
  const index = sourceFiles("src/index");
  const sources: Record<string, string[]> = {
    grep: common,
    bm25: common,
    bm25f: [...common, ...index],
    s1s: [...common, ...index, ...sourceFiles("src/nav"), ...sourceFiles("src/graph"), ...sourceFiles("src/flow"), "src/library.ts", "src/client.ts", "src/questions.ts", "src/types.ts"],
    dense: [...common, "bench/retrieval/dense.py", "bench/retrieval/requirements.txt"],
  };
  return Object.fromEntries(methods.map(method => {
    if (!sources[method]) throw new Error(`Unknown benchmark method: ${method}`);
    const runtime = { node: process.version, icu: process.versions.icu, locale: Intl.DateTimeFormat().resolvedOptions().locale,
      ...(method === "grep" ? { ripgrep: String(execFileSync("rg", ["--version"], { encoding: "utf8" })).split("\n")[0] } : {}) };
    return [method, digest({ schema: FINGERPRINT_SCHEMA, method, runtime, sources: [...new Set(sources[method])].sort().map(path => [path, readFileSync(join(root, path), "utf8")]) })];
  }));
}
export type ReuseEvidence = {
  fingerprintSchema?: number;
  methodFingerprints?: Record<string, string>;
  preparations: Array<{ corpus: string; contentHash: string; tasksHash?: string }>;
};
/** Fail before a benchmark starts rather than silently reusing old, unproven algorithms. */
export function assertReusableImplementations(previous: ReuseEvidence, current: Record<string, string>, methods: string[]): void {
  if (previous.fingerprintSchema !== FINGERPRINT_SCHEMA) throw new Error("Previous results lack the required implementation/task fingerprints; omit --reuse-results and run a new benchmark");
  for (const method of methods.filter(method => method !== "dense")) {
    if (!current[method] || previous.methodFingerprints?.[method] !== current[method]) throw new Error(`Previous ${method} implementation fingerprint is absent or different; reuse is not proven`);
  }
}
export function reusableCorpus(previous: ReuseEvidence, corpus: string, contentHash: string, tasksHash: string): boolean {
  const evidence = previous.preparations.find(row => row.corpus === corpus);
  return !!evidence?.tasksHash && evidence.contentHash === contentHash && evidence.tasksHash === tasksHash;
}
