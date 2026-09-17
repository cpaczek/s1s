// The zero-API lexical index: BM25F over three fields of every leaf (its path, its facts text,
// its capped body). This is the recall generator — it proposes candidates and TypeSafe judges
// them — so everything here is code: no fs, no network, no model. The caller feeds documents
// and keeps the leaf text; the index keeps only typed arrays and one interned vocabulary.

/** One leaf. `sig` = the facts text of the leaf, `body` = its text; both may be "". */
export type LexDoc = { path: string; sig: string; body: string };

/**
 * Postings are CSR over typed arrays (≈10 bytes each), so a million postings cost ~10 MB off-heap
 * instead of ~100 MB of number[]; the only strings retained are the paths and the vocabulary keys.
 */
export type LexIndex = {
  /** Doc id → path, in the order the docs were fed. */
  paths: string[];
  /** Term → term id. Keys are flat copies, never views into a leaf's text. */
  vocab: Map<string, number>;
  /** Term id `t` owns postings `[start[t], start[t + 1])`. */
  start: Uint32Array;
  /** Posting → doc id, ascending within a term. */
  postDoc: Uint32Array;
  /** Posting → tf in [path, sig, body], saturating at 65535 (BM25 stopped caring long before). */
  postTf: Uint16Array;
  /** Doc → token count of [path, sig, body]. */
  lengths: Uint32Array;
  /** Mean field lengths over every doc. */
  avg: [number, number, number];
};

export type QueryTerm = { label: string; group: string[]; weight: number; df: number };
export type LexHit = { path: string; score: number; rank: number; matched: string[] };
export type LexFields = "all" | "path" | "path+sig";

/** Field order everywhere: path, sig, body. */
export const BM25 = { k1: 1.2, weight: [4, 2.5, 1], b: [0.4, 0.6, 0.75] } as const;
/** Minified bundles, SVG paths, lock-file hashes: a line this long is not prose or code a person wrote. */
export const MAX_LINE = 400;
/** UTF-16 units of a body that are indexed (and searched for evidence). */
export const MAX_BODY = 256 * 1024;
const MIN_TOKEN = 2;
const MAX_TOKEN = 32;
const TF_MAX = 0xffff;

// ---- tokens ----------------------------------------------------------------------

/** 1 lower, 2 upper, 3 digit, 0 separator. Non-ASCII separates: identifiers and English are the target. */
const CLASS = new Uint8Array(128);
for (let c = 97; c <= 122; c++) CLASS[c] = 1;
for (let c = 65; c <= 90; c++) CLASS[c] = 2;
for (let c = 48; c <= 57; c++) CLASS[c] = 3;

/**
 * One pass, no intermediate strings: parts of `text[from, to)` split on separators, on aB / 1B,
 * and before the last capital of an acronym (HTTPServer → http server; but JWTs, userIDs keep
 * their plural). Digits stay attached (e2e, v2, sha256). `raw` keeps every part as written;
 * otherwise parts are filtered and stemmed.
 */
function scan(text: string, from: number, to: number, raw: boolean, out: string[]): void {
  let s = -1;
  let prev = 0;
  let upper = false;
  let alpha = false;
  for (let i = from; i < to; i++) {
    const c = text.charCodeAt(i);
    const k = c < 128 ? CLASS[c] : 0;
    if (k === 0) {
      if (s >= 0) emit(text, s, i, upper, alpha, raw, out);
      s = -1;
      continue;
    }
    if (s < 0 || (k === 2 && (prev !== 2 || startsWord(text, i, to)))) {
      if (s >= 0) emit(text, s, i, upper, alpha, raw, out);
      s = i;
      upper = false;
      alpha = false;
    }
    if (k === 2) upper = true;
    if (k !== 3) alpha = true;
    prev = k;
  }
  if (s >= 0) emit(text, s, to, upper, alpha, raw, out);
}

function isLower(c: number): boolean {
  return c >= 97 && c <= 122;
}

