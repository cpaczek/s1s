// Module-specifier resolution without a compiler: relative probing, the NEAREST tsconfig's
// paths/baseUrl, workspace packages through their package.json, everything else external.
// Measured on cubby-law (3,603 code files, 18.3k import facts): every one of the 12,252
// file→file edges tsc's own resolver finds, in ~60 ms — why `typescript` stays a devDependency.
import { builtinModules } from "node:module";
import { posix } from "node:path";

export type Resolution = { kind: "file"; path: string } | { kind: "external"; pkg: string } | { kind: "unresolved" };

/** The filesystem as the resolver sees it: repo-relative paths, so tests need no disk. */
export type ResolverHost = { files: ReadonlySet<string>; readText(path: string): string | undefined };

/** Probe order for an extensionless specifier; the same list again under `/index`. */
const EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json", ".d.ts"];
/**
 * NodeNext code writes "./x.js" for "./x.ts", and package.json points at build output: the source spelling is
 * tried first, then the file as written (""), then a declaration file — a navigator wants the implementation
 * of a hand-written x.js, not the x.d.ts beside it.
 */
const SOURCE_OF: Record<string, string[]> = {
  ".js": [".ts", ".tsx", "", ".d.ts"], ".jsx": [".tsx"], ".mjs": [".mts", "", ".d.mts"], ".cjs": [".cts", "", ".d.cts"],
  ".d.ts": [".ts", ".tsx"], ".d.mts": [".mts"], ".d.cts": [".cts"],
};
/** Exactly the keys above, so probe() can never meet a built extension (".mjsx" once did) that has no source list. */
const BUILT_EXT = new RegExp(`(?:${Object.keys(SOURCE_OF).map((e) => e.replaceAll(".", "\\.")).join("|")})$`);
/** Where compiled output usually lives, and where its source usually does, when the package's tsconfig does not say. */
const OUT_DIRS = ["dist", "build", "lib", "out"];
const ROOT_DIRS = ["src", "."];
/** exports/imports conditions in the order we trust them; unknown ones ("production", "browser") keep their written order after these. */
const CONDITIONS = ["import", "types", "default", "require", "node"];
const MAX_EXTENDS = 4;
const BUILTINS = new Set(builtinModules);
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
/** "@scope/name/sub" | "name/sub" → [, name, "/sub"]. Aliases no rule mapped ("@/x", "~/x", "$lib/x") do not match, so they end up unresolved rather than external. */
const PACKAGE = /^((?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*)(\/.*)?$/i;

type TsConfig = {
  /** Repo-relative directory that bare specifiers may resolve against. */
  baseUrl?: string;
  /** pattern → repo-relative targets, the "*" still in. */
  paths?: Map<string, string[]>;
  outDir?: string;
  rootDir?: string;
};

const UNRESOLVED: Resolution = { kind: "unresolved" };
const found = (path: string | undefined): Resolution => (path === undefined ? UNRESOLVED : { kind: "file", path });
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === "string";
const dirOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf("/")));
const under = (dir: string, name: string): string => (dir ? `${dir}/${name}` : name);

/** `rel` seen from `dir`, normalised; undefined when it leaves the repo. */
function at(dir: string, rel: string): string | undefined {
  const p = posix.normalize(under(dir, rel)).replace(/\/$/, "");
  return p === "." ? "" : p === ".." || p.startsWith("../") || p.startsWith("/") ? undefined : p;
}

/**
 * JSON with comments and trailing commas (tsconfig's dialect); undefined when it still does not parse.
 * Strict JSON (every package.json) never reaches the scan; the scan is linear, since a big generated
 * manifest is not the place to spend seconds.
 */
export function parseJsonc(text: string): unknown {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  try {
    return JSON.parse(src);
  } catch {
    /* comments or trailing commas: scan */
  }
  const out: string[] = [];
  let comma = -1; // index in `out` of a comma nothing but whitespace or comments has followed
  for (let i = 0; i < src.length; ) {
    const c = src[i];
    if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') j += src[j] === "\\" ? 2 : 1;
      out.push(src.slice(i, j + 1));
      comma = -1;
      i = j + 1;
    } else if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? src.length : end + 2;
    } else {
      if (c === "}" || c === "]") {
        if (comma >= 0) out[comma] = ""; // a comma right before a closer is a trailing one
        comma = -1;
      } else if (c === ",") comma = out.length;
      else if (c !== " " && c !== "\n" && c !== "\r" && c !== "\t") comma = -1;
      out.push(c);
      i++;
    }
  }
  try {
    return JSON.parse(out.join(""));
  } catch {
    return undefined;
  }
}

