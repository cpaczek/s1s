// The units of the line-by-line search: a file's text cut into COMMENT blocks (what the authors
// wrote about it) and CODE windows (the lines around the subject's words). Pure; TypeSafe judges
// the blocks (questions.ts: blockQuestion), code picks which to offer and which to keep.
import { tokenize, type QueryTerm } from "../index/lex.ts";
import { F, type FlowBlock } from "../questions.ts";

const PRAGMA = /^(eslint|prettier|@ts-|biome|use client|use server|use strict|SPDX|Copyright|Licensed|-\*-|#!|istanbul|c8 |v8 |noqa|pylint|type: ignore)/i;
const HASH_COMMENT = new Set(["py", "sh", "bash", "zsh", "yml", "yaml", "toml", "env", "example", "rb", "dockerfile", "makefile", "cfg", "ini", "conf"]);
const DASH_COMMENT = new Set(["sql", "lua", "hs"]);

/** The comment text of a line, or undefined when it is code. `inBlock` tracks /* … *\/. */
function commentText(line: string, ext: string, inBlock: { on: boolean }): string | undefined {
  const t = line.trim();
  if (t.startsWith("#!")) return ""; // a shebang is a comment that says nothing
  if (HASH_COMMENT.has(ext)) return t.startsWith("#") ? t.replace(/^#+\s?/, "") : undefined;
  if (DASH_COMMENT.has(ext)) return t.startsWith("--") ? t.replace(/^-+\s?/, "") : undefined;
  if (inBlock.on) {
    if (t.includes("*/")) inBlock.on = false;
    return t.replace(/^\*+\s?/, "").replace(/\*\/.*$/, "").trim();
  }
  if (t.startsWith("//")) return t.replace(/^\/+\s?/, "");
  if (t.startsWith("/*")) {
    if (!t.includes("*/")) inBlock.on = true;
    return t.replace(/^\/\*+\s?/, "").replace(/\*\/.*$/, "").trim();
  }
  if (t.startsWith("{/*")) return t.replace(/^\{\/\*+\s?/, "").replace(/\*\/\}.*$/, "").trim(); // JSX
  return undefined;
}

/** Explains nothing: a marker, a pragma, a divider, commented-out code. */
function noise(text: string): boolean {
  const t = text.trim();
  return !t || PRAGMA.test(t) || /^[-=*#/_~]+$/.test(t) || /^(todo|fixme|hack|xxx)\b/i.test(t) || /^(import |export |const |let |var |return |if \(|\}|\{|\)|;)/.test(t);
}

/**
 * Cut `text` into blocks. Comment blocks are runs of comment lines (a shebang or pragma run is
 * skipped) followed by the first code line they precede ("→ …"), so the judge sees what they explain.
 * Code windows are ±`radius` lines around lines carrying the subject's words, merged when they
 * touch. Blocks are ranked — comments by the subject words they carry then by length, code by
 * the rarity of the words matched — and the best `cap` are returned in file order.
 */
export function blocksOf(path: string, text: string, terms: QueryTerm[], opts: { cap?: number; lines?: number; radius?: number; width?: number } = {}): FlowBlock[] {
  const cap = opts.cap ?? F.BLOCKS_PER_UNIT;
  const maxLines = opts.lines ?? F.BLOCK_LINES;
  const radius = opts.radius ?? 2;
  const width = opts.width ?? F.LINE_WIDTH;
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  const lines = text.split("\n");
  const clip = (l: string) => (l.length > width ? l.slice(0, width - 1) + "…" : l);
  const forms = new Map<string, number>(); // word form → weight (rarer terms weigh more)
  for (const t of terms) for (const f of t.group) forms.set(f, Math.max(forms.get(f) ?? 0, t.weight / Math.log(2 + t.df)));
  const hits = lines.map((l) => (l.length > 400 ? 0 : tokenize(l).reduce((s, w) => s + (forms.get(w) ?? 0), 0)));

  type Ranked = { block: FlowBlock; score: number };
  const out: Ranked[] = [];

  // Comment blocks.
  const inBlock = { on: false };
  let run: { start: number; text: string[] } | undefined;
  const flush = (codeAt: number) => {
    if (!run) return;
    const first = run.text.findIndex((t) => !noise(t)); // the block starts at its first real line, not at a pragma above it
    const kept = run.text.filter((t) => !noise(t));
    if (kept.length) {
      // The code line the comment precedes, marked so a reader (and summaryOf) can tell it from prose.
      const anchor = codeAt < lines.length && lines[codeAt].trim() && lines[codeAt].length <= 400 ? ["→ " + clip(lines[codeAt].trim())] : [];
      const body = kept.slice(0, maxLines).map(clip);
      const words = body.reduce((s, l) => s + tokenize(l).reduce((a, w) => a + (forms.get(w) ?? 0), 0), 0);
      out.push({ block: { path, line: run.start + first + 1, kind: "comment", text: [...body, ...anchor] }, score: 1 + words * 4 + Math.min(body.join(" ").length, 400) / 400 });
    }
    run = undefined;
  };
  lines.forEach((line, i) => {
    const c = commentText(line, ext, inBlock);
    if (c !== undefined) {
      if (!run) run = { start: i, text: [] };
      run.text.push(c);
    } else if (run) {
      if (!line.trim()) return; // a blank line inside a comment run keeps the run open
      flush(i);
    }
  });
  flush(lines.length);
  const commentLines = new Set<number>();
  for (const r of out) for (let i = r.block.line - 1; i < r.block.line - 1 + r.block.text.length; i++) commentLines.add(i);

  // Code windows around the subject's words, outside comments, merged when they touch.
  const centres = lines.map((_, i) => i).filter((i) => hits[i] > 0 && !commentLines.has(i));
  let window: { from: number; to: number; score: number } | undefined;
  const windows: Array<typeof window & object> = [];
  for (const i of centres) {
    const from = Math.max(0, i - radius);
    const to = Math.min(lines.length - 1, i + radius);
    if (window && from <= window.to + 1) {
      window.to = to;
      window.score += hits[i];
    } else {
      if (window) windows.push(window);
      window = { from, to, score: hits[i] };
    }
  }
  if (window) windows.push(window);
  for (const w of windows) {
    const text = lines.slice(w.from, Math.min(w.to + 1, w.from + maxLines)).filter((l) => l.length <= 400).map(clip);
    if (text.some((l) => l.trim())) out.push({ block: { path, line: w.from + 1, kind: "code", text }, score: w.score });
  }

  return out
    .sort((a, b) => b.score - a.score || a.block.line - b.block.line)
    .slice(0, cap)
    .sort((a, b) => a.block.line - b.block.line)
    .map((r) => r.block);
}

/** The first sentence of a comment block, clipped: the summary a reader sees on the chart. */
export function firstSentence(text: string[], max: number = F.SUMMARY_CHARS): string {
  const flat = text.join(" ").replace(/\s+/g, " ").trim();
  const m = flat.match(/^(.+?[.!?])(\s|$)/);
  const s = (m ? m[1] : flat).trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  return cut.slice(0, Math.max(cut.lastIndexOf(" "), max - 30)).trim() + "…";
}
