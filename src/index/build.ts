import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { readFileSync, lstatSync, realpathSync } from "node:fs";
import { join, relative, isAbsolute } from "node:path";
import { clip, extractFacts, factsText, type FileFacts } from "./facts.ts";
import { buildLex, rarity, type LexDoc, type LexIndex } from "./lex.ts";
import { signatureOf, type Signature } from "./signature.ts";
import { buildGraph, type CodeGraph } from "../graph/build.ts";
import { createResolver } from "../graph/resolve.ts";

/** One node of the repository tree, as served to the UI and used by the navigator. */
export type TreeNode = {
  name: string;
  /** Repo-relative path; "" for the root. */
  path: string;
  kind: "dir" | "file";
  /** Bytes; directories sum their subtree. */
  size: number;
  /** Files in the subtree (1 for a file). */
  files: number;
  lines?: number;
  /** Lowercase extension without the dot; "" when none. */
  ext?: string;
  /** What the unit exposes: exported and re-exported names (capped). */
  exports?: string[];
  /** The header comment / first heading, capped — for people (the treemap hover); TypeSafe reads `signature`. */
  hint?: string;
  /** Content-derived descriptor material: imports, declarations, calls, keys … ranked rarest-first (see signature.ts). */
  signature?: Signature;
  /**
   * Dir only: the subtree's vocabulary — words from every file and folder name beneath it,
   * ranked by (count here)² / (count in repo), so a word scores high when it is both frequent
   * here and concentrated here. What "is under here", for a model that only sees names.
   */
  themes?: string[];
  children?: TreeNode[];
};

export type RepoIndex = {
  repo: string;
  builtAt: string;
  buildMs: number;
  fileCount: number;
  root: TreeNode;
  byPath: Map<string, TreeNode>;
  /** Nouns for the questions (defaults to the repo vocabulary). */
  domain?: import("../questions.ts").Domain;
  /** The zero-call lexical index over every unit's path, facts and body. */
  lex: LexIndex;
  /** What the one content pass learned about each textual unit (the import graph is built from these). */
  facts: Map<string, FileFacts>;
  /** A unit's full text, for query-aware evidence; undefined when it is binary, huge or gone. */
  text: (path: string) => string | undefined;
  /** The import graph, built from `facts` on first use (see graphOf). */
  graph?: CodeGraph;
};

/** The unit-level import graph (barrels chased to the defining unit), built once per index on demand. */
export function graphOf(index: RepoIndex): CodeGraph {
  if (!index.graph) {
    const files = new Set([...index.byPath.values()].filter((n) => n.kind === "file").map((n) => n.path));
    index.graph = buildGraph(index.facts, createResolver({ files, readText: index.text }));
  }
  return index.graph;
}

/** Evidence for a leaf without a query to aim it: the file's head. */
export function evidenceFor(index: RepoIndex, path: string, n: number): string[] {
  return textHead(index.text(path) ?? "", n);
}

const TEXT_EXT = new Set([
  "ts", "tsx", "js", "mjs", "cjs", "jsx", "sql", "md", "mdx", "json", "py", "sh", "yml", "yaml",
  "prisma", "css", "html", "txt", "toml", "graphql", "proto", "env", "example", "csv", "xml", "dockerfile",
  "mts", "cts", "go", "rs", "rb", "java", "kt", "swift", "c", "h", "cc", "cpp", "hpp", "cs", "php", "lua", "scss", "vue", "svelte",
]);
/** Structured data, not code or prose: indexed by path and keys only. */
const DATA_EXT = new Set(["json", "yml", "yaml", "toml", "csv", "xml", "lock", "svg"]);
/** A data file with more keys than this is a dictionary / table, not configuration. */
const DICTIONARY_KEYS = 64;
const MAX_READ_BYTES = 2 * 1024 * 1024;
const EXPORTS_CAP = 12;
const HINT_CAP = 110;
const THEMES_MAX = 16;

