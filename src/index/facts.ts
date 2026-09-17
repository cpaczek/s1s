// THE one per-file content pass. A leaf's text is read once and reduced to FileFacts;
// the option descriptor (signature.ts), the lexical index (lex.ts) and the import
// graph (graph/) all derive from these facts — nothing else parses file contents.

/** A top-level declaration. */
export type Decl = {
  name: string;
  /** "const" | "function" | "class" | "type" | "interface" | "enum" | "def" | "model" | … as written. */
  kind: string;
  exported: boolean;
  /** 1-based line of the declaration. */
  line: number;
};

/** One import / re-export / require / dynamic import, as written. */
export type ImportFact = {
  /** The specifier exactly as written: "./auth-base", "@scope/pkg", "better-auth/plugins". */
  spec: string;
  /** Names as the TARGET exports them ("default", "*", or the name before `as`). Empty for side-effect and dynamic imports. */
  names: string[];
  /**
   * OPTIONAL, renaming re-exports only: what THIS file exposes each of `names` as, in parallel
   * (`export { a as b } from` → names ["a"], as ["b"]; `export * as ns from` → ["*"] / ["ns"]).
   * Absent = exposed under `names`. The graph's barrel chase reads it; nothing else needs it.
   */
  as?: string[];
  /** `reexport` = `export … from "spec"` (names ["*"] for `export * from`). */
  how: "import" | "reexport" | "dynamic" | "require";
  typeOnly: boolean;
  /** 1-based line. */
  line: number;
};

/** Everything content-derived that is known about one leaf. Arrays are in source order, deduplicated, uncapped. */
export type FileFacts = {
  /** The header comment (code, config, scripts, sql) or the first paragraph (prose), flattened to one line. */
  about?: string;
  decls: Decl[];
  imports: ImportFact[];
  /** Called identifiers (code): `foo(` but not `.foo(`, keywords and test-framework globals excluded. */
  calls: string[];
  /** Short string literals that look like names: routes, header names, env vars, event names. */
  strings: string[];
  /** Markdown H1–H3. */
  headings: string[];
  /** Config keys: top-level plus one nested level, dotted ("scripts.build"). */
  keys: string[];
  /** SQL tables / prisma models and enums. */
  tables: string[];
};

export function emptyFacts(): FileFacts {
  return { decls: [], imports: [], calls: [], strings: [], headings: [], keys: [], tables: [] };
}

// ---- extraction ----------------------------------------------------------------
// Regexes over a masked copy of the text, no parser and no dependency. An AST extractor can
// fill the same types later; until then every rule here prefers missing a fact to inventing one.

/** The header comment is kept this long here; the descriptor (signature.ts) clips it further. */
export const ABOUT_CAP = 900;
/** Longer lines are minified blobs: no calls or strings are read from them. */
const LINE_CAP = 400;
/** Safety only — facts are otherwise uncapped — so one generated 2 MiB file cannot balloon the index. */
const LIST_CAP = 2000;
const BINARY_PROBE = 8192;
const HEADER_LINES = 400;
/** How far below the top a config file's first comment block may sit and still describe the file. */
const CONFIG_COMMENT_WITHIN = 25;
const STRING_MIN = 3;
const STRING_MAX = 64;

/** A match or slice of 13+ chars is a view that pins its whole source text in V8, and facts outlive the text: copy it. */
const own = (s: string): string => (s.length < 13 ? s : (JSON.parse(JSON.stringify(s)) as string));

/** Source order, deduplicated, detached from the source text. */
function uniq(items: Iterable<string>): string[] {
  const seen = new Set<string>();
  for (const s of items) {
    if (seen.size >= LIST_CAP) break;
    if (s && !seen.has(s)) seen.add(own(s));
  }
  return [...seen];
}

/** Cuts at a word boundary (unless that gives up more than 24 chars) so the result, ellipsis included, is at most `cap` chars. */
export function clip(text: string, cap: number): string {
  if (text.length <= cap) return text;
  const space = text.lastIndexOf(" ", cap - 1);
  return text.slice(0, space > 0 && space >= cap - 24 ? space : cap - 1).trimEnd() + "…";
}

/** One flattened line, or undefined when no prose is left. */
function flatten(parts: string[]): string | undefined {
  const text = parts.join(" ").replace(/\s+/g, " ").trim();
  return /\p{L}{2}/u.test(text) ? own(clip(text, ABOUT_CAP)) : undefined;
}

function lineStarts(src: string): number[] {
  const starts = [0];
  for (let i = src.indexOf("\n"); i >= 0; i = src.indexOf("\n", i + 1)) starts.push(i + 1);
  return starts;
}

