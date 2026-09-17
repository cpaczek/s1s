// The compact, budgeted view of a leaf's facts: what one TypeSafe Choice option or shortlist
// candidate shows. signatureOf() ranks and caps once, at index time; fillDescriptor() spends a
// token budget on the result per question, in tiers — the ORDER of the tiers decides what survives.
import { clip } from "./facts.ts";
import type { FileFacts } from "./facts.ts";

export type Signature = {
  about?: string;
  exports?: string[];
  /** Package specifier → imported names, as the package exports them. */
  imports?: Record<string, string[]>;
  /** Relative / aliased imports, as basenames. */
  local?: string[];
  /** Declarations that are not exported. */
  decls?: string[];
  calls?: string[];
  strings?: string[];
  headings?: string[];
  keys?: string[];
  tables?: string[];
};

/**
 * Descriptor budgets and caps. CHARS_PER_TOKEN was calibrated against 22 logged request bodies
 * (3.67–3.68 JSON chars per input token); ABOUT_SHORT + EXPORTS are today's descriptor.
 */
export const DESCRIPTOR = {
  OPTION_TOKENS: 160,
  MIN_OPTION_TOKENS: 45,
  CHOICE_BUDGET: 12000,
  CHARS_PER_TOKEN: 3.68,
  ABOUT_SHORT: 110,
  ABOUT_LONG: 240,
  EXPORTS: 8,
  IMPORT_PACKAGES: 6,
  IMPORT_NAMES: 4,
  LISTS: 10,
  CALLS: 8,
  STRINGS: 5,
  LOCAL: 6,
} as const;

/** Hard caps of a stored signature: roomy enough that the fill still has a choice, small enough that a node stays small. */
const STORED = { LIST: 24, PACKAGES: 12, NAMES: 8, ABOUT: 320 } as const;
/** Shorter forms of `about` to try before giving it up / longer ones to try before settling. */
const ABOUT_SHRINK = [DESCRIPTOR.ABOUT_SHORT, 80, 50];
const ABOUT_GROW = [DESCRIPTOR.ABOUT_LONG, 200, 160, 130];

/** "getSessionFromCtx" → get session from ctx; "better-auth/plugins" → better auth plugins; "HTTPServer" → http server. */
export function identWords(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !/^\d+$/.test(w));
}

const isLocal = (spec: string): boolean => spec.startsWith(".") || spec.startsWith("@/") || spec.startsWith("~/");

/** "./auth-base" → auth-base; "../lib/foo/index.ts" → foo; "@/components/ui/button" → button; Python's ".models.user" → user. */
function localName(spec: string): string | undefined {
  if (/^\.+[\w.]*$/.test(spec) && !/^\.\.?$/.test(spec)) return spec.split(".").filter(Boolean).pop();
  const parts = spec.replace(/\.(?:[cm]?[jt]sx?|json|s?css|svg|png|mdx?)$/i, "").split("/").filter((p) => p && !/^(?:\.\.?|@|~)$/.test(p));
  while (parts.length > 1 && parts[parts.length - 1] === "index") parts.pop();
  const last = parts.pop();
  return last && last !== "index" ? last : undefined;
}

/**
 * The signature of one leaf. With `rarity` (word → higher = rarer, e.g. the lexical index's idf over
 * lowercase words) the lists whose tail gets cut — calls, strings, decls, keys, import packages and
 * their names — lead with the identifier whose RAREST word is rarest; without it they keep source
 * order. Exports, headings, tables and local stay in source order: that order is information.
 */