/** Name words too generic to say anything about a subtree. */
const GENERIC_WORDS = new Set([
  "index", "types", "type", "utils", "util", "constants", "config", "readme", "package", "tsconfig", "main",
  "app", "page", "layout", "route", "routes", "schema", "migration", "migrations", "test", "tests", "spec",
  "mod", "lib", "src", "common", "shared", "helpers", "helper", "client", "server", "styles", "style",
  "globals", "loading", "error", "not", "found", "setup", "changelog", "license", "dockerfile", "makefile",
  "env", "example", "add", "create", "drop", "update", "remove", "rename", "alter", "table", "column",
  "columns", "new", "old", "the", "and", "for", "with", "from", "into", "use", "get", "set", "make",
  "json", "yaml", "yml", "lock", "gitignore", "npmrc", "md", "sql", "ts", "tsx", "js", "mjs", "py", "sh",
  "component", "components", "hook", "hooks", "service", "services", "handler", "handlers", "router", "routers",
  "data", "file", "files", "core", "base", "impl", "internal", "v1", "v2",
]);

export function listTracked(repo: string): string[] {
  const out = execFileSync("git", ["-C", repo, "ls-files", "-z"], { maxBuffer: 64 * 1024 * 1024 });
  return Buffer.from(out).toString("utf8").split("\0").filter(Boolean);
}

// ---- per-directory themes ----------------------------------------------------

/** "AuthBase.test.ts" → ["auth"]; "20250812_add_billing_wallet" → ["billing", "wallet"]. */
export function nameWords(name: string): string[] {
  const noExt = name.replace(/\.[^.]*$/, "").replace(/\.(test|spec|stories|d)$/i, "");
  return noExt
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !/^\d+$/.test(w) && !GENERIC_WORDS.has(w));
}

/** Top words by (count here)² / (count in repo). */
export function rankThemes(here: Map<string, number>, repo: Map<string, number>, cap = THEMES_MAX): string[] {
  return [...here.entries()]
    .map(([w, tf]) => ({ w, s: (tf * tf) / (repo.get(w) ?? tf) }))
    .sort((a, b) => b.s - a.s || a.w.localeCompare(b.w))
    .slice(0, cap)
    .map((x) => x.w);
}

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  if (i <= 0) return name.toLowerCase() === "dockerfile" ? "dockerfile" : "";
  return name.slice(i + 1).toLowerCase();
}

// ---- build ---------------------------------------------------------------------

