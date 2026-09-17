/** SWE-bench Verified adapted to retrieval of pre-fix source files, never issue solving. */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { hash, safeRelative, selectStable, type Manifest } from "./prepare.ts";

export const DATASET = "princeton-nlp/SWE-bench_Verified";
export const REVISION = "c104f840cc67f8b6eec6f759ebc8b2693d585d4a";
const SOURCE = `https://huggingface.co/datasets/${DATASET}`;
const MAX_BYTES = 64 * 1024 * 1024;
export type Instance = { instance_id: string; repo: string; base_commit: string; problem_statement: string; patch: string; test_patch: string };
export type Git = (args: string[]) => string;
const git: Git = (args) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "submodule.recurse=false", "-c", "protocol.file.allow=never", "-c", "protocol.ext.allow=never", "-c", "filter.lfs.required=false", "-c", "filter.lfs.smudge=", "-c", "filter.lfs.process=", ...args], { encoding: "utf8", maxBuffer: MAX_BYTES, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
const validRepo = (repo: string) => /^[a-zA-Z0-9][\w.-]*\/[a-zA-Z0-9][\w.-]*$/.test(repo) && !repo.split("/").some((part) => part === "." || part === "..");
const validCommit = (commit: string) => /^[a-f0-9]{40}$/.test(commit);
function checkedPath(path: string): string {
  if (path === "/dev/null") return path;
  if (!safeRelative(path) || /^[a-zA-Z]:/.test(path) || /[\x00-\x1f\x7f]/.test(path)) throw new Error("Unsafe patch path");
  return path;
}

/** Git's core.quotePath format uses C escapes, including UTF-8 bytes in octal. */
export function decodePatchPath(value: string): string {
  let path: string;
  if (value.startsWith('"')) {
    const match = /^"((?:[^"\\]|\\.)*)"(?:\t.*)?$/.exec(value);
    if (!match) throw new Error("Malformed quoted patch path");
    const bytes: number[] = [];
    const raw = match[1];
    for (let i = 0; i < raw.length;) {
      if (raw[i] !== "\\") {
        const point = String.fromCodePoint(raw.codePointAt(i)!); bytes.push(...Buffer.from(point)); i += point.length; continue;
      }
      i++;
      const octal = /^[0-7]{1,3}/.exec(raw.slice(i));
      if (octal) { bytes.push(parseInt(octal[0], 8)); i += octal[0].length; continue; }
      const escapes: Record<string, string> = { "\\": "\\", '"': '"', t: "\t", n: "\n", r: "\r", a: "\x07", b: "\b", f: "\f", v: "\v" };
      if (!(raw[i] in escapes)) throw new Error("Unsupported patch path escape");
      bytes.push(...Buffer.from(escapes[raw[i++]]));
    }
    path = Buffer.from(bytes).toString("utf8");
  } else path = value.split("\t")[0];
  return checkedPath(path);
}

/** Old-side paths are the files visible in base_commit; added files have no target. */
export function patchBasePaths(patch: string): string[] {
  const paths = new Set<string>();
  let block: { fallback?: string; old?: string; rename?: string; hunk: boolean; added: boolean } | undefined;
  const flush = () => {
    if (!block || block.added) return;
    const path = block.rename ?? block.old ?? block.fallback;
    if (path && path !== "/dev/null") paths.add(path);
  };
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flush(); block = { hunk: false, added: false };
      const rest = line.slice(11);
      const first = rest.startsWith('"') ? /^"(?:[^"\\]|\\.)*"/.exec(rest)?.[0] : rest.slice(0, rest.lastIndexOf(" b/"));
      if (!first) throw new Error("Malformed git patch header");
      const old = decodePatchPath(first);
      if (!old.startsWith("a/")) throw new Error("Unsupported git patch prefix");
      block.fallback = checkedPath(old.slice(2));
      continue;
    }
    if (!block) { if (line.trim()) throw new Error("Expected a git patch header"); continue; }
    if (line.startsWith("@@") || line.startsWith("GIT binary patch") || line.startsWith("Binary files ")) block.hunk = true;
    if (block.hunk) continue;
    if (line.startsWith("new file mode ")) block.added = true;
    if (line.startsWith("rename from ") || line.startsWith("copy from ")) block.rename = decodePatchPath(line.slice(line.indexOf(" from ") + 6));
    if (line.startsWith("--- ")) {
      const old = decodePatchPath(line.slice(4));
      if (old === "/dev/null") { block.added = true; block.old = old; }
      else {
        if (!old.startsWith("a/")) throw new Error("Unsupported old-side patch prefix");
        block.old = checkedPath(old.slice(2));
      }
    }
  }
  flush();
  return [...paths].sort();
}