/** Inside a run of capitals, the one at `i` starts a word when lower case follows — unless that is only a plural s. */
function startsWord(text: string, i: number, to: number): boolean {
  if (i + 1 >= to || !isLower(text.charCodeAt(i + 1))) return false;
  return text.charCodeAt(i + 1) !== 115 || (i + 2 < to && isLower(text.charCodeAt(i + 2)));
}

function emit(text: string, s: number, e: number, upper: boolean, alpha: boolean, raw: boolean, out: string[]): void {
  const n = e - s;
  if (!raw && (n < MIN_TOKEN || n > MAX_TOKEN || !alpha)) return;
  const part = text.slice(s, e);
  const low = upper ? part.toLowerCase() : part;
  out.push(raw ? low : stem(low));
}

/** "getSessionFromCtx" → get session from ctx; "HTTPServer2" → http server2; "stripe-webhook_handler" → stripe webhook handler. */
export function splitIdent(s: string): string[] {
  const out: string[] = [];
  scan(s, 0, s.length, true, out);
  return out;
}

/**
 * Harman's S-stemmer — plurals only, because anything stronger conflates identifiers
 * (`organization`/`organ`). One change from the paper: -sses/-xes/-ches/-shes/-zes lose "es"
 * (classes → class, not classe). Its misses (cookies → cooky, caches → cach) are repaired on
 * the query side by `variants`, where the vocabulary can arbitrate.
 */
export function stem(word: string): string {
  const n = word.length;
  if (n < 4 || word.charCodeAt(n - 1) !== 115) return word;
  const b = word.charCodeAt(n - 2);
  if (b === 101 && n > 4) {
    const a = word.charCodeAt(n - 3);
    const z = word.charCodeAt(n - 4);
    if (a === 105) {
      if (z !== 101 && z !== 97) return word.slice(0, n - 3) + "y"; // policies, not eies / aies
    } else if (a === 120 || a === 122 || (a === 104 && (z === 99 || z === 115)) || (a === 115 && z === 115)) {
      return word.slice(0, n - 2); // boxes, quizzes, matches, pushes, classes
    }
  }
  if (b === 115 || b === 117 || b === 105) return word; // access, status, analysis
  return word.slice(0, n - 1);
}

/** Index-side tokens: split, lower-cased, 2–32 chars, not a pure number, plural-stemmed. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  scan(text, 0, text.length, false, out);
  return out;
}

/** Tokens of a body: the first MAX_BODY units, skipping lines longer than MAX_LINE. */
function bodyTokens(body: string, out: string[]): void {
  const end = Math.min(body.length, MAX_BODY);
  for (let at = 0; at < end; ) {
    let nl = body.indexOf("\n", at);
    if (nl < 0 || nl > end) nl = end;
    if (nl - at <= MAX_LINE) scan(body, at, nl, false, out);
    at = nl + 1;
  }
}

// ---- build -----------------------------------------------------------------------

/** A fresh flat copy. V8 substrings of 13+ chars are views that keep the whole parent (a file body) alive. */
function flat(s: string): string {
  return s.length < 13 ? s : Buffer.from(s, "latin1").toString("latin1");
}

function grow<A extends Uint32Array | Uint16Array | Int32Array>(a: A, need: number, fill = 0): A {
  if (need <= a.length) return a;
  const next = new (a.constructor as new (n: number) => A)(Math.max(need, a.length * 2));
  if (fill) next.fill(fill, a.length);
  next.set(a);
  return next;
}

/**
 * One streaming pass: each doc's postings are appended to a doc-ordered scratch (typed, growable),
 * then a counting sort by term lays them out CSR. Nothing per-term is ever a JS array, and the
 * docs are not retained — feed a generator and the bodies can be collected as they go.
 */