export function signatureOf(facts: FileFacts, rarity?: (word: string) => number): Signature {
  const score = (s: string): number => Math.max(0, ...identWords(s).map((w) => (rarity ? rarity(w) : 0) || 0));
  const ranked = <T>(items: T[], words: (item: T) => string[]): T[] =>
    rarity
      ? items
          .map((item, i) => ({ item, i, r: Math.max(0, ...words(item).map(score)) }))
          .sort((a, b) => b.r - a.r || a.i - b.i)
          .map((x) => x.item)
      : items;
  const byRarity = (items: string[]): string[] => ranked(items, (s) => [s]);

  // What the file exposes: its exported declarations and what it re-exports, as one list in source order.
  const exposed = [
    ...facts.decls.filter((d) => d.exported && d.name !== "default"),
    ...facts.imports.filter((i) => i.how === "reexport").flatMap((i) => (i.as ?? i.names).filter((n) => n !== "*" && n !== "default").map((name) => ({ name, line: i.line }))),
  ].sort((a, b) => a.line - b.line);
  const declared = new Set(facts.decls.map((d) => d.name));

  const packages = new Map<string, Set<string>>();
  const local: string[] = [];
  for (const i of facts.imports) {
    if (isLocal(i.spec)) {
      const name = localName(i.spec);
      if (name) local.push(name);
      continue;
    }
    const names = packages.get(i.spec) ?? new Set<string>();
    packages.set(i.spec, names);
    for (const n of i.names) if (n !== "default" && n !== "*") names.add(n); // a default import is named by its package
  }
  // A package ranks by the rarest word in its specifier OR its names: `better-auth/plugins` matters because of `jwt`.
  const imports = ranked([...packages], ([spec, names]) => [spec, ...names])
    .slice(0, STORED.PACKAGES)
    .map(([spec, names]): [string, string[]] => [spec, byRarity([...names]).slice(0, STORED.NAMES)]);

  const list = (items: string[]): string[] | undefined => (items.length ? [...new Set(items)].slice(0, STORED.LIST) : undefined);
  const fields: Signature = {
    about: facts.about ? clip(facts.about, STORED.ABOUT) : undefined,
    exports: list(exposed.map((d) => d.name)),
    imports: imports.length ? Object.fromEntries(imports) : undefined,
    local: list(local),
    decls: list(byRarity(facts.decls.filter((d) => !d.exported).map((d) => d.name))),
    calls: list(byRarity(facts.calls.filter((c) => !declared.has(c)))), // its own functions are listed once already
    strings: list(byRarity(facts.strings)),
    headings: list(facts.headings),
    keys: list(byRarity(facts.keys)),
    tables: list(facts.tables),
  };
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)); // empty fields are omitted, not undefined
}

/** Input tokens a value costs once it is JSON in a request. */
export function estimateTokens(v: unknown): number {
  return Math.ceil((JSON.stringify(v) ?? "").length / DESCRIPTOR.CHARS_PER_TOKEN);
}

/** Tokens one option may spend: a directory with many children gets shorter options, never unreadable ones. */
export function optionBudget(children: number): number {
  const share = Math.floor(DESCRIPTOR.CHOICE_BUDGET / Math.max(1, children));
  return Math.max(DESCRIPTOR.MIN_OPTION_TOKENS, Math.min(DESCRIPTOR.OPTION_TOKENS, share));
}

/**
 * `imports` when the budget is too tight for `{package: names}`: one word list, every package's
 * first (rarest) name before any package's second. A bare package name leads its names — "svix"
 * says more than "Webhook" — a path-like specifier trails them, and one whose words its names
 * already carry ("better-auth" next to betterAuth) is dropped.
 */
function flatImports(packages: Array<{ spec: string; names: string[] }>): string[] {
  const lists = packages.map(({ spec, names }) => {
    const carried = new Set(names.flatMap(identWords));
    const specWords = identWords(spec);
    if (names.length && specWords.length && specWords.every((w) => carried.has(w))) return names;
    return spec.includes("/") ? [...names, spec] : [spec, ...names];
  });
  const words: string[] = [];
  for (let round = 0; lists.some((l) => round < l.length); round++) for (const l of lists) if (round < l.length) words.push(l[round]);
  return [...new Set(words)];
}

/**
 * `base` plus as much of the signature as `budgetTokens` allows, in tiers:
 *   1. about (≤ ABOUT_SHORT) and exports — today's descriptor;
 *   2. what the file is built from and made of — imports with their names, then headings / keys /
 *      tables (and decls, for a script that exports nothing) — then the rest of the author's comment;
 *   3. the rarest calls, strings and sibling imports (and decls).
 * A field, or a shorter form of it, is added only while the whole descriptor stays within budget.
 * Keys `base` already has are the caller's and are never touched; keys are appended in one fixed
 * order, so the same input always gives the same JSON. No signature → `base`, unchanged.
 */
