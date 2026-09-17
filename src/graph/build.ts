// The file-level import graph that `trace` expands over, derived from the facts map alone.
// Named imports are chased through barrels so an edge lands on the file that DEFINES the
// name: packages/db/src/index.ts otherwise absorbs 470 importers and hides what each uses.
import type { FileFacts, ImportFact } from "../index/facts.ts";
import type { Resolution } from "./resolve.ts";

export type GraphEdge = {
  from: string;
  to: string;
  /** What `from` takes, as `to` exports it ("default", "*", or a name); empty for side-effect and dynamic imports. */
  names: string[];
  /** True only when every import merged into this edge is type-only. */
  typeOnly: boolean;
  /** The strongest way `from` reaches `to`: import > require > dynamic > reexport. */
  how: ImportFact["how"];
  /** 1-based line of the first statement behind this edge. */
  line: number;
  /** The barrel the import statement actually named, when the edge was re-targeted past it. */
  via?: string;
};

export type ExternalUse = { pkg: string; spec: string; names: string[]; line: number };

export type CodeGraph = {
  /** Every file with facts or an edge, sorted. */
  files: string[];
  /** importer → its edges, one per imported file, in source order. Files without edges have no entry. */
  out: Map<string, GraphEdge[]>;
  /** imported file → the edges reaching it, by importer. */
  in: Map<string, GraphEdge[]>;
  /** importer → the packages it uses, one entry per specifier. */
  external: Map<string, ExternalUse[]>;
  unresolved: Array<{ from: string; spec: string }>;
  buildMs: number;
};

export type GraphOptions = {
  /** Default true. False leaves every edge on the file its specifier resolved to (the before-picture when measuring). */
  chaseBarrels?: boolean;
};

/** Re-export hops followed before giving up; real chains are 2–3 deep, a longer one is a lattice not worth the walk. */
const MAX_CHASE = 8;
const HOW_RANK: Record<ImportFact["how"], number> = { import: 0, require: 1, dynamic: 2, reexport: 3 };