export function buildLex(docs: Iterable<LexDoc>): LexIndex {
  const paths: string[] = [];
  const vocab = new Map<string, number>();
  let tmpTerm = new Uint32Array(1 << 16);
  let tmpTf = new Uint16Array(3 << 16);
  let docStart = new Uint32Array(1 << 10);
  let lengths = new Uint32Array(3 << 10);
  /** Term id → its scratch row for the CURRENT doc (valid when ≥ the doc's first row). */
  let slot = new Int32Array(1 << 12).fill(-1);
  let rows = 0;
  const sum = [0, 0, 0];
  const toks: string[] = [];

  for (const doc of docs) {
    const d = paths.length;
    paths.push(doc.path);
    docStart = grow(docStart, d + 2);
    lengths = grow(lengths, 3 * d + 3);
    docStart[d] = rows;
    const first = rows;
    for (let f = 0; f < 3; f++) {
      toks.length = 0;
      if (f === 0) {
        // every segment once, the basename twice: the leaf's own name says the most
        scan(doc.path, 0, doc.path.length, false, toks);
        scan(doc.path, doc.path.lastIndexOf("/") + 1, doc.path.length, false, toks);
      } else if (f === 1) scan(doc.sig, 0, doc.sig.length, false, toks);
      else bodyTokens(doc.body, toks);
      for (const tok of toks) {
        let t = vocab.get(tok);
        if (t === undefined) {
          t = vocab.size;
          vocab.set(flat(tok), t);
          slot = grow(slot, t + 1, -1);
        }
        let row = slot[t];
        if (row < first) {
          row = rows++;
          if (rows > tmpTerm.length) {
            tmpTerm = grow(tmpTerm, rows);
            tmpTf = grow(tmpTf, 3 * tmpTerm.length);
          }
          tmpTerm[row] = t;
          slot[t] = row;
        }
        if (tmpTf[3 * row + f] < TF_MAX) tmpTf[3 * row + f]++;
      }
      lengths[3 * d + f] = toks.length;
      sum[f] += toks.length;
    }
    docStart[d + 1] = rows;
  }

  const n = paths.length;
  const start = new Uint32Array(vocab.size + 1);
  for (let r = 0; r < rows; r++) start[tmpTerm[r] + 1]++;
  for (let t = 0; t < vocab.size; t++) start[t + 1] += start[t];
  const next = start.slice(0, vocab.size);
  const postDoc = new Uint32Array(rows);
  const postTf = new Uint16Array(3 * rows);
  for (let d = 0; d < n; d++) {
    for (let r = docStart[d]; r < docStart[d + 1]; r++) {
      const p = next[tmpTerm[r]]++;
      postDoc[p] = d;
      postTf[3 * p] = tmpTf[3 * r];
      postTf[3 * p + 1] = tmpTf[3 * r + 1];
      postTf[3 * p + 2] = tmpTf[3 * r + 2];
    }
  }
  return { paths, vocab, start, postDoc, postTf, lengths: lengths.slice(0, 3 * n), avg: [sum[0] / (n || 1), sum[1] / (n || 1), sum[2] / (n || 1)] };
}

export function docCount(lex: LexIndex): number {
  return lex.paths.length;
}

export function vocabularySize(lex: LexIndex): number {
  return lex.vocab.size;
}

function idf(n: number, df: number): number {
  return Math.log(1 + (n - df + 0.5) / (df + 0.5));
}

/**
 * How rare a name is in this tree: the idf of its rarest word, so `getJwtClaims` ranks by `jwt`,
 * not by `get`. For ordering signature lists. 0 when nothing in it is a token.
 */
export function rarity(lex: LexIndex, word: string): number {
  let best = 0;
  for (const tok of tokenize(word)) {
    const t = lex.vocab.get(tok);
    best = Math.max(best, idf(lex.paths.length, t === undefined ? 0 : lex.start[t + 1] - lex.start[t]));
  }
  return best;
}

// ---- query -----------------------------------------------------------------------

/**
 * Function words only: articles, pronouns, auxiliaries, prepositions, question words, quantifiers,
 * and the stubs contractions leave behind (doesn't → doesn). The spike also dropped file(s), code,
 * page(s), module(s), place(s), live(s), include(s): those NAME things in a tree (page.tsx, invite
 * codes, live mode), so they stay and idf discounts them wherever they are common.
 */
const STOP = new Set(
  (
    "a an and are as at be but by can could did do does for from had has have how i if in into is it its of on or our so than that the their them " +
    "then there these they this those to under up was we were what when where which who whose why will with would you your " +
    "about against all any both each every including one some thing things two use used using " +
    "am been being me my us may might must shall should no nor not " +
    "aren couldn didn doesn don hadn hasn haven isn ll re shouldn ve wasn weren won wouldn"
  ).split(" "),
);