export function isTestPath(path: string): boolean {
  return /(^|\/)(tests|testing)(\/|$)/i.test(path) || /(^|\/)(test_[^/]*|[^/]*_test|conftest)\.py$/i.test(path);
}
export function relevantPaths(instance: Pick<Instance, "patch" | "test_patch">, baseFiles: ReadonlySet<string>): { relevant: string[]; excluded: { path: string; reason: string }[] } {
  const tests = new Set(patchBasePaths(instance.test_patch));
  const relevant: string[] = []; const excluded: { path: string; reason: string }[] = [];
  for (const path of patchBasePaths(instance.patch)) {
    const reason = !baseFiles.has(path) ? "not a regular file in base_commit" : isTestPath(path) || tests.has(path) ? "test file" : undefined;
    if (reason) excluded.push({ path, reason }); else relevant.push(path);
  }
  return { relevant, excluded };
}

export function verifyBase(directory: string, baseCommit: string, run: Git = git): void {
  if (!validCommit(baseCommit)) throw new Error("Invalid base_commit");
  if (run(["-C", directory, "rev-parse", "HEAD"]).trim() !== baseCommit) throw new Error("Checkout HEAD does not match base_commit");
  if (run(["-C", directory, "status", "--porcelain", "--untracked-files=all"]).trim()) throw new Error("Benchmark checkout is dirty; refusing contaminated source");
}

/** Fetch exactly the base SHA into a shared bare cache; each revision has its own checkout. */
export function checkoutBase(out: string, repo: string, baseCommit: string, run: Git = git): string {
  if (!validRepo(repo) || !validCommit(baseCommit)) throw new Error("Invalid repository or base_commit");
  const slug = repo.replace("/", "--");
  const remote = `https://github.com/${repo}.git`;
  const mirror = resolve(out, "git", `${slug}.git`);
  const directory = resolve(out, "repos", slug, baseCommit);
  mkdirSync(dirname(mirror), { recursive: true }); mkdirSync(dirname(directory), { recursive: true });
  if (!existsSync(mirror)) { run(["init", "--bare", "--quiet", mirror]); run(["--git-dir", mirror, "remote", "add", "origin", remote]); }
  if (run(["--git-dir", mirror, "rev-parse", "--is-bare-repository"]).trim() !== "true" || run(["--git-dir", mirror, "remote", "get-url", "origin"]).trim() !== remote) throw new Error("Existing source cache has unexpected repository identity");
  if (!existsSync(directory)) {
    run(["--git-dir", mirror, "fetch", "--no-tags", "--no-recurse-submodules", "--depth=1", "origin", baseCommit]);
    if (run(["--git-dir", mirror, "rev-parse", `${baseCommit}^{commit}`]).trim() !== baseCommit) throw new Error("Fetched commit differs from base_commit");
    run(["--git-dir", mirror, "worktree", "add", "--detach", directory, baseCommit]);
  }
  verifyBase(directory, baseCommit, run);
  return directory;
}

export function parseInstances(bytes: string): Instance[] {
  const trimmed = bytes.trim();
  const parsed: unknown = trimmed.startsWith("[") ? JSON.parse(trimmed) : trimmed.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  if (!Array.isArray(parsed) || !parsed.length || parsed.length > 10_000) throw new Error("Expected a nonempty SWE-bench JSON array or JSONL input");
  const ids = new Set<string>();
  return parsed.map((value: unknown) => {
    if (!value || typeof value !== "object") throw new Error("Invalid SWE-bench row");
    const row = value as Record<string, unknown>;
    if (!["instance_id", "repo", "base_commit", "problem_statement", "patch", "test_patch"].every((key) => typeof row[key] === "string")) throw new Error("Missing SWE-bench fields");
    const instance = row as Instance;
    if (!validRepo(instance.repo) || !validCommit(instance.base_commit) || !/^[\w.-]+$/.test(instance.instance_id) || !instance.problem_statement.trim() || ids.has(instance.instance_id)) throw new Error("Invalid SWE-bench identity, query or duplicate instance");
    ids.add(instance.instance_id);
    return instance;
  });
}