type Definition = { file: string; name: string };
/** Code-unit order, the same as `sort()` gives `files` (and far cheaper than localeCompare over 12k edges). */
const order = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function buildGraph(
  facts: ReadonlyMap<string, FileFacts>,
  resolve: (from: string, spec: string) => Resolution,
  options: GraphOptions = {},
): CodeGraph {
  const t0 = performance.now();
  const chase = options.chaseBarrels ?? true;

  const fileOf = (from: string, spec: string): string | undefined => {
    const r = resolve(from, spec);
    return r.kind === "file" ? r.path : undefined;
  };

  const declared = new Map<string, Set<string>>();
  const declares = (file: string, name: string): boolean => {
    let names = declared.get(file);
    if (!names) declared.set(file, (names = new Set(facts.get(file)?.decls.filter((d) => d.exported).map((d) => d.name))));
    return names.has(name);
  };

  /**
   * Where `name`, as `file` exports it, is declared. `trail` (key → depth) is the chain being followed:
   * it is the cycle guard and the depth limit, and `cuts` counts the times either fired. An answer is
   * memoised under the depth it was asked at, so the limit cuts the same chain the same way for every
   * asker, and only when no cycle cut beneath it reached an ancestor on the trail (`low`, the shallowest
   * depth such a cut hit): that answer depends on who asked first, and a memo would hand it to everyone.
   */
  type Chase = { trail: Map<string, number>; cuts: number; low: number };
  const definitions = new Map<string, Definition | undefined>();
  const definition = (file: string, name: string, chase: Chase): Definition | undefined => {
    const key = `${file}\0${name}`;
    const depth = chase.trail.size;
    const memo = `${key}\0${depth}`;
    if (definitions.has(memo)) return definitions.get(memo);
    const f = facts.get(file);
    if (!f) return undefined;
    const above = chase.trail.get(key);
    if (above !== undefined || depth >= MAX_CHASE) {
      chase.cuts++;
      if (above !== undefined) chase.low = Math.min(chase.low, above);
      return undefined;
    }
    chase.trail.set(key, depth);
    const outerLow = chase.low;
    chase.low = Infinity;
    const hit = ((): Definition | undefined => {
      const reexports = f.imports.filter((i) => i.how === "reexport");
      // An explicit `export { a as name } from` is unambiguous; it also outranks a decl, because a
      // regex extractor may list the re-exported name as one.
      for (const imp of reexports) {
        const i = (imp.as ?? imp.names).indexOf(name);
        if (i < 0) continue;
        const to = fileOf(file, imp.spec);
        if (!to) return { file, name }; // re-exported from a package: the barrel is as far as the repo goes
        if (imp.names[i] === "*") return { file: to, name: "*" }; // `export * as ns from`: the namespace IS that file
        return follow(to, imp.names[i], chase);
      }
      if (declares(file, name)) return { file, name };
      if (name === "default") return undefined; // neither route below can carry a default export
      for (const imp of reexports) {
        if (imp.as || !imp.names.includes("*")) continue;
        const to = fileOf(file, imp.spec);
        const found = to ? definition(to, name, chase) : undefined;
        if (found) return found;
      }
      // `import { x } from "./x"; export { x };` — the export list is no decl, so the import is the lead
      // that is left. It comes after the stars because facts carry no local export list: an import that a
      // star also covers may be private to the barrel, and then the star is what consumers really get.
      const imported = f.imports.find((i) => i.how === "import" && i.names.includes(name));
      if (!imported) return undefined;
      const to = fileOf(file, imported.spec);
      return to ? follow(to, name, chase) : { file, name };
    })();
    chase.trail.delete(key);
    if (chase.low >= depth) definitions.set(memo, hit);
    chase.low = Math.min(outerLow, chase.low);
    return hit;
  };
  /** `name` as defined through `to`, else `to` itself — unless the chase was cut there, when `to` is not known to define it at all. */
  const follow = (to: string, name: string, chase: Chase): Definition | undefined => {
    const cuts = chase.cuts;
    return definition(to, name, chase) ?? (chase.cuts === cuts ? { file: to, name } : undefined);
  };

  const edges = new Map<string, GraphEdge>();
  const addEdge = (e: GraphEdge) => {
    const key = `${e.from}\0${e.to}`;
    const old = edges.get(key);
    if (!old) return void edges.set(key, e);
    for (const n of e.names) if (!old.names.includes(n)) old.names.push(n);
    old.typeOnly &&= e.typeOnly;
    if (HOW_RANK[e.how] < HOW_RANK[old.how]) old.how = e.how;
    old.line = Math.min(old.line, e.line);
    if (!e.via) delete old.via; // a direct import makes the barrel route a footnote
  };

  const externals = new Map<string, ExternalUse>();
  const unresolved = new Map<string, { from: string; spec: string }>();

  for (const [from, f] of facts) {
    for (const imp of f.imports) {
      const r = resolve(from, imp.spec);
      const key = `${from}\0${imp.spec}`;
      if (r.kind === "unresolved") {
        unresolved.set(key, { from, spec: imp.spec });
      } else if (r.kind === "external") {
        const old = externals.get(key);
        if (!old) externals.set(key, { pkg: r.pkg, spec: imp.spec, names: [...imp.names], line: imp.line });
        else for (const n of imp.names) if (!old.names.includes(n)) old.names.push(n);
      } else {
        // One statement becomes one edge per file its names really live in; what cannot be chased stays on the resolved file.
        const landing = new Map<string, string[]>(imp.names.length ? [] : [[r.path, []]]);
        for (const name of imp.names) {
          const def = chase && name !== "*" ? definition(r.path, name, { trail: new Map(), cuts: 0, low: Infinity }) : undefined;
          const land = def && def.file !== from ? def : { file: r.path, name };
          landing.set(land.file, [...(landing.get(land.file) ?? []), land.name]);
        }
        for (const [to, names] of landing) {
          if (to === from) continue;
          addEdge({ from, to, names: [...new Set(names)], typeOnly: imp.typeOnly, how: imp.how, line: imp.line, ...(to === r.path ? {} : { via: r.path }) });
        }
      }
    }
  }

  const out: CodeGraph["out"] = new Map();
  const into: CodeGraph["in"] = new Map();
  const external: CodeGraph["external"] = new Map();
  const push = <T>(m: Map<string, T[]>, k: string, v: T) => {
    const list = m.get(k);
    if (list) list.push(v);
    else m.set(k, [v]);
  };
  const sorted = [...edges.values()].sort((a, b) => order(a.from, b.from) || a.line - b.line || order(a.to, b.to));
  for (const e of sorted) push(out, e.from, e);
  for (const e of sorted) push(into, e.to, e);
  for (const [key, use] of externals) push(external, key.slice(0, key.indexOf("\0")), use);
  const files = [...new Set([...facts.keys(), ...into.keys()])].sort();

  return { files, out, in: into, external, unresolved: [...unresolved.values()], buildMs: performance.now() - t0 };
}

/** Files one import away, deduplicated: imported (`out`), importing (`in`), or both with imports first. */
export function neighbours(graph: CodeGraph, path: string, dir: "out" | "in" | "both"): string[] {
  const outs = dir === "in" ? [] : (graph.out.get(path) ?? []).map((e) => e.to);
  const ins = dir === "out" ? [] : (graph.in.get(path) ?? []).map((e) => e.from);
  return [...new Set([...outs, ...ins])];
}

/** How many files import `path` — the trace's hub test. */
export function fanIn(graph: CodeGraph, path: string): number {
  return graph.in.get(path)?.length ?? 0;
}

export function fanOut(graph: CodeGraph, path: string): number {
  return graph.out.get(path)?.length ?? 0;
}

/**
 * Who imports a package, and optionally one name from it: `externalUsers(g, "better-auth/plugins", "jwt")`.
 * `pkg` is a package name ("better-auth") or a specifier ("better-auth/plugins", which also covers deeper subpaths).
 */
export function externalUsers(graph: CodeGraph, pkg: string, name?: string): Array<ExternalUse & { file: string }> {
  const users: Array<ExternalUse & { file: string }> = [];
  for (const [file, uses] of graph.external) {
    for (const u of uses) {
      if (u.pkg !== pkg && u.spec !== pkg && !u.spec.startsWith(pkg + "/")) continue;
      if (name === undefined || u.names.includes(name)) users.push({ file, ...u });
    }
  }
  return users.sort((a, b) => order(a.file, b.file) || a.line - b.line);
}