/** "pre*post" against `s`: what the star captured, "" for an exact match, undefined for none. */
function capture(pattern: string, s: string): string | undefined {
  const i = pattern.indexOf("*");
  if (i < 0) return pattern === s ? "" : undefined;
  const pre = pattern.slice(0, i);
  const post = pattern.slice(i + 1);
  return s.length >= pre.length + post.length && s.startsWith(pre) && s.endsWith(post) ? s.slice(pre.length, s.length - post.length) : undefined;
}

/** The most specific pattern matching `s`, as tsc (paths) and node (exports) both pick it: exact beats star, a longer prefix beats a shorter one. */
function bestMatch(patterns: Iterable<string>, s: string): { pattern: string; star: string } | undefined {
  const rank = (p: string) => (p.includes("*") ? p.indexOf("*") : Infinity);
  let best: { pattern: string; star: string } | undefined;
  for (const pattern of patterns) {
    const star = capture(pattern, s);
    if (star !== undefined && (!best || rank(pattern) > rank(best.pattern))) best = { pattern, star };
  }
  return best;
}

/** Every path an exports/imports value could mean, preferred condition first; null (a blocked subpath) drops out. */
function conditionTargets(v: unknown): string[] {
  if (isString(v)) return [v];
  if (Array.isArray(v)) return v.flatMap(conditionTargets);
  if (!isRecord(v)) return [];
  const order = (k: string) => (CONDITIONS.includes(k) ? CONDITIONS.indexOf(k) : CONDITIONS.length);
  return Object.keys(v).sort((a, b) => order(a) - order(b)).flatMap((k) => conditionTargets(v[k]));
}

/** `key` looked up in an exports/imports map, the pattern's star substituted into every target. */
function mapTargets(map: Record<string, unknown>, key: string): string[] {
  const m = bestMatch(Object.keys(map), key);
  return m ? conditionTargets(map[m.pattern]).map((t) => t.replaceAll("*", () => m.star)) : []; // a function: "$$" in a route name is literal
}

/** Package-relative candidates for `sub` ("." or "./x"): "exports" when there is one, else types/module/main. */
function entryTargets(json: Record<string, unknown>, sub: string): string[] {
  const ex = json.exports;
  if (ex === undefined || ex === null) return sub === "." ? [json.types, json.typings, json.module, json.main].filter(isString) : [sub];
  return mapTargets(isRecord(ex) && Object.keys(ex).some((k) => k.startsWith(".")) ? ex : { ".": ex }, sub);
}

