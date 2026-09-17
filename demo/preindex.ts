import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { buildIndex } from "../src/index/build.ts";
import { serializeIndex } from "../src/index/snapshot.ts";
import { REPOSITORIES, type Catalog, type Repository } from "./catalog.ts";

// Clones are build inputs only. No repository-supplied code or package install runs.
const cache = resolve(process.env.S1S_REPO_CACHE ?? ".cache/repos");
const assets = resolve(".cache/demo/assets");
const snapshots = join(assets, "_snapshots");
mkdirSync(cache, { recursive: true });
rmSync(assets, { recursive: true, force: true });
mkdirSync(snapshots, { recursive: true });
for (const name of ["index.html", "app.html", "playground.html", "about.html", "search.js", "run-record.js", "app.js", "transport.js", "motion.js", "flow.js", "tailwind.css"]) {
  cpSync(join("ui", name), join(assets, name), { recursive: true });
}
const repos: Repository[] = [];
for (const repo of REPOSITORIES) {
  const dir = join(cache, repo.id);
  if (!existsSync(join(dir, ".git"))) execFileSync("git", ["clone", "--depth=1", "--", repo.url + ".git", dir], { stdio: "inherit" });
  const remote = execFileSync("git", ["-C", dir, "remote", "get-url", "origin"], { encoding: "utf8" }).trim().replace(/\.git$/, "");
  if (remote !== repo.url) throw new Error(`Refusing unexpected repository for ${repo.id}`);
  const revision = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const index = buildIndex(dir);
  const snapshot = serializeIndex(index, { revision, compressTexts: true });
  snapshot.repo = repo.url;
  snapshot.root.name = repo.name;
  const raw = JSON.stringify(snapshot);
  const bytes = Buffer.byteLength(raw);
  if (bytes > 48 * 1024 * 1024) throw new Error(`${repo.id} snapshot exceeds the demo memory budget (${bytes} bytes). Narrow the build input before deploying.`);
  const compressed = gzipSync(raw, { level: 9 });
  if (compressed.byteLength > 24 * 1024 * 1024) throw new Error(`${repo.id} snapshot exceeds the static asset size limit.`);
  writeFileSync(join(snapshots, `${repo.id}.json.gz`), compressed);
  const tree = { repo: repo.name, revision, builtAt: index.builtAt, buildMs: Math.round(index.buildMs), files: index.fileCount, domain: index.domain, root: snapshot.root };
  writeFileSync(join(snapshots, `${repo.id}.tree.json`), JSON.stringify(tree, (key, value) => key === "signature" ? undefined : value));
  // Preview reads load one small shard, never a full lexical index.
  const sourceShards = new Map<string, Record<string, { text?: string; node: unknown }>>();
  for (const [path, node] of index.byPath) {
    if (node.kind !== "file") continue;
    const shard = createHash("sha256").update(path).digest("hex").slice(0, 2);
    const records = sourceShards.get(shard) ?? {};
    records[path] = { text: index.text(path), node: { ...node, signature: undefined } };
    sourceShards.set(shard, records);
  }
  for (const [shard, records] of sourceShards) writeFileSync(join(snapshots, `${repo.id}.source-${shard}.json`), JSON.stringify(records));
  repos.push({ ...repo, revision, files: index.fileCount, snapshotBytes: bytes });
  console.log(`${repo.id}: ${index.fileCount} files, ${revision.slice(0, 12)}, ${(bytes / 1048576).toFixed(1)} MiB snapshot / ${(compressed.byteLength / 1048576).toFixed(1)} MiB gzip`);
}
// Cache identity follows executable engine source, not UI timestamps or repository HEAD.
function engineFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? engineFiles(join(directory, entry.name)) : entry.name.endsWith(".ts") ? [join(directory, entry.name)] : []).sort();
}
const engineRevision = createHash("sha256").update(JSON.stringify(engineFiles("src").map(path => [path, readFileSync(path, "utf8")]))).digest("hex");
const catalog: Catalog = { repos, defaultRepo: "opencode", engineRevision };
writeFileSync(join(snapshots, "catalog.json"), JSON.stringify(catalog));
// Verify the bundle has real app pages; a partial build must not publish a broken UI.
for (const page of ["index.html", "app.html", "about.html"]) {
  if (!existsSync(join(assets, page)) || !readFileSync(join(assets, page), "utf8").includes("<html")) throw new Error(`Missing demo page: ${page}`);
}