/** 1-based line of `offset`. */
function lineAt(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

// ---- header comments -------------------------------------------------------------

type CommentStyle = "slash" | "hash" | "dash";

/** Tool directives: they say how to lint the file, not what it is. */
const PRAGMA =
  /^(?:eslint|prettier|biome|jshint|jslint|istanbul|c8 |v8 |cspell|spellchecker|noinspection|pylint|mypy|pyright|ruff|flake8|noqa|type: ?ignore|shellcheck|syntax ?=|escape ?=|check ?=|vim?:|-\*-|coding[:=]|@ts-|@jsx|@vitest-|@jest-|@flow|@format|@generated|<reference|sourceMappingURL|yaml-language-server|#?region\b|#?endregion\b)|[a-z][a-z0-9-]*-(?:disable|enable)(?:-next-line|-line)?\b/i;
/** One such line marks its whole paragraph as licence boilerplate. */
const LICENCE =
  /^(?:copyright\s*(?:\(c\)|©|\d{4})|\(c\)\s*\d{4}|©\s*\d{4})|spdx-license-identifier|\blicensed (?:under|to) the\b|\ball rights reserved\b|\bpermission is hereby granted\b|\bwithout warrant(?:y|ies)\b|\bthe above copyright notice\b/i;
const DIRECTIVE = /^(["'])use (?:client|server|strict|cache)\1;?$/;
/** A JSDoc tag — `@param x`, never a scoped package name like `@better-auth/mcp`. */
const DOC_TAG = /^@[A-Za-z]+(?=\s|\{|$)/;
const PROSE_TAG = /^@(?:file(?:overview)?|description|desc|summary|overview|module)\b\s*/i;

/** The comment block opening at line `i` as raw text lines, plus the line after it. */
function commentBlock(lines: string[], i: number, style: CommentStyle): { text: string[]; next: number } | undefined {
  const first = lines[i].trimStart();
  if (style !== "hash" && first.startsWith("/*")) {
    const text: string[] = [];
    let j = i;
    for (; j < lines.length; j++) {
      const line = j === i ? first.slice(2) : lines[j];
      const end = line.indexOf("*/");
      text.push((end < 0 ? line : line.slice(0, end)).replace(/^\s*\*+\s?/, ""));
      if (end >= 0) break;
    }
    return { text, next: j + 1 };
  }
  const lead = style === "slash" ? /^\s*\/\/+!?\s?/ : style === "dash" ? /^\s*--+\s?/ : /^\s*#+(?!!)\s?/;
  if (!lead.test(first)) return undefined;
  const text: string[] = [];
  let j = i;
  for (; j < lines.length && lead.test(lines[j]); j++) text.push(lines[j].replace(lead, ""));
  return { text, next: j };
}

/** The prose of a comment block: pragmas, rulers, JSDoc tag paragraphs and licence paragraphs dropped. */
function blockProse(text: string[]): string | undefined {
  const paragraphs: string[][] = [[]];
  let inTag = false;
  for (const raw of text) {
    let line = raw.trim().replace(/^[-=*#~_+|]{3,}\s*|\s*[-=*#~_+|]{3,}$/g, "").trim();
    if (!line) {
      paragraphs.push([]);
      inTag = false;
      continue;
    }
    if (PRAGMA.test(line)) continue;
    if (DOC_TAG.test(line)) {
      inTag = !PROSE_TAG.test(line);
      line = line.replace(PROSE_TAG, "");
    }
    if (!inTag && line) paragraphs[paragraphs.length - 1].push(line);
  }
  return flatten(paragraphs.filter((p) => !p.some((l) => LICENCE.test(l))).flat());
}

/** Line after the import-like statement at line `i`, or `i` when there is none. A header may follow imports. */
function skipImport(lines: string[], i: number): number {
  const t = lines[i].trim();
  if (/^(?:const|let|var)\s+[^=]+=\s*require\(/.test(t)) return i + 1;
  if (!/^(?:import(?![\w$(.])|export\s*(?:type\s*)?[*{])/.test(t)) return i;
  // The statement ends on the line that closes its specifier string, its attributes or its brace list;
  // a trailing block comment (`/* keep */`) is not part of it, else the scan walks into the next function.
  for (let j = i; j < Math.min(lines.length, i + 80); j++) {
    if (/(?:["']\)?|\})[\s;]*(?:\/\/.*)?$/.test(lines[j].replace(/\/\*.*?\*\/\s*$/, ""))) return j + 1;
  }
  return i + 1;
}

/**
 * The header = the first comment block with prose in it that comes before the first real statement.
 * A comment further down documents a function, not the file. `within` lets config formats look a few
 * lines past their first keys, where they tend to keep it.
 */
function headerComment(src: string, style: CommentStyle, opts: { imports?: boolean; within?: number } = {}): string | undefined {
  const lines = src.split("\n", HEADER_LINES);
  let passed = 0;
  for (let i = 0; i < lines.length; ) {
    const t = lines[i].trim();
    if (!t || (i === 0 && t.startsWith("#!")) || (style === "slash" && DIRECTIVE.test(t)) || (style === "hash" && t === "---")) {
      i++;
      continue;
    }
    // Past the first keys only a flush-left comment can be about the file; an indented one documents an entry.
    const block = passed && /^\s/.test(lines[i]) ? undefined : commentBlock(lines, i, style);
    if (block) {
      const prose = blockProse(block.text);
      if (prose) return prose;
      i = block.next;
      continue;
    }
    const next = opts.imports ? skipImport(lines, i) : i;
    if (next > i) i = next;
    else if (passed++ < (opts.within ?? 0)) i++;
    else break;
  }
  return undefined;
}

// ---- code: ts tsx js jsx mjs cjs ---------------------------------------------------

type Literal = { at: number; text: string };

/** Words after which a `/` opens a regex literal rather than dividing. */
const REGEX_AFTER = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);
const REGEX_SCAN = 1000;

function isWordChar(c: number): boolean {
  return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 95 || c === 36 || c > 127;
}

/** Index just past the regex literal opening at `i`, or -1 when the line ends first (a division, or JSX). */
function regexEnd(src: string, i: number): number {
  const stop = Math.min(src.length, i + REGEX_SCAN);
  let inClass = false;
  for (let j = i + 1; j < stop; j++) {
    const c = src.charCodeAt(j);
    if (c === 10) return -1;
    if (c === 92) j++;
    else if (c === 91) inClass = true;
    else if (c === 93) inClass = false;
    else if (c === 47 && !inClass) {
      if (j === i + 1) return -1;
      for (j++; j < src.length && isWordChar(src.charCodeAt(j)); ) j++;
      return j;
    }
  }
  return -1;
}

/**
 * A same-length copy of `src` with comments, regex literals and the CONTENTS of string and template
 * literals blanked (quotes, `${…}` code and newlines kept), so the rules below only ever see code:
 * an `import` inside a comment or a template string is not an import. Short literals are returned.
 */
function maskCode(src: string): { code: string; literals: Literal[] } {
  const n = src.length;
  const out: string[] = [];
  const literals: Literal[] = [];
  let kept = 0;
  const blank = (from: number, to: number) => {
    if (to <= from) return;
    const seg = src.slice(from, to);
    out.push(src.slice(kept, from), seg.includes("\n") ? seg.replace(/[^\n]/g, " ") : " ".repeat(to - from));
    kept = to;
  };
  /** Open-brace depth of every `${` we are inside. */
  const nest: number[] = [];
  /** Was the last token a value? Decides whether `/` divides or opens a regex. */
  let value = false;
  let lastWord = false;
  let wordAt = 0;
  let wordEnd = 0;
  /** Blanks template text from `from` to the closing backtick or the next `${`; returns where code resumes. */
  const template = (from: number): number => {
    for (let j = from; j < n; j++) {
      const c = src.charCodeAt(j);
      if (c === 92) j++;
      else if (c === 96) {
        blank(from, j);
        value = true;
        return j + 1;
      } else if (c === 36 && src.charCodeAt(j + 1) === 123) {
        blank(from, j);
        nest.push(0);
        value = false;
        return j + 2;
      }
    }
    blank(from, n);
    return n;
  };
  let i = 0;
  while (i < n) {
    const c = src.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 13) {
      i++;
    } else if (isWordChar(c)) {
      wordAt = i;
      while (i < n && isWordChar(src.charCodeAt(i))) i++;
      wordEnd = i;
      value = lastWord = true;
    } else if (c === 47 && src.charCodeAt(i + 1) === 47) {
      const end = src.indexOf("\n", i);
      blank(i, end < 0 ? n : end);
      i = end < 0 ? n : end;
    } else if (c === 47 && src.charCodeAt(i + 1) === 42) {
      const end = src.indexOf("*/", i + 2);
      blank(i, end < 0 ? n : end + 2);
      i = end < 0 ? n : end + 2;
    } else if (c === 47) {
      // `</td>` is a JSX closing tag, never a regex; otherwise a `/` after a non-value or a keyword opens one.
      const opens = src.charCodeAt(i - 1) !== 60 && (!value || (lastWord && REGEX_AFTER.has(src.slice(wordAt, wordEnd))));
      const end: number = opens ? regexEnd(src, i) : -1;
      if (end > 0) blank(i, end);
      i = end > 0 ? end : i + 1;
      value = end > 0;
      lastWord = false;
    } else if (c === 39 || c === 34) {
      let j = i + 1;
      for (; j < n; j++) {
        const d = src.charCodeAt(j);
        if (d === 92) j++;
        else if (d === c || d === 10) break;
      }
      // No closing quote on the line: an apostrophe in JSX text, not a string.
      const closed = j < n && src.charCodeAt(j) === c;
      if (closed) {
        if (j - i - 1 >= STRING_MIN && j - i - 1 <= STRING_MAX) literals.push({ at: i, text: src.slice(i + 1, j) });
        blank(i + 1, j);
      }
      i = closed ? j + 1 : i + 1;
      value = closed;
      lastWord = false;
    } else if (c === 96) {
      const depth = nest.length;
      const end = template(i + 1);
      const len = end - i - 2;
      if (nest.length === depth && end <= n && src.charCodeAt(end - 1) === 96 && len >= STRING_MIN && len <= STRING_MAX) literals.push({ at: i, text: src.slice(i + 1, end - 1) });
      i = end;
      lastWord = false;
    } else if (c === 125 && nest.length && nest[nest.length - 1] === 0) {
      nest.pop();
      i = template(i + 1);
      lastWord = false;
    } else {
      if (nest.length && c === 123) nest[nest.length - 1]++;
      if (nest.length && c === 125) nest[nest.length - 1]--;
      value = c === 41 || c === 93 || c === 125;
      lastWord = false;
      i++;
    }
  }
  out.push(src.slice(kept));
  return { code: out.join(""), literals };
}

// NB: masked text is full of long runs of spaces (every blanked comment), so none of these rules
// puts two whitespace quantifiers side by side or looks behind across whitespace — that is cubic.
const IMPORT_FROM = /(?<![\w$.])(import|export)\b\s*(type\b\s*)?((?:[\w$]+\s*,\s*)?(?:\*(?:\s*as\s+[\w$]+)?|\{[^}]*\}|[\w$]+))\s*\bfrom\s*(["'])/g;
const IMPORT_BARE = /(?<![\w$.])import\s*(["'])/g;
const IMPORT_CALL = /(?<![\w$.])(import|require)\s*\(\s*(["'`])/g;
const DECL = /^(export\s+)?(default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(const\s+enum|const|let|var|function|class|type|interface|enum|namespace)\b\s*\*?\s*([A-Za-z_$][\w$]*)?/gm;
/** A default export DECL did not take: group 1 = its first word, group 2 = set when that word is all there is (`export default app;`). */
const EXPORT_DEFAULT = /^export\s+default\s+(?!(?:abstract\s+|async\s+)?(?:function|class|interface|enum)\b)([A-Za-z_$][\w$]*)?([ \t;]*$)?/gm;
const EXPORT_LIST = /^export\s*(type\b\s*)?\{([^}]*)\}(?!\s*from\b)/gm;
const CJS_EXPORT = /^(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/gm;
const CJS_EXPORTS = /^module\.exports\s*=\s*(?:\{([^{}]*)\}|([A-Za-z_$][\w$]*)[ \t;]*$)/gm;
const CALL = /(?<![.\w$])([A-Za-z_$][\w$]*)(?:<[^<>()\n]{0,60}>)?\(/g;
/** What precedes a name that is being declared, not called. */
const DECLARING = /\bfunction\s*\*?\s*$/;
/** `<Panel …>` renders Panel, which is a call of it; `Map<Panel>` and `<T extends …>(` are not. */
const JSX_TAG = /(?<![\w$.)\]])<([A-Z][\w$]*)(?:\.[\w$]+)*(?=[\s/>])(?!\s+extends\b)/g;
const JSX_EXT = new Set(["tsx", "jsx", "js"]);
const ENV_ACCESS = /\b(?:process\.env|import\.meta\.env|env|ENV)\.([A-Z][A-Z0-9_]{2,})\b/g;
/** Routes, SCREAMING_CASE, and dotted / kebab / snake / colon / slash names: literals that NAME something. */
const NAME_LIKE = /^(?:\/[\w\-./:[\]{}*@]+|[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+|[A-Z][A-Z0-9]{3,}|[A-Za-z][A-Za-z0-9]*(?:[._:/@-][A-Za-z0-9]+)+)$/;
const LINE_FIRST = /^\s*(?:(?:public|private|protected|static|async|override|abstract|readonly|get|set|\*)\s+)*$/;

/** Not calls worth knowing: syntax, the language's own constructors, and test-framework globals. */
const NOT_CALLS = new Set(
  ("if for while switch catch return function typeof await async new super import export from const let var class extends implements interface type enum case " +
    "break continue default delete do else finally in instanceof of this throw try void with yield as is keyof readonly declare namespace require constructor get set " +
    "String Number Boolean Array Object Promise Map Set WeakMap WeakSet Date Error TypeError RangeError JSON Math console parseInt parseFloat Symbol RegExp BigInt isNaN isFinite " +
    "describe it expect test suite bench beforeEach afterEach beforeAll afterAll vi jest").split(" "),
);

/** `x`, `x, { a, b as c }`, `* as ns`, `{ type A }` → names as the target exports them, and what this file binds them as. */
function importClause(clause: string): { names: string[]; locals: string[]; allType: boolean } {
  const names: string[] = [];
  const locals: string[] = [];
  const brace = clause.match(/\{([^}]*)\}/);
  const head = (brace ? clause.replace(brace[0], "") : clause).split(",").map((s) => s.trim()).filter(Boolean);
  for (const h of head) {
    if (h.startsWith("*")) {
      names.push("*");
      locals.push(h.match(/\bas\s+([\w$]+)/)?.[1] ?? "*");
    } else if (/^[\w$]+$/.test(h)) {
      names.push("default");
      locals.push(h);
    }
  }
  let named = 0;
  let typed = 0;
  for (const part of brace?.[1].split(",") ?? []) {
    const m = part.trim().match(/^(type\s+)?([\w$]+)(?:\s+as\s+([\w$]+))?$/);
    if (!m) continue;
    named++;
    if (m[1]) typed++;
    names.push(m[2]);
    locals.push(m[3] ?? m[2]);
  }
  return { names, locals, allType: named > 0 && typed === named && !head.length };
}

function codeFacts(src: string, ext: string): FileFacts {
  const f = emptyFacts();
  const about = headerComment(src, "slash", { imports: true });
  if (about) f.about = about;
  const { code, literals } = maskCode(src);
  const starts = lineStarts(src);
  const longLine = (line: number) => (starts[line] ?? src.length + 1) - starts[line - 1] - 1 > LINE_CAP;

  // imports — the specifier is read from `src` at the offsets the masked text matched
  const specAt = (quoteAt: number, call: boolean): string | undefined => {
    const end = code.indexOf(code[quoteAt], quoteAt + 1);
    if (end < 0 || /\S/.test(code.slice(quoteAt + 1, end))) return undefined; // a `${…}` inside: not a static specifier
    if (call && !/^\s*[,)]/.test(code.slice(end + 1, end + 24))) return undefined;
    const spec = src.slice(quoteAt + 1, end);
    return spec && spec.length <= 300 && !spec.includes("\n") ? spec : undefined;
  };
  const found: Array<{ at: number; fact: ImportFact }> = [];
  /** Names this file binds through imports: exporting one of them is not a declaration here. */
  const bound = new Set<string>();
  for (const m of code.matchAll(IMPORT_FROM)) {
    const reexport = m[1] === "export";
    const clause = m[3].trim();
    if (reexport && !/^[*{]/.test(clause)) continue;
    const spec = specAt(m.index + m[0].length - 1, false);
    if (!spec) continue;
    const { names, locals, allType } = importClause(clause);
    const fact: ImportFact = { spec, names, how: reexport ? "reexport" : "import", typeOnly: Boolean(m[2]) || allType, line: lineAt(starts, m.index) };
    if (reexport && locals.some((l, k) => l !== names[k])) fact.as = locals;
    if (!reexport) for (const l of locals) bound.add(l);
    found.push({ at: m.index, fact });
  }
  for (const m of code.matchAll(IMPORT_BARE)) {
    const spec = specAt(m.index + m[0].length - 1, false);
    if (spec) found.push({ at: m.index, fact: { spec, names: [], how: "import", typeOnly: false, line: lineAt(starts, m.index) } });
  }
  for (const m of code.matchAll(IMPORT_CALL)) {
    const spec = specAt(m.index + m[0].length - 1, true);
    if (!spec) continue;
    const typeOnly = m[1] === "import" && /\btypeof\s+$/.test(code.slice(Math.max(0, m.index - 12), m.index));
    found.push({ at: m.index, fact: { spec, names: [], how: m[1] === "import" ? "dynamic" : "require", typeOnly, line: lineAt(starts, m.index) } });
  }
  found.sort((a, b) => a.at - b.at);
  const seenImport = new Set<string>();
  for (const { fact } of found) {
    // `as` is part of the key: `export { default } from "./B"` and `export { default as B } from "./B"` expose different names.
    const key = `${fact.how}\0${fact.typeOnly}\0${fact.spec}\0${fact.names.join(",")}\0${fact.as?.join(",") ?? ""}`;
    if (seenImport.has(key) || f.imports.length >= LIST_CAP) continue;
    seenImport.add(key);
    f.imports.push({ ...fact, spec: own(fact.spec), names: fact.names.map(own), ...(fact.as ? { as: fact.as.map(own) } : {}) });
  }

  // declarations — top level only (column 0), first declaration of a name wins (overloads)
  const decls = new Map<string, Decl>();
  const declare = (name: string, kind: string, exported: boolean, at: number) => {
    const old = decls.get(name);
    if (old) old.exported ||= exported;
    else decls.set(name, { name: own(name), kind, exported, line: lineAt(starts, at) });
  };
  /** `export default x` / `export { x as default }`: the decl it names is exported; anything else is an anonymous default. */
  const exportDefault = (local: string | undefined, at: number) => {
    const d = local ? decls.get(local) : undefined;
    if (d) d.exported = true;
    else if (!local || !bound.has(local)) declare("default", "default", true, at);
  };
  for (const m of code.matchAll(DECL)) {
    const kind = m[3].startsWith("const") && m[3] !== "const" ? "enum" : m[3];
    const name = m[4] === "extends" || m[4] === "implements" ? undefined : m[4];
    if (name) declare(name, kind, Boolean(m[1]), m.index);
    else if (m[2]) declare("default", kind, true, m.index);
  }
  for (const m of code.matchAll(EXPORT_DEFAULT)) exportDefault(m[2] === undefined ? undefined : m[1], m.index);
  for (const m of code.matchAll(EXPORT_LIST)) {
    for (const part of m[2].split(",")) {
      const p = part.trim().match(/^(type\s+)?([\w$]+)(?:\s+as\s+([\w$]+))?$/);
      if (!p) continue;
      const local = p[2];
      const exposed = p[3] ?? local;
      const d = decls.get(local);
      if (exposed === "default") exportDefault(local, m.index);
      else if (d && exposed === local) d.exported = true;
      // `export { x }` of an import is the import's (the graph chases it); `export { x as y }` makes a new name y here.
      else if (d || exposed !== local || !bound.has(local)) declare(exposed, d?.kind ?? (m[1] || p[1] ? "type" : "export"), true, m.index);
    }
  }
  for (const m of code.matchAll(CJS_EXPORT)) declare(m[1], "export", true, m.index);
  for (const m of code.matchAll(CJS_EXPORTS)) {
    if (m[2]) exportDefault(m[2], m.index);
    else for (const part of m[1].split(",")) {
      const name = part.trim().match(/^([A-Za-z_$][\w$]*)\s*(?::|$)/)?.[1];
      if (name) declare(name, "export", true, m.index);
    }
  }
  f.decls = [...decls.values()].sort((a, b) => a.line - b.line).slice(0, LIST_CAP);

  // calls
  const calls: Array<{ at: number; text: string }> = [];
  for (const m of code.matchAll(CALL)) {
    const id = m[1];
    if (id.length < 3 || NOT_CALLS.has(id) || DECLARING.test(code.slice(Math.max(0, m.index - 16), m.index))) continue;
    const line = lineAt(starts, m.index);
    if (longLine(line)) continue;
    if (LINE_FIRST.test(code.slice(starts[line - 1], m.index))) {
      // `name(…) {`, `name(…) { … }` and `name(…): T;` opening a line are a method, a one-line method and a signature, not calls.
      const tail = code.slice(m.index + id.length, (starts[line] ?? src.length + 1) - 1).trimEnd();
      if (!tail.includes("=>") && !/\bfunction\b/.test(tail) && (/\)\s*(?::[^=;]*)?\{$/.test(tail) || /\)\s*(?::[^=;{]*)?\{.*\}\s*[,;]?$/.test(tail) || /\)\s*:\s*[^=;{]+[;,]?$/.test(tail))) continue;
    }
    calls.push({ at: m.index, text: id });
  }
  if (JSX_EXT.has(ext)) for (const m of code.matchAll(JSX_TAG)) if (m[1].length >= 3 && !longLine(lineAt(starts, m.index))) calls.push({ at: m.index, text: m[1] });
  f.calls = uniq(calls.sort((a, b) => a.at - b.at).map((c) => c.text));

  // strings — literals that name something, plus env vars read as properties
  const specs = new Set(f.imports.map((i) => i.spec));
  const named = literals.filter((l) => NAME_LIKE.test(l.text) && !specs.has(l.text));
  for (const m of code.matchAll(ENV_ACCESS)) named.push({ at: m.index, text: m[1] });
  f.strings = uniq(named.sort((a, b) => a.at - b.at).filter((l) => !longLine(lineAt(starts, l.at))).map((l) => l.text));
  return f;
}

// ---- markdown ----------------------------------------------------------------------

const mdText = (s: string): string =>
  s.replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[`*]|<[^>]+>/g, "").replace(/\s+/g, " ").trim();

function markdownFacts(src: string): FileFacts {
  const f = emptyFacts();
  const lines = src.split("\n");
  let i = 0;
  // Front matter — but only if it closes; a lone `---` on top is a rule.
  const opener = lines[0]?.trim();
  const closer = opener === "---" || opener === "+++" ? lines.slice(1, 200).findIndex((l) => l.trim() === opener) : -1;
  if (closer >= 0) i = closer + 2;
  const headings: string[] = [];
  let fence = "";
  let para: string[] = [];
  let isList = false;
  let about: string[] | undefined;
  let firstList: string[] | undefined;
  const close = () => {
    if (para.length && isList) firstList ??= para;
    else if (para.length) about ??= para;
    para = [];
    isList = false;
  };
  for (; i < lines.length; i++) {
    const line = lines[i];
    const fenced = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fenced) {
      close();
      if (!fence) fence = fenced[1][0];
      else if (fence === fenced[1][0]) fence = "";
      continue;
    }
    if (fence) continue;
    const t = line.trim();
    const h = line.match(/^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) {
      close();
      if (h[1].length <= 3) headings.push(mdText(h[2]));
    } else if (!t || /^(?:[|<]|!\[|\[!\[|:::|\{%|(?:-{3,}|\*{3,}|_{3,})$|(?:import|export)\s)/.test(t)) {
      close(); // blank, table, html, image / badge, admonition, rule, mdx import: not prose
    } else if (!about && line.length <= LINE_CAP * 4) {
      const item = t.match(/^(?:[-*+]|\d+[.)])\s+(.*)$/);
      if (item && !para.length) isList = true;
      para.push(item ? item[1] : t.replace(/^(?:>\s?)+/, ""));
    }
  }
  close();
  const prose = flatten((about ?? firstList ?? []).map(mdText));
  if (prose) f.about = prose;
  f.headings = uniq(headings);
  return f;
}

// ---- json (and jsonc) ----------------------------------------------------------------

/** Comments and trailing commas removed, strings untouched — enough for tsconfig.json and .vscode files. */
const stripJsonc = (src: string): string =>
  src.replace(/"(?:[^"\\\n]|\\.)*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m) => (m[0] === '"' ? m : " ")).replace(/,(\s*[}\]])/g, "$1");

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Keys by indentation, for text no JSON parser takes: the shallowest indent is the top level, the next one nests under it. */
function scanJsonKeys(src: string): string[] {
  const keys: string[] = [];
  let topIndent = -1;
  let nestedIndent = -1;
  let top = "";
  for (const line of src.split("\n")) {
    const m = line.length <= LINE_CAP ? line.match(/^(\s*)"((?:[^"\\]|\\.)+)"\s*:/) : null;
    if (!m) continue;
    const indent = m[1].length;
    if (topIndent < 0 || indent <= topIndent) {
      topIndent = indent;
      nestedIndent = -1;
      keys.push((top = m[2]));
    } else if (nestedIndent < 0 || indent === nestedIndent) {
      nestedIndent = indent;
      keys.push(`${top}.${m[2]}`);
    }
  }
  return keys;
}

function jsonFacts(src: string): FileFacts {
  const f = emptyFacts();
  let root: unknown;
  let parsed = true;
  try {
    root = JSON.parse(src);
  } catch {
    try {
      root = JSON.parse(stripJsonc(src));
    } catch {
      parsed = false;
    }
  }
  const keys: string[] = [];
  const rows = Array.isArray(root) && isRecord(root[0]) ? root[0] : undefined; // an array of records: the first row is the schema
  for (const [k, v] of Object.entries(isRecord(root) ? root : (rows ?? {}))) {
    keys.push(rows ? `[].${k}` : k);
    if (!rows && isRecord(v)) for (const k2 of Object.keys(v)) keys.push(`${k}.${k2}`);
  }
  f.keys = uniq(parsed ? keys : scanJsonKeys(src));
  const description = isRecord(root) && typeof root.description === "string" ? flatten([root.description]) : undefined;
  const about = description ?? headerComment(src, "slash");
  if (about) f.about = about;
  return f;
}

// ---- yml yaml toml env example ----------------------------------------------------------

function configFacts(src: string, ext: string): FileFacts {
  const f = emptyFacts();
  // The leading comment, else the manifest's own `description`, else the first flush-left comment near the top.
  const described = src.match(/^description\s*[:=]\s*(["']?)(.{8,}?)\1\s*$/m)?.[2];
  const about = headerComment(src, "hash") ?? (described ? flatten([described]) : undefined) ?? headerComment(src, "hash", { within: CONFIG_COMMENT_WITHIN });
  if (about) f.about = about;
  const colon = ext !== "toml" && ext !== "env";
  const equals = ext !== "yml" && ext !== "yaml";
  const keys: string[] = [];
  const unquote = (k: string) => k.replace(/^(["'])(.*)\1$/, "$2");
  let top = "";
  let section = "";
  let nestedIndent = -1;
  let blockScalar = false;
  for (const line of src.split("\n")) {
    if (line.length > LINE_CAP) continue;
    const table = equals ? line.match(/^\s*\[\[?\s*([\w.\-"' ]+?)\s*\]\]?\s*(?:#.*)?$/) : null;
    const optional = equals ? line.match(/^#\s*([A-Z][A-Z0-9_]{2,})=/) : null; // `# STRIPE_KEY=` in an env example documents a variable
    const flat = line.match(/^(?:export\s+)?("[^"\n]+"|'[^'\n]+'|[A-Za-z_@$][^\s:=#]*)\s*(:(?=\s|$)|=)\s*(.*)$/);
    const nested = colon && top && !blockScalar ? line.match(/^( +)("[^"\n]+"|'[^'\n]+'|[A-Za-z_@$./][^\s:#]*)\s*:(?=\s|$)/) : null;
    if (table) {
      keys.push((section = unquote(table[1])));
      top = "";
    } else if (optional) {
      keys.push(optional[1]);
    } else if (flat && (flat[2] === ":" ? colon : equals)) {
      const key = unquote(flat[1]);
      if (!section) keys.push(key);
      else if (!section.includes(".")) keys.push(`${section}.${key}`);
      top = flat[2] === ":" ? key : "";
      nestedIndent = -1;
      blockScalar = /^[|>][+-]?\d*\s*(?:#.*)?$/.test(flat[3]); // the indented lines under `run: |` are text, not keys
    } else if (nested && (nestedIndent < 0 || nested[1].length === nestedIndent)) {
      nestedIndent = nested[1].length;
      keys.push(`${top}.${unquote(nested[2])}`);
    }
  }
  f.keys = uniq(keys);
  return f;
}

// ---- sql, prisma ---------------------------------------------------------------------------

const SQL_IDENT = String.raw`((?:"[^"\n]+"|[A-Za-z_][\w$]*)(?:\.(?:"[^"\n]+"|[A-Za-z_][\w$]*))?)`;
const SQL_TABLE = new RegExp(
  String.raw`\b(CREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:GLOBAL\s+|LOCAL\s+)?TEMP(?:ORARY)?\s+|UNLOGGED\s+)?(?:TABLE|(?:MATERIALIZED\s+)?VIEW|TYPE)|ALTER\s+(?:TABLE|TYPE|(?:MATERIALIZED\s+)?VIEW)|DROP\s+(?:TABLE|TYPE|(?:MATERIALIZED\s+)?VIEW)|TRUNCATE(?:\s+TABLE)?|INSERT\s+INTO|COPY|UPDATE|REFERENCES|FROM|JOIN)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?(?:ONLY\s+)?` + SQL_IDENT,
  "gi",
);
const SQL_INDEX_ON = new RegExp(String.raw`\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(?:(?!ON\b)(?:"[^"\n]+"|[\w$]+)\s+)?ON\s+(?:ONLY\s+)?` + SQL_IDENT, "gi");
const SQL_ROUTINE = new RegExp(String.raw`\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?(FUNCTION|PROCEDURE|TRIGGER)\s+` + SQL_IDENT, "gi");
const SQL_CTE = /(?:\bWITH|,)\s+(?:RECURSIVE\s+)?([A-Za-z_]\w*)\s*(?:\([^()]*\)\s*)?AS\s*(?:NOT\s+MATERIALIZED\s*|MATERIALIZED\s*)?\(/gi;
/** What follows FROM / JOIN / UPDATE without being a table. */
const SQL_NOISE = new Set("select lateral only set values unnest where group order limit as on using the a an of skip nowait cascade restrict no null default stdin stdout each row now current_timestamp".split(" "));

function sqlFacts(src: string): FileFacts {
  const f = emptyFacts();
  const about = headerComment(src, "dash");
  if (about) f.about = about;
  // Comments and string literals blanked; quoted identifiers and $$ bodies are code and stay.
  const code = src.replace(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'/g, (m) => m.replace(/[^\n]/g, " "));
  const clean = (ident: string) => ident.replace(/"/g, "");
  const ctes = new Set<string>();
  for (const m of code.matchAll(SQL_CTE)) ctes.add(m[1].toLowerCase());
  const tables: Array<{ at: number; text: string }> = [];
  for (const m of code.matchAll(SQL_TABLE)) {
    const verb = m[1].toUpperCase();
    const name = clean(m[2]);
    const after = code.slice(m.index + m[0].length, m.index + m[0].length + 80);
    if (SQL_NOISE.has(name.toLowerCase())) continue;
    if (verb === "UPDATE" && !/^\s+(?:(?:AS\s+)?[\w$]+\s+)?SET\b/i.test(after)) continue; // ON UPDATE CASCADE, FOR UPDATE OF …
    if (verb === "FROM" || verb === "JOIN") {
      const before = code.slice(Math.max(0, m.index - 60), m.index);
      // FROM unnest(…), a CTE, `IS DISTINCT FROM x`, EXTRACT(EPOCH FROM x): none of them is a table
      if (/^\s*\(/.test(after) || ctes.has(name.toLowerCase()) || /\bdistinct\s+$/i.test(before) || /\b(?:extract|substring|trim|overlay|position)\s*\([^()]*$/i.test(before)) continue;
    }
    tables.push({ at: m.index, text: name });
  }
  for (const m of code.matchAll(SQL_INDEX_ON)) tables.push({ at: m.index, text: clean(m[1]) });
  f.tables = uniq(tables.sort((a, b) => a.at - b.at).map((t) => t.text));
  const starts = lineStarts(src);
  const seen = new Set<string>();
  for (const m of code.matchAll(SQL_ROUTINE)) {
    const name = clean(m[2]);
    if (!seen.has(name) && seen.size < LIST_CAP) f.decls.push({ name: own(name), kind: m[1].toLowerCase(), exported: false, line: lineAt(starts, m.index) });
    seen.add(name);
  }
  return f;
}

function prismaFacts(src: string): FileFacts {
  const f = emptyFacts();
  const about = headerComment(src, "slash");
  if (about) f.about = about;
  f.tables = uniq([...src.matchAll(/^(?:model|enum|view|type)\s+(\w+)/gm)].map((m) => m[1]));
  return f;
}

// ---- sh, py, dockerfile -------------------------------------------------------------------

/** Top-level declarations by one regex; `read` names the match (undefined = not a declaration). The first declaration of a name wins. */
function declsOf(src: string, re: RegExp, read: (m: RegExpMatchArray) => { name: string | undefined; kind: string; exported: boolean }): Decl[] {
  const starts = lineStarts(src);
  const decls = new Map<string, Decl>();
  for (const m of src.matchAll(re)) {
    const { name, kind, exported } = read(m);
    if (name && !decls.has(name) && decls.size < LIST_CAP) decls.set(name, { name: own(name), kind, exported, line: lineAt(starts, m.index) });
  }
  return [...decls.values()];
}

function shellFacts(src: string): FileFacts {
  const f = emptyFacts();
  const about = headerComment(src, "hash");
  if (about) f.about = about;
  // `name() {` or `function name {`; a bare word alone on a line is a command, not a function
  f.decls = declsOf(src, /^(?:function\s+([A-Za-z_][\w:.-]*)\s*(?:\(\s*\))?|([A-Za-z_][\w:.-]*)\s*\(\s*\))\s*(?:\{|$)/gm, (m) => ({ name: m[1] ?? m[2], kind: "function", exported: false }));
  return f;
}

/** A module docstring is Python's header comment. */
function docstring(src: string): string | undefined {
  const lines = src.split("\n", HEADER_LINES);
  const i = lines.findIndex((l) => l.trim() && !l.trimStart().startsWith("#"));
  const open = i < 0 ? null : lines[i].match(/^\s*[rRuUbB]{0,2}("""|''')(.*)$/);
  if (!open) return undefined;
  const text: string[] = [];
  for (let j = i, rest = open[2]; j < lines.length; rest = lines[++j] ?? "") {
    const end = rest.indexOf(open[1]);
    text.push(end < 0 ? rest : rest.slice(0, end));
    if (end >= 0) break;
  }
  return blockProse(text);
}

function pythonFacts(src: string): FileFacts {
  const f = emptyFacts();
  const about = headerComment(src, "hash") ?? docstring(src);
  if (about) f.about = about;
  // Docstrings and comments blanked, so an `import x` quoted in one is not an import.
  const code = src.replace(/("""|''')[\s\S]*?\1|#[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));
  // Every top-level name is importable in Python; a leading underscore is how a module says "private".
  f.decls = declsOf(code, /^(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)/gm, (m) => ({ name: m[2], kind: m[1], exported: !m[2].startsWith("_") }));
  const starts = lineStarts(src);
  const seen = new Set<string>();
  const add = (spec: string, names: string[], at: number) => {
    const key = `${spec}\0${names.join(",")}`;
    if (!spec || seen.has(key) || seen.size >= LIST_CAP) return;
    seen.add(key);
    f.imports.push({ spec: own(spec), names: names.map(own), how: "import", typeOnly: false, line: lineAt(starts, at) });
  };
  for (const m of code.matchAll(/^[ \t]*(?:from\s+([.\w]+)\s+import\s+(\([^)]*\)|[^\n]+)|import\s+([^\n]+))/gm)) {
    const idents = (list: string) => list.replace(/[()\\]/g, " ").split(",").map((s) => s.trim().split(/\s+as\s+/)[0].trim()).filter((s) => /^[\w.*]+$/.test(s));
    if (m[1]) add(m[1], idents(m[2]), m.index);
    else for (const spec of idents(m[3])) add(spec, [], m.index);
  }
  return f;
}

function dockerFacts(src: string): FileFacts {
  const f = emptyFacts();
  const about = headerComment(src, "hash");
  if (about) f.about = about;
  f.decls = declsOf(src, /^FROM\s+\S+\s+AS\s+([\w.-]+)/gim, (m) => ({ name: m[1], kind: "stage", exported: false }));
  return f;
}

// ---- html, csv, anything else ---------------------------------------------------------------

function htmlFacts(src: string): FileFacts {
  const f = emptyFacts();
  const text = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const title = src.match(/<title[^>]*>([^<]{1,300})<\/title>/i);
  const about = title ? flatten([text(title[1])]) : undefined;
  if (about) f.about = about;
  f.headings = uniq([...src.matchAll(/<h[1-3][^>]*>([\s\S]{1,300}?)<\/h[1-3]>/gi)].map((m) => text(m[1])));
  return f;
}

/** A table's header row is its schema. */
function csvFacts(src: string, ext: string): FileFacts {
  const f = emptyFacts();
  const header = src.slice(0, src.indexOf("\n") < 0 ? LINE_CAP * 4 : Math.min(src.indexOf("\n"), LINE_CAP * 4));
  f.keys = uniq(header.split(ext === "tsv" ? "\t" : ",").map((c) => c.trim().replace(/^"(.*)"$/, "$1")).filter((c) => /^[A-Za-z_][\w .-]{0,60}$/.test(c)));
  return f;
}

/** The first paragraph, comment leaders stripped so a header comment in an unknown language still reads as prose. */
function proseFacts(src: string): FileFacts {
  const f = emptyFacts();
  const para: string[] = [];
  for (const raw of src.slice(0, 16384).split("\n", 200)) {
    const line = raw.length > LINE_CAP * 4 ? "" : raw.trim().replace(/^(?:\/\/+|#+|--+|;+|%+|\/?\*+\/?)\s?/, "").replace(/\s*\*+\/$/, "");
    if (line && !line.startsWith("<")) para.push(line);
    else if (para.length) break;
  }
  const about = flatten(para);
  if (about) f.about = about;
  return f;
}

// ---- registry ---------------------------------------------------------------------------------

/** NULs in the first 8 KiB, more than one per KiB: a binary is full of them, while a lone one is a separator somebody typed into a template string. */
function looksBinary(src: string): boolean {
  const probe = src.slice(0, BINARY_PROBE);
  let nuls = 0;
  for (let i = probe.indexOf("\0"); i >= 0; i = probe.indexOf("\0", i + 1)) nuls++;
  return nuls > probe.length / 1024;
}

type Extractor = (src: string, ext: string) => FileFacts;
const EXTRACTORS = new Map<string, Extractor>();
const register = (exts: string, extractor: Extractor) => exts.split(" ").forEach((e) => EXTRACTORS.set(e, extractor));
register("ts tsx mts cts js jsx mjs cjs", codeFacts);
register("md mdx markdown", markdownFacts);
register("json jsonc json5", jsonFacts);
register("yml yaml toml env example", configFacts);
register("sql", sqlFacts);
register("prisma", prismaFacts);
register("sh bash zsh", shellFacts);
register("py", pythonFacts);
register("dockerfile", dockerFacts);
register("css scss", prismaFacts); // same shape: a slash-comment header, and no `model` lines to find
register("html htm", htmlFacts);
register("csv tsv", csvFacts);

/**
 * The facts of one leaf. `ext` is the lowercase extension without the dot ("dockerfile" for a
 * Dockerfile), as `build.ts` computes it; unknown extensions get the first paragraph. Never throws:
 * text that looks binary, or that an extractor chokes on, yields empty facts.
 */
export function extractFacts(src: string, ext: string): FileFacts {
  if (!src || looksBinary(src)) return emptyFacts();
  const text = src.charCodeAt(0) === 0xfeff ? src.slice(1) : src;
  const key = ext.toLowerCase();
  try {
    return (EXTRACTORS.get(key) ?? proseFacts)(text, key);
  } catch {
    return emptyFacts();
  }
}

/** Every string in the facts, one per line: the lexical index's "signature" field. `default` and `*` name nothing. */
export function factsText(f: FileFacts): string {
  const parts: string[] = f.about ? [f.about] : [];
  for (const d of f.decls) if (d.name !== "default") parts.push(d.name);
  for (const i of f.imports) parts.push(i.spec, ...[...i.names, ...(i.as ?? [])].filter((n) => n !== "default" && n !== "*"));
  parts.push(...f.calls, ...f.strings, ...f.headings, ...f.keys, ...f.tables);
  return parts.join("\n");
}