/** The English plural of `r`, so a query can reach what the S-stemmer made of it (cookies → cooky, caches → cach). */
function plural(r: string): string {
  if (/(s|x|z|ch|sh)$/.test(r)) return r + "es";
  if (/[^aeiou]y$/.test(r)) return r.slice(0, -1) + "ies";
  return r + "s";
}

/** hop, drop, plan: one short vowel + one consonant. These double (hopping) — so hoping, timing, used are NOT theirs. */
function isShort(r: string): boolean {
  return /^[^aeiouy]*[aeiou][^aeiouwxy]$/.test(r);
}

/**
 * Every form a query word might take in the tree, stemmed; the vocabulary decides which exist.
 * Inflection both ways (-s -ed -ing, doubled consonants, y → ied), the agent noun (-er) and
 * -ion → its verb: mint → minted minting minter; dropping → drop; verified → verify.
 * The guards stop MISREADS of a short stem (hoping ↛ hop, timing ↛ tim, calling ↛ cal, notion ↛
 * not). They do not stop a lexicalised noun reaching the different, commoner word it was built
 * on — settings → set, owner → own, header → head — and a group is scored as ONE term over the
 * union of its docs, so there the typed word's idf goes to the base. Letting the vocabulary
 * arbitrate (drop the base once the group's df passes 2× the typed word's) was measured on the
 * real index: pool recall unchanged, all-field MRR 0.681 → 0.641 on gold and 0.393 → 0.374 on
 * hidden, two rank-1 hits lost (throttling → throttle, worker → work). The drowning is the cheaper
 * error until the gold sets carry such rows. Deliberately no -or / -ation / -ment: those relatives
 * (consideration → consider, processor → process) are loose for every word, not just some.
 */
export function variants(word: string): string[] {
  const w = word.toLowerCase();
  const roots = new Set<string>([stem(w)]); // the index only holds stems
  if (w.length > 3 && /[^siu]s$/.test(w)) roots.add(w.slice(0, -1)); // cookies → cookie (the stemmer says cooky)
  if (w.length > 4 && /(s|x|z|ch|sh)es$/.test(w)) roots.add(w.slice(0, -2)); // statuses → status
  for (const r of [...roots]) {
    const base = (suffix: string, min: number) => (r.length >= min + suffix.length && r.endsWith(suffix) ? r.slice(0, -suffix.length) : undefined);
    const verb = (b: string | undefined) => {
      if (b === undefined) return;
      if (!isShort(b)) roots.add(b); // timing → time, never tim
      roots.add(b + "e");
    };
    for (const b of [base("ing", 3), base("ed", 3)]) {
      verb(b);
      // dropping → drop, controlled → control; but calling ↛ cal: a short verb's ll / ss / ff / zz is its own
      if (b && /(.)\1$/.test(b) && !(/[lsfz]$/.test(b) && isShort(b.slice(0, -1)))) roots.add(b.slice(0, -1));
    }
    verb(base("er", 3));
    verb(base("ion", 5)); // migration → migrate; too short a base is another word (notion ↛ not, mission ↛ miss)
    for (const b of [base("ied", 2), base("ier", 2)]) if (b !== undefined) roots.add(b + "y");
  }
  const out = new Set<string>();
  for (const r of roots) {
    if (r.length < MIN_TOKEN) continue;
    const forms = [r];
    const cut = r.slice(0, -1);
    if (r.length > 2) forms.push(plural(r));
    if (!isShort(r)) forms.push(r + "ed", r + "ing", r + "er");
    if (r.endsWith("e")) forms.push(cut + "ing", ...(r.length > 3 ? [r + "d", r + "r"] : [])); // see ↛ seed
    else if (/[^aeiou]y$/.test(r)) forms.push(cut + "ied", cut + "ier");
    else if (/[aeiou][^aeiouwxy]$/.test(r)) forms.push(r + r.at(-1) + "ed", r + r.at(-1) + "ing", r + r.at(-1) + "er"); // drop → dropping
    for (const f of forms) out.add(stem(f));
  }
  return [...out];
}