type Page = { offset: number; url: string; revision: string; sha256: string };
async function download(revision: string): Promise<{ rows: Instance[]; pages: Page[] }> {
  if (!validCommit(revision)) throw new Error("Dataset revision must be a full commit SHA");
  const rows: unknown[] = []; const pages: Page[] = []; let total = 1;
  for (let offset = 0; offset < total; offset += 100) {
    const url = new URL("https://datasets-server.huggingface.co/rows");
    url.search = new URLSearchParams({ dataset: DATASET, config: "default", split: "test", offset: String(offset), length: "100" }).toString();
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Dataset download failed: HTTP ${response.status}`);
    const actualRevision = response.headers.get("x-revision");
    if (actualRevision !== revision) throw new Error(`Dataset viewer revision differs from pinned revision (${actualRevision ?? "missing"}); provide a verified local export or explicitly select --revision.`);
    const text = await response.text(); if (Buffer.byteLength(text) > MAX_BYTES) throw new Error("Dataset page too large");
    const page = JSON.parse(text) as { num_rows_total: number; partial?: boolean; rows: { row_idx: number; row: unknown; truncated_cells: unknown[] }[] };
    if (!Number.isInteger(page.num_rows_total) || page.num_rows_total < 1 || page.num_rows_total > 10_000 || !Array.isArray(page.rows) || page.partial || (offset > 0 && page.num_rows_total !== total)) throw new Error("Unexpected or partial dataset response");
    total = page.num_rows_total;
    if (page.rows.length !== Math.min(100, total - offset) || page.rows.some((row, i) => row.row_idx !== offset + i || !Array.isArray(row.truncated_cells) || row.truncated_cells.length)) throw new Error("Incomplete, reordered or truncated dataset page");
    rows.push(...page.rows.map((row) => row.row)); pages.push({ offset, url: url.href, revision, sha256: hash(text) });
  }
  return { rows: parseInstances(JSON.stringify(rows)), pages };
}

export async function prepareSWE(options: { out: string; data?: string; count?: number; seed?: string; revision?: string }): Promise<Manifest> {
  const out = resolve(options.out); mkdirSync(out, { recursive: true });
  const seed = options.seed ?? "s1s-swebench-v1"; const count = options.count ?? 12;
  if (!Number.isInteger(count) || count < 1 || count > 500) throw new Error("count must be 1–500");
  const revision = options.revision ?? (options.data ? undefined : REVISION);
  let rows: Instance[]; let bytes: Buffer; let pages: Page[] = [];
  if (options.data) { bytes = readFileSync(options.data); if (bytes.length > MAX_BYTES) throw new Error("Dataset input too large"); rows = parseInstances(bytes.toString("utf8")); }
  else {
    const downloaded = await download(revision!); rows = downloaded.rows; pages = downloaded.pages;
    bytes = Buffer.from(JSON.stringify(rows)); writeFileSync(resolve(out, "dataset.json"), bytes);
  }
  if (count > rows.length) throw new Error("Requested sample is larger than dataset");
  // Selection depends only on instance IDs and seed. Gold is parsed only after freezing IDs.
  const selected = selectStable(rows, (row) => row.instance_id, count, seed);
  const sha256 = hash(bytes);
  const provenance = { dataset: DATASET, datasetRevision: revision ?? null, sourceVerified: !options.data, sha256, pages, seed, population: rows.length, selected: selected.map((row) => row.instance_id), excluded: [] as { id: string; reason: string; paths?: { path: string; reason: string }[] }[], included: [] as string[] };
  const source = revision ? `${SOURCE}/tree/${revision}` : "local JSON/JSONL export; upstream revision not verified";
  const manifest: Manifest = { schema: 1, dataset: "SWE-bench Verified", source, sha256, seed, task: "pre-fix file-localization adaptation; NOT SWE-bench issue-resolution or pass rate", corpora: [] };
  for (const row of selected) {
    const directory = checkoutBase(out, row.repo, row.base_commit);
    const files = new Set(git(["-C", directory, "ls-tree", "-r", "-z", "HEAD"]).split("\0").filter(Boolean).filter((entry) => /^(100644|100755) blob /.test(entry)).map((entry) => entry.slice(entry.indexOf("\t") + 1)));
    const labels = relevantPaths(row, files);
    if (!labels.relevant.length) { provenance.excluded.push({ id: row.instance_id, reason: "No modified preexisting non-test regular files", paths: labels.excluded }); continue; }
    provenance.included.push(row.instance_id);
    const id = `python/${row.repo.replace("/", "--")}/${row.base_commit}`;
    const corpus = manifest.corpora.find((item) => item.id === id);
    const task = { id: row.instance_id, query: row.problem_statement, relevant: labels.relevant };
    if (corpus) corpus.tasks.push(task);
    else manifest.corpora.push({ id, language: "python", repo: row.repo, revision: row.base_commit, directory, tasks: [task] });
  }
  writeFileSync(resolve(out, "provenance.json"), JSON.stringify(provenance, null, 2) + "\n");
  writeFileSync(resolve(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`SWE-bench: selected ${selected.length}, included ${provenance.included.length}, excluded ${provenance.excluded.length}; ${manifest.corpora.length} exact base-commit snapshots. SHA256 ${sha256}`);
  if (!manifest.corpora.length) throw new Error("Selected sample has no eligible localization tasks; exclusions recorded, no replacement sample chosen");
  return manifest;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { out: { type: "string", default: ".cache/bench/swebench" }, data: { type: "string" }, count: { type: "string", default: "12" }, seed: { type: "string", default: "s1s-swebench-v1" }, revision: { type: "string" } } });
  await prepareSWE({ out: values.out, data: values.data, count: Number(values.count), seed: values.seed, revision: values.revision });
}
