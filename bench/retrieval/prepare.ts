/** RepoQA's published source snapshot and queries, adapted to FILE retrieval. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

export type RetrievalTask = { id: string; query: string; relevant: string[] };
export type RetrievalCorpus = { id: string; language: string; repo: string; revision: string; directory: string; tasks: RetrievalTask[] };
export type Manifest = { schema: 1; dataset: string; source: string; sha256: string; seed: string; task: string; corpora: RetrievalCorpus[] };
type Needle = { path: string; name: string; description: string; start_line: number; end_line: number };
type RepoQARepo = { repo: string; commit_sha: string; content: Record<string, string>; needles: Needle[] };
const SOURCE = "https://github.com/evalplus/repoqa_release/releases/download/2024-06-23/repoqa-2024-06-23.json.gz";
export const hash = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
export function safeRelative(path: string): boolean { return !!path && !path.startsWith("/") && !path.includes("\\") && !path.includes("\0") && !path.split("/").some((p) => p === "." || p === ".." || p.toLowerCase() === ".git" || p === ""); }
export function selectStable<T>(values: T[], key: (value: T) => string, count: number, seed: string): T[] {
  return [...values].sort((a, b) => hash(seed + key(a)).localeCompare(hash(seed + key(b)))).slice(0, count);
}
export async function prepare(options: { out: string; data?: string; reposPerLanguage: number; queriesPerRepo: number; seed: string; languages?: string[] }): Promise<Manifest> {
  const out = resolve(options.out); mkdirSync(out, { recursive: true });
  const dataPath = options.data ? resolve(options.data) : resolve(out, "repoqa-2024-06-23.json.gz");
  if (!existsSync(dataPath)) {
    const response = await fetch(SOURCE);
    if (!response.ok) throw new Error(`RepoQA download failed: ${response.status}`);
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length > 64 * 1024 * 1024) throw new Error("Dataset is unexpectedly large");
    writeFileSync(dataPath, data);
  }
  const bytes = readFileSync(dataPath);
  const dataset = JSON.parse(gunzipSync(bytes, { maxOutputLength: 256 * 1024 * 1024 }).toString("utf8")) as Record<string, RepoQARepo[]>;
  const manifest: Manifest = { schema: 1, dataset: "RepoQA 2024-06-23", source: SOURCE, sha256: hash(bytes), seed: options.seed, task: "file-localization adaptation; NOT the official function-generation metric", corpora: [] };
  const languages = options.languages ?? Object.keys(dataset).sort();
  for (const language of languages) {
    if (!dataset[language]) throw new Error(`Unknown dataset language: ${language}`);
    for (const repo of selectStable(dataset[language], (r) => r.repo, options.reposPerLanguage, options.seed + language)) {
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo.repo)) throw new Error("Invalid repository identity");
      const id = `${language}/${repo.repo.replace("/", "--")}`;
      const directory = resolve(out, "repos", id);
      if (!directory.startsWith(out + sep)) throw new Error("Invalid output path");
      // Never merge a different snapshot into an existing working tree.
      const marker = resolve(directory, ".git", "s1s-snapshot");
      if (existsSync(directory) && (!existsSync(marker) || readFileSync(marker, "utf8") !== repo.commit_sha)) throw new Error(`Existing snapshot differs: ${directory}`);
      mkdirSync(directory, { recursive: true });
      for (const [path, text] of Object.entries(repo.content)) {
        if (!safeRelative(path) || typeof text !== "string") throw new Error("Unsafe dataset path/content");
        const file = resolve(directory, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text);
      }
      execFileSync("git", ["init", "-q", directory]);
      // Only dataset source files are tracked, NEVER descriptions or target metadata.
      execFileSync("git", ["-C", directory, "add", "-f", "--", ...Object.keys(repo.content)], { maxBuffer: 16 * 1024 * 1024 });
      writeFileSync(marker, repo.commit_sha);
      const needles = selectStable(repo.needles, (n) => `${n.path}:${n.start_line}:${n.name}`, options.queriesPerRepo, options.seed + repo.repo);
      const tasks = needles.map((needle, i) => {
        if (!(needle.path in repo.content) || !needle.description.trim()) throw new Error("Missing target/query in dataset");
        return { id: `${id}/${i}`, query: needle.description.trim(), relevant: [needle.path] };
      });
      manifest.corpora.push({ id, language, repo: repo.repo, revision: repo.commit_sha, directory, tasks });
    }
  }
  writeFileSync(resolve(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`Prepared ${manifest.corpora.length} source snapshots / ${manifest.corpora.reduce((n, c) => n + c.tasks.length, 0)} queries. Dataset SHA256 ${manifest.sha256}`);
  return manifest;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { out: { type: "string", default: ".cache/bench/repoqa" }, data: { type: "string" }, "repos-per-language": { type: "string", default: "1" }, "queries-per-repo": { type: "string", default: "5" }, seed: { type: "string", default: "s1s-retrieval-v1" }, languages: { type: "string" } } });
  const count = (value: string, max: number) => { const n = Number(value); if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(`Count must be 1–${max}`); return n; };
  await prepare({ out: values.out, data: values.data, reposPerLanguage: count(values["repos-per-language"], 10), queriesPerRepo: count(values["queries-per-repo"], 10), seed: values.seed, languages: values.languages?.split(",") });
}