/** Docs that carry any term of the group, in any field. */
function groupDf(lex: LexIndex, group: string[]): number {
  if (group.length === 1) {
    const t = lex.vocab.get(group[0])!;
    return lex.start[t + 1] - lex.start[t];
  }
  const seen = new Uint8Array(lex.paths.length);
  let df = 0;
  for (const v of group) {
    const t = lex.vocab.get(v)!;
    for (let p = lex.start[t]; p < lex.start[t + 1]; p++) {
      if (!seen[lex.postDoc[p]]) df += seen[lex.postDoc[p]] = 1;
    }
  }
  return df;
}

/**
 * The query as scoring terms. Each word is ONE term whose group is every variant the vocabulary
 * holds; a word the tree never uses is kept with df 0 so the caller can say "not in this tree".
 * A CamelCase word (tRPC, SendBlue, OAuth) is read joined first — trpc, sendblue, oauth is how a
 * tree writes it, and its parts alone (rpc, send + blue, auth) rank the wrong files — then in
 * parts; when the tree knows the joined form, a part it never uses is dropped, not reported.
 * `extra` (an LLM's suggestions) can only add: a suggestion the tree never uses, or one that a
 * query word already covers, is dropped — a hallucinated term costs nothing.
 */
export function parseQuery(lex: LexIndex, query: string, extra: Array<{ term: string; weight: number }> = []): QueryTerm[] {
  const out: QueryTerm[] = [];
  /** Every form of every accepted term, so "sign signing" is one term, not the same evidence twice. */
  const taken = new Set<string>();
  /** Adds `word` as a term; true when the tree uses it (also when a term already covers it). */
  const add = (word: string, weight: number, keepUnknown: boolean): boolean => {
    if (word.length < MIN_TOKEN || word.length > MAX_TOKEN || !/[a-z]/.test(word) || STOP.has(word)) return false;
    const s = stem(word);
    if (STOP.has(s) || !(weight > 0)) return false;
    const forms = variants(word);
    const group = forms.filter((v) => lex.vocab.has(v));
    if (!taken.has(s) && (group.length || keepUnknown)) {
      for (const v of forms) taken.add(v);
      out.push({ label: word, group, weight, df: group.length ? groupDf(lex, group) : 0 });
    }
    return group.length > 0;
  };
  const read = (text: string, weight: number, keepUnknown: boolean) => {
    for (const raw of text.split(/[^A-Za-z0-9]+/)) {
      const parts = splitIdent(raw);
      const joined = parts.length > 1 && add(raw.toLowerCase(), weight, false);
      for (const part of parts) add(part, weight, keepUnknown && !joined);
    }
  };
  read(query, 1, true);
  for (const e of extra) read(e.term, e.weight, false);
  return out;
}

// ---- search ----------------------------------------------------------------------

const VIEW: Record<LexFields, readonly [boolean, boolean, boolean]> = {
  all: [true, true, true],
  path: [true, false, false],
  "path+sig": [true, true, false],
};