export function createResolver(host: ResolverHost): (from: string, spec: string) => Resolution {
  const { files } = host;

  /** The repo file `base` names: as a file (unless `dirOnly`), then as a directory's index. */
  const probe = (base: string | undefined, dirOnly = false): string | undefined => {
    if (base === undefined) return undefined;
    if (!dirOnly) {
      const built = base.match(BUILT_EXT)?.[0];
      if (built) for (const e of SOURCE_OF[built]) {
        const p = e ? base.slice(0, -built.length) + e : base;
        if (files.has(p)) return p;
      }
      if (files.has(base)) return base;
      if (base) for (const e of EXTS) if (files.has(base + e)) return base + e;
    }
    for (const e of EXTS) if (files.has(under(base, "index" + e))) return under(base, "index" + e);
    return undefined;
  };

  /** Nearest `name` at or above `dir`, remembered for every directory walked. */
  const nearestMemo = new Map<string, string | undefined>();
  const nearest = (dir: string, name: string): string | undefined => {
    const walked: string[] = [];
    let hit: string | undefined;
    for (let d = dir; ; d = dirOf(d)) {
      const key = `${name}\0${d}`;
      if (nearestMemo.has(key)) {
        hit = nearestMemo.get(key);
        break;
      }
      walked.push(key);
      if (files.has(under(d, name))) hit = under(d, name);
      if (hit !== undefined || !d) break;
    }
    for (const key of walked) nearestMemo.set(key, hit);
    return hit;
  };

  const manifests = new Map<string, Record<string, unknown> | undefined>();
  const manifest = (path: string): Record<string, unknown> | undefined => {
    if (!manifests.has(path)) {
      const json = parseJsonc(host.readText(path) ?? "");
      manifests.set(path, isRecord(json) ? json : undefined);
    }
    return manifests.get(path);
  };

  /** Every package.json with a "name" is a workspace package; the shallowest wins a name clash. */
  let packages: Map<string, { dir: string; json: Record<string, unknown> }> | undefined;
  const workspace = () => {
    if (packages) return packages;
    packages = new Map();
    const paths = [...files].filter((p) => p === "package.json" || p.endsWith("/package.json"));
    for (const path of paths.sort((a, b) => a.length - b.length || a.localeCompare(b))) {
      const json = manifest(path);
      if (json && isString(json.name) && !packages.has(json.name)) packages.set(json.name, { dir: dirOf(path), json });
    }
    return packages;
  };

  const configs = new Map<string, TsConfig | undefined>();
  const config = (path: string, depth = 0): TsConfig | undefined => {
    if (configs.has(path)) return configs.get(path);
    configs.set(path, undefined); // an `extends` loop reads this and stops
    const json = parseJsonc(host.readText(path) ?? "");
    if (!isRecord(json)) return undefined;
    const dir = dirOf(path);
    let cfg: TsConfig = {};
    for (const ext of depth < MAX_EXTENDS ? [json.extends].flat().filter(isString) : []) {
      const parent = extendsPath(dir, ext);
      if (parent) cfg = { ...cfg, ...config(parent, depth + 1) };
    }
    const co = isRecord(json.compilerOptions) ? json.compilerOptions : {};
    for (const k of ["baseUrl", "outDir", "rootDir"] as const) {
      const raw = co[k];
      const v = isString(raw) ? at(dir, raw) : undefined;
      if (v !== undefined) cfg[k] = v;
    }
    if (isRecord(co.paths)) {
      // tsc resolves targets against baseUrl when there is one, else against the config that wrote `paths`; a child's `paths` replaces its parent's.
      const base = cfg.baseUrl ?? dir;
      cfg.paths = new Map();
      for (const [pattern, targets] of Object.entries(co.paths)) {
        cfg.paths.set(pattern, (Array.isArray(targets) ? targets : []).filter(isString).map((t) => at(base, t)).filter(isString));
      }
    }
    configs.set(path, cfg);
    return cfg;
  };
  /** `extends`: a relative path, or a workspace package's config ("@repo/tsconfig/base.json"). */
  const extendsPath = (dir: string, ext: string): string | undefined => {
    const m = ext.startsWith(".") ? null : ext.match(PACKAGE);
    const pkg = m ? workspace().get(m[1]) : undefined;
    const base = m ? pkg && at(pkg.dir, m[2] ? "." + m[2] : "tsconfig.json") : at(dir, ext);
    return base === undefined ? undefined : [base, base + ".json", base + "/tsconfig.json"].find((p) => files.has(p));
  };
  const configFor = (dir: string): string | undefined => nearest(dir, "tsconfig.json") ?? nearest(dir, "jsconfig.json");

  /**
   * dist/foo.d.ts or dist/foo.js that is not in the repo → the source it is compiled from (outDir → rootDir,
   * per the package's own tsconfig). An entry naming the output directory itself ("main": "dist") is its index.
   */
  const invert = (pkgDir: string, target: string): string | undefined => {
    const stem = target.replace(BUILT_EXT, "");
    const cfg = files.has(under(pkgDir, "tsconfig.json")) ? config(under(pkgDir, "tsconfig.json")) : undefined;
    const outs = [cfg?.outDir, ...OUT_DIRS.map((d) => at(pkgDir, d))].filter(isString);
    const roots = [cfg?.rootDir, ...ROOT_DIRS.map((d) => at(pkgDir, d))].filter(isString);
    for (const out of outs) {
      if (stem !== out && !stem.startsWith(out + "/")) continue;
      for (const root of roots) {
        const hit = stem === out ? probe(root, true) : probe(at(root, stem.slice(out.length + 1)));
        if (hit) return hit;
      }
    }
    return undefined;
  };

  /** The first candidate that is a repo file as written; failing that, the first that inverts to one. */
  const firstFile = (pkgDir: string, targets: string[]): string | undefined => {
    const paths = targets.map((t) => at(pkgDir, t)).filter(isString);
    for (const p of paths) {
      const hit = probe(p);
      if (hit) return hit;
    }
    for (const p of paths) {
      const hit = invert(pkgDir, p);
      if (hit) return hit;
    }
    return undefined;
  };

  const external = (spec: string): Resolution => {
    if (SCHEME.test(spec)) return { kind: "external", pkg: spec.startsWith("node:") ? spec.split("/")[0] : spec };
    const name = spec.match(PACKAGE)?.[1];
    if (!name) return UNRESOLVED;
    return { kind: "external", pkg: BUILTINS.has(spec) || BUILTINS.has(name) ? `node:${name}` : name };
  };

  const resolveBare = (dir: string, spec: string): Resolution => {
    if (!spec || spec.startsWith("/")) return UNRESOLVED;
    if (SCHEME.test(spec)) return external(spec);
    const cfgPath = configFor(dir);
    const cfg = cfgPath ? config(cfgPath) : undefined;
    // tsc tries only the best-matching `paths` pattern, then baseUrl, then falls through to packages.
    const rule = cfg?.paths && bestMatch(cfg.paths.keys(), spec);
    if (rule) {
      for (const t of cfg?.paths?.get(rule.pattern) ?? []) {
        const hit = probe(t.replace("*", () => rule.star));
        if (hit) return found(hit);
      }
    }
    const viaBase = cfg?.baseUrl !== undefined ? probe(at(cfg.baseUrl, spec)) : undefined;
    if (viaBase) return found(viaBase);
    if (spec.startsWith("#")) return resolveHash(nearest(dir, "package.json"), spec);

    const m = spec.match(PACKAGE);
    const pkg = m ? workspace().get(m[1]) : undefined;
    // A rule matched but its target is missing (gitignored output): that is a gap to report, not an npm package.
    // The catch-all "*" maps packages too, so a miss there still falls through.
    if (!m || !pkg) return rule && rule.pattern !== "*" ? UNRESOLVED : external(spec);
    const sub = m[2] ? "." + m[2] : ".";
    // A subpath "exports" does not list is still a real dependency on the file it names; "." without any entry is node's index.
    return found(firstFile(pkg.dir, entryTargets(pkg.json, sub)) ?? probe(at(pkg.dir, sub), sub === "."));
  };

  /** "#internal/x": the "imports" of the package.json that scopes the importing file. */
  const resolveHash = (scope: string | undefined, spec: string): Resolution => {
    const imports = scope ? manifest(scope)?.imports : undefined;
    if (scope === undefined || !isRecord(imports)) return UNRESOLVED;
    const targets = mapTargets(imports, spec);
    const hit = firstFile(dirOf(scope), targets.filter((t) => t.startsWith(".")));
    const bare = targets.find((t) => !t.startsWith(".") && !t.startsWith("#"));
    return hit || !bare ? found(hit) : resolveBare(dirOf(scope), bare);
  };

  /** Python, best-effort: ".x" from the importing package; "a.b" from the importing directory upward, and from each `src/` on the way. */
  const resolvePython = (dir: string, spec: string): Resolution => {
    const dots = spec.match(/^\.*/)![0].length;
    const rest = spec.slice(dots).split(".").filter(Boolean).join("/");
    if (!dots && !rest) return UNRESOLVED;
    const bases: Array<string | undefined> = [];
    if (dots) bases.push(at(dir, "../".repeat(dots - 1) + (rest || ".")));
    else {
      for (let d = dir; ; d = dirOf(d)) {
        bases.push(at(d, rest), at(d, "src/" + rest));
        if (!d) break;
      }
    }
    for (const b of bases) {
      if (b === undefined) continue;
      const hit = [rest ? b + ".py" : "", under(b, "__init__.py")].find((p) => files.has(p));
      if (hit) return found(hit);
    }
    return dots || !rest ? UNRESOLVED : { kind: "external", pkg: spec.split(".")[0] };
  };

  // Relative specs depend on the importing directory; bare ones only on its nearest tsconfig (and "#x" on its package.json),
  // which is what makes the cache hit: "react" from 900 directories of one app is one entry.
  const cache = new Map<string, Resolution>();
  return (from, raw) => {
    const dir = dirOf(from);
    const python = /\.pyi?$/.test(from);
    const spec = python ? raw : raw.replace(/(?!^)[?#].*$/, ""); // "./icon.svg?react"
    const relative = python || /^\.\.?(\/|$)/.test(spec);
    const scope = relative ? dir : `${configFor(dir) ?? ""}\0${spec.startsWith("#") ? (nearest(dir, "package.json") ?? "") : ""}`;
    const key = `${python ? "py" : relative ? "rel" : "bare"}\0${scope}\0${spec}`;
    let r = cache.get(key);
    if (!r) {
      // ".", "..", "./x/" name a directory, never a file beside it, for tsc and node alike.
      r = python ? resolvePython(dir, spec) : relative ? found(probe(at(dir, spec), /^\.\.?$|\/\.{0,2}$/.test(spec))) : resolveBare(dir, spec);
      cache.set(key, r);
    }
    return r;
  };
}