export function buildIndex(repo: string): RepoIndex {
  const t0 = performance.now();
  const repoRoot = realpathSync(repo);
  const root: TreeNode = { name: "", path: "", kind: "dir", size: 0, files: 0, children: [] };
  const byPath = new Map<string, TreeNode>([["", root]]);
  const facts = new Map<string, FileFacts>();
  const texts = new Map<string, string>();
  let fileCount = 0;
  /** word → occurrences across every file and folder name in the repo. */
  const repoWords = new Map<string, number>();
  const countWords = (into: Map<string, number>, name: string) => {
    for (const w of nameWords(name)) into.set(w, (into.get(w) ?? 0) + 1);
  };

  /** Adds the file's node (and any missing ancestors) to the tree. */
  const place = (rel: string, size: number): TreeNode => {
    const parts = rel.split("/");
    let dir = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts.slice(0, i + 1).join("/");
      let next = byPath.get(p);
      if (!next) {
        next = { name: parts[i], path: p, kind: "dir", size: 0, files: 0, children: [] };
        byPath.set(p, next);
        dir.children!.push(next);
        countWords(repoWords, parts[i]);
      }
      dir = next;
    }
    const name = parts[parts.length - 1];
    countWords(repoWords, name);
    const node: TreeNode = { name, path: rel, kind: "file", size, files: 1, ext: extOf(name) };
    byPath.set(rel, node);
    dir.children!.push(node);
    fileCount++;
    return node;
  };

  // One streaming pass: each file is read once, reduced to facts, and handed to the lexical
  // index as it goes (buildLex pulls from this generator, so no file body outlives its turn).
  const units = function* (): Generator<LexDoc> {
    for (const rel of listTracked(repo)) {
      let size: number;
      try {
        const st = lstatSync(join(repo, rel));
        if (!st.isFile() || !contained(repoRoot, realpathSync(join(repo, rel)))) continue;
        size = st.size;
      } catch {
        continue; // tracked but deleted in the working tree
      }
      const node = place(rel, size);
      const ext = node.ext ?? "";
      const src = TEXT_EXT.has(ext) && size <= MAX_READ_BYTES && size > 0 ? readFileSync(join(repo, rel), "utf8") : "";
      if (src) texts.set(rel, src);
      if (!src) {
        yield { path: rel, sig: "", body: "" }; // still findable by its path
        continue;
      }
      node.lines = src.split("\n").length - (src.endsWith("\n") ? 1 : 0);
      const f = extractFacts(src, ext);
      facts.set(rel, f);
      const hint = ext === "md" || ext === "mdx" ? (f.headings[0] ?? f.about) : f.about;
      if (hint) node.hint = clip(hint, HINT_CAP);
      // Data files (locale bundles, lockfiles, fixtures) are found by their path and keys, never by
      // their bodies: a 150 KB translation table matches any English question. One with more keys
      // than a config file has is a table, and is found by its path alone.
      yield lexicalDoc(rel, ext, f, src);
    }
  };
  const lex = buildLex(units());

  // Signatures need the finished index: their lists lead with the repo's rarest words.
  const rare = (word: string) => rarity(lex, word);
  for (const [path, f] of facts) {
    const node = byPath.get(path)!;
    const signature = signatureOf(f, rare);
    if (Object.keys(signature).length) node.signature = signature;
    if (signature.exports?.length) node.exports = signature.exports.slice(0, EXPORTS_CAP);
  }

  /** Sorts, aggregates size/files, computes themes; returns the subtree's word counts. */
  const finalize = (n: TreeNode): Map<string, number> => {
    const words = new Map<string, number>();
    if (n.kind !== "dir") {
      countWords(words, n.name);
      return words;
    }
    n.children!.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1));
    n.size = 0;
    n.files = 0;
    for (const c of n.children!) {
      const sub = finalize(c);
      for (const [w, k] of sub) words.set(w, (words.get(w) ?? 0) + k);
      if (c.kind === "dir") countWords(words, c.name);
      n.size += c.size;
      n.files += c.files;
    }
    const themes = rankThemes(words, repoWords);
    if (themes.length) n.themes = themes;
    return words;
  };
  finalize(root);

  return { repo, builtAt: new Date().toISOString(), buildMs: performance.now() - t0, fileCount, root, byPath, lex, facts, text: (path) => texts.get(path) };
}

/** A tracked unit's full text; undefined when it is missing, too large to be source, or binary. */
export function readText(repo: string, rel: string): string | undefined {
  try {
    if (!rel || rel.includes("\0") || rel.includes("\\") || isAbsolute(rel) || rel.split("/").some(p => p === ".." || p === ".")) return undefined;
    const path = join(repo, rel);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > MAX_READ_BYTES || !contained(realpathSync(repo), realpathSync(path))) return undefined;
    const src = readFileSync(join(repo, rel), "utf8");
    return src.slice(0, 8192).includes("\0") ? undefined : src;
  } catch {
    return undefined;
  }
}

/** First `n` non-empty lines of a tracked file, each trimmed to `width` chars. */
export function headLines(repo: string, rel: string, n: number, width = 140): string[] {
  return textHead(readText(repo, rel) ?? "", n, width);
}

function textHead(src: string, n: number, width = 140): string[] {
  const out: string[] = [];
  for (const line of src.split("\n")) {
    const t = line.trimEnd();
    if (!t.trim()) continue;
    out.push(t.length > width ? t.slice(0, width - 1) + "…" : t);
    if (out.length >= n) break;
  }
  return out;
}

/** Every file node under `node` in tree order. */
export function filesUnder(node: TreeNode): TreeNode[] {
  const out: TreeNode[] = [];
  const walk = (n: TreeNode) => {
    if (n.kind === "file") out.push(n);
    else for (const c of n.children ?? []) walk(c);
  };
  walk(node);
  return out;
}

/** Identical field policy for fresh and hydrated lexical indexes. */
export function lexicalDoc(path: string, ext: string, facts: FileFacts | undefined, text: string): LexDoc {
  const data = DATA_EXT.has(ext);
  return { path, sig: !facts || (data && facts.keys.length > DICTIONARY_KEYS) ? "" : factsText(facts), body: data ? "" : text };
}

function contained(root: string, path: string): boolean {
  const rel = relative(root, path);
  return !!rel && rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
}