export function fillDescriptor(base: Record<string, unknown>, sig: Signature | undefined, budgetTokens: number = DESCRIPTOR.OPTION_TOKENS): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  if (!sig) return out;
  const D = DESCRIPTOR;
  const max = Math.floor(budgetTokens * D.CHARS_PER_TOKEN);
  const size = (v: unknown): number => JSON.stringify(v).length;
  let used = size(out);
  /** Chars that `"key":value` adds to the JSON, its comma included. */
  const pair = (key: string, valueChars: number): number => (Object.keys(out).length ? 1 : 0) + size(key) + 1 + valueChars;
  /** Adds as many of `items` as fit, in order, up to `cap`; one that does not fit is passed over for a shorter one further on. */
  const addList = (key: string, items: string[] | undefined, cap: number, skip?: Set<string>): void => {
    if (!items?.length || key in out) return;
    const kept: string[] = [];
    let cost = pair(key, 2);
    for (const item of items) {
      if (kept.length >= cap) break;
      const c = size(item) + (kept.length ? 1 : 0);
      if (skip?.has(item) || used + cost + c > max) continue;
      kept.push(item);
      cost += c;
    }
    if (!kept.length) return;
    out[key] = kept;
    used += cost;
  };

  // tier 1
  let about: string | undefined;
  if (sig.about && !("about" in out)) {
    about = ABOUT_SHRINK.map((cap) => clip(sig.about!, cap)).find((text) => used + pair("about", size(text)) <= max);
    if (about !== undefined) {
      used += pair("about", size(about));
      out.about = about;
    }
  }
  addList("exports", sig.exports, D.EXPORTS);

  // tier 2
  const packages = Object.entries(sig.imports ?? {})
    .slice(0, D.IMPORT_PACKAGES)
    .map(([spec, names]) => ({ spec, names: names.slice(0, D.IMPORT_NAMES) }));
  if (packages.length && !("imports" in out)) {
    // Every package with its first name, or the grouped form is not worth its specifiers; further names round by round.
    const shown: Record<string, string[]> = {};
    let cost = pair("imports", 2);
    packages.forEach((p, i) => {
      shown[p.spec] = p.names.slice(0, 1);
      cost += (i ? 1 : 0) + size(p.spec) + 1 + size(shown[p.spec]);
    });
    if (used + cost <= max) {
      for (let round = 1; round < D.IMPORT_NAMES; round++) {
        for (const p of packages) {
          const name = p.names[round];
          if (name === undefined || used + cost + size(name) + 1 > max) continue;
          shown[p.spec].push(name);
          cost += size(name) + 1;
        }
      }
      out.imports = shown;
      used += cost;
    } else addList("imports", flatImports(packages), D.LISTS);
  }
  addList("headings", sig.headings, D.LISTS);
  addList("keys", sig.keys, D.LISTS);
  addList("tables", sig.tables, D.LISTS);
  if (!sig.exports?.length) addList("decls", sig.decls, D.LISTS); // a script's functions are what it is made of
  if (about !== undefined && sig.about) {
    const shown = about;
    const longer = ABOUT_GROW.map((cap) => clip(sig.about!, cap)).find((text) => text.length > shown.length && used + size(text) - size(shown) <= max);
    if (longer !== undefined) {
      used += size(longer) - size(shown);
      out.about = longer; // same key, same place
    }
  }

  // tier 3
  const imported = Array.isArray(out.imports) ? out.imports : Object.values((out.imports as Record<string, string[]> | undefined) ?? {}).flat();
  const visible = new Set<string>([...(Array.isArray(out.exports) ? out.exports : []), ...imported]);
  addList("calls", sig.calls, D.CALLS, visible); // not what the exports and imports above already say
  addList("strings", sig.strings, D.STRINGS);
  addList("local", sig.local, D.LOCAL);
  addList("decls", sig.decls, D.LISTS);
  return out;
}