/** Code-unit order: the tie-break must not depend on the machine's locale. */
function order(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A count option: `d` when absent, else a whole number ≥ 0 — a budget / 2 or a NaN must neither throw nor slice from the end. */
function cap(x: number | undefined, d: number): number {
  return x === undefined ? d : Math.max(0, Math.floor(x) || 0);
}

function under(path: string, scope: string): boolean {
  return !scope || path === scope || (path.length > scope.length && path.charCodeAt(scope.length) === 47 && path.startsWith(scope));
}

/**
 * BM25F. A group's variants pool their length-normalised, field-weighted tf in a doc and share one
 * idf over the docs the group reaches IN THE SEARCHED FIELDS (a word common in bodies can still be
 * rare in paths) — so a term's `df` is for display, not read here. Collection statistics are global:
 * `scope` filters the result, it does not re-weigh. Ties break by path, so the same index and query
 * always give the same list.
 */
export function search(lex: LexIndex, terms: QueryTerm[], opts: { fields?: LexFields; scope?: string; limit?: number } = {}): LexHit[] {
  const n = lex.paths.length;
  const view = VIEW[opts.fields ?? "all"];
  const scope = (opts.scope ?? "").replace(/\/+$/, "");
  const { start, postDoc, postTf, lengths, avg } = lex;
  const score = new Float64Array(n);
  const acc = new Float64Array(n);
  const hit = new Uint8Array(n * terms.length);
  const touched: number[] = [];
  terms.forEach((term, ti) => {
    if (!(term.weight > 0)) return;
    touched.length = 0;
    for (const v of new Set(term.group)) {
      const t = lex.vocab.get(v);
      if (t === undefined) continue;
      for (let p = start[t]; p < start[t + 1]; p++) {
        const d = postDoc[p];
        let wtf = 0;
        for (let f = 0; f < 3; f++) {
          const tf = postTf[3 * p + f];
          if (tf && view[f]) wtf += (BM25.weight[f] * tf) / (1 - BM25.b[f] + (BM25.b[f] * lengths[3 * d + f]) / (avg[f] || 1));
        }
        if (wtf <= 0) continue;
        if (acc[d] === 0) touched.push(d);
        acc[d] += wtf;
      }
    }
    if (!touched.length) return;
    const w = term.weight * idf(n, touched.length);
    for (const d of touched) {
      score[d] += (w * acc[d]) / (BM25.k1 + acc[d]);
      acc[d] = 0;
      hit[d * terms.length + ti] = 1;
    }
  });
  const ids: number[] = [];
  for (let d = 0; d < n; d++) if (score[d] > 0 && under(lex.paths[d], scope)) ids.push(d);
  ids.sort((a, b) => score[b] - score[a] || order(lex.paths[a], lex.paths[b]));
  const limit = cap(opts.limit, Infinity);
  if (limit < ids.length) ids.length = limit;
  return ids.map((d, i) => ({
    path: lex.paths[d],
    score: score[d],
    rank: i + 1,
    matched: terms.filter((_, ti) => hit[d * terms.length + ti]).map((t) => t.label),
  }));
}

/**
 * THE candidate pool: the all-field top `all` ∪ the path-only top `path` (∪ the path+facts top
 * `sig`, off by default), all-field order first, then what only the narrower views found. No
 * single weighting works — a file that only TALKS about the query outranks the one named for it
 * once bodies count — and the union beat reciprocal-rank fusion on the hidden gold (26/31 vs 20/31
 * at the same size). Measured on cubby-law (4836 units, real facts text), gold (20 rows with an
 * accept) and hidden (31), as recall @ mean candidates: 30 ∪ 10 → 20/20 @36.3, 26/31 @38.3 (the
 * extra miss sits at all-field rank 32); 32 ∪ 10 → 20/20 @38.2, 27/31 @40.2; 30 ∪ 10 ∪ sig 10 →
 * 20/20 @37.0, 27/31 @40.5; 35 ∪ 10 → 27/31 @43.2. The default is the two-view pool that reaches
 * 27/31 with the fewest candidates and one search fewer; `sig` stays an option. The path view
 * recovers no gold row today (all-field 30 alone scores the same) and is kept as insurance for a
 * name that its body outranks. Every hit carries its all-field score and matches; `rank` is the
 * position in the pool.
 */
export function pool(lex: LexIndex, terms: QueryTerm[], opts: { scope?: string; all?: number; path?: number; sig?: number } = {}): LexHit[] {
  const ranked = search(lex, terms, { scope: opts.scope });
  const out = ranked.slice(0, cap(opts.all, 32));
  const seen = new Set(out.map((h) => h.path));
  let byPath: Map<string, LexHit> | undefined;
  const views: Array<[LexFields, number]> = [["path", cap(opts.path, 10)], ["path+sig", cap(opts.sig, 0)]];
  for (const [fields, limit] of views) {
    if (limit <= 0) continue;
    for (const h of search(lex, terms, { fields, scope: opts.scope, limit })) {
      if (seen.has(h.path)) continue;
      seen.add(h.path);
      byPath ??= new Map(ranked.map((r) => [r.path, r]));
      out.push({ ...(byPath.get(h.path) ?? h), rank: out.length + 1 });
    }
  }
  return out;
}

/**
 * Where the hits cluster: directories holding at least `min` of the top `top` hits, keeping only
 * the deepest of each chain (a parent adds nothing its child did not say), deepest first. Seeds
 * for a descent when the pool alone did not settle it. Never the root: that is where a walk starts anyway.
 */
export function anchors(hits: LexHit[], opts: { top?: number; min?: number; max?: number } = {}): string[] {
  const count = new Map<string, number>();
  for (const h of hits.slice(0, cap(opts.top, 10))) {
    for (let i = h.path.indexOf("/"); i > 0; i = h.path.indexOf("/", i + 1)) {
      const dir = h.path.slice(0, i);
      count.set(dir, (count.get(dir) ?? 0) + 1);
    }
  }
  const min = cap(opts.min, 2);
  const held = [...count.keys()].filter((d) => count.get(d)! >= min);
  const depth = (d: string) => d.split("/").length;
  return held
    .filter((d) => !held.some((o) => o.startsWith(d + "/")))
    .sort((a, b) => depth(b) - depth(a) || count.get(b)! - count.get(a)! || order(a, b))
    .slice(0, cap(opts.max, 3));
}

// ---- evidence --------------------------------------------------------------------

/**
 * What to show the verify step instead of a blind head: the first `head` non-empty lines, then up
 * to `windows` windows of ±`radius` lines around the lines that say the most about the query.
 * A line scores the sum, over the DISTINCT query terms on it, of weight / ln(2 + df) — rarer terms
 * first, more terms better, earlier line on a tie. Lines already shown never spend a window;
 * overlapping windows merge; "…" marks skipped text. Lines come out numbered ("97: \t\tjwt(),").
 */
export function evidenceLines(
  text: string,
  terms: QueryTerm[],
  opts: { head?: number; windows?: number; radius?: number; width?: number } = {},
): string[] {
  const head = cap(opts.head, 8);
  const windows = cap(opts.windows, 3);
  const radius = cap(opts.radius, 2);
  const width = opts.width ?? 140;
  const lines = (text.length > MAX_BODY ? text.slice(0, MAX_BODY) : text).split("\n");
  const keep = new Uint8Array(lines.length);
  for (let i = 0, shown = 0; i < lines.length && shown < head; i++) if (lines[i].trim()) shown += keep[i] = 1;

  const worth = new Map<string, { term: number; w: number }>();
  terms.forEach((t, term) => {
    if (t.df > 0 && t.weight > 0) for (const v of t.group) if (!worth.has(v)) worth.set(v, { term, w: t.weight / Math.log(2 + t.df) });
  });
  const scored: Array<{ i: number; s: number; k: number }> = [];
  const toks: string[] = [];
  if (worth.size && windows > 0) {
    lines.forEach((line, i) => {
      if (line.length > MAX_LINE) return;
      toks.length = 0;
      scan(line, 0, line.length, false, toks);
      const seen = new Set<number>();
      let s = 0;
      for (const tok of toks) {
        const m = worth.get(tok);
        if (!m || seen.has(m.term)) continue;
        seen.add(m.term);
        s += m.w;
      }
      if (seen.size) scored.push({ i, s, k: seen.size });
    });
  }
  scored.sort((a, b) => b.s - a.s || b.k - a.k || a.i - b.i);
  let used = 0;
  for (const c of scored) {
    if (used >= windows) break;
    if (keep[c.i]) continue;
    for (let j = Math.max(0, c.i - radius); j <= Math.min(lines.length - 1, c.i + radius); j++) keep[j] = 1;
    used++;
  }

  const out: string[] = [];
  let skipped = false;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trimEnd();
    if (!t.trim()) continue; // blank lines are neither shown nor counted as a gap
    if (!keep[i]) {
      skipped = true;
      continue;
    }
    if (skipped && out.length) out.push("…");
    skipped = false;
    out.push(`${i + 1}: ${t.length > width ? t.slice(0, width - 1) + "…" : t}`);
  }
  return out;
}
