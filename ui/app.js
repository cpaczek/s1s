/* System One Search UI — squarified treemap + live TypeSafe navigation trace.
   No build step, no network deps. Everything talks to the local server. */

import { renderFlow } from "./flow.js";
import { openEventStream, strategyFor } from "./transport.js";

/* Frame/handler timings — read them from the console as `__nav.perf`.
   Counters only; they cost a performance.now() per call. */
const PERF = {
  layoutMs: 0, layoutN: 0,
  baseMs: 0, baseN: 0,
  drawMs: 0, drawN: 0,
  hitMs: 0, hitN: 0,
  evMs: 0, evN: 0,
  rects: 0,
  reset() { for (const k of Object.keys(this)) if (typeof this[k] === "number") this[k] = 0; },
  avg() {
    const a = (ms, n) => (n ? +(ms / n).toFixed(3) : 0);
    return {
      rects: this.rects,
      layout: a(this.layoutMs, this.layoutN), layoutN: this.layoutN,
      paintBase: a(this.baseMs, this.baseN), paintBaseN: this.baseN,
      draw: a(this.drawMs, this.drawN), drawN: this.drawN,
      hitTest: a(this.hitMs, this.hitN), hitN: this.hitN,
      sseHandler: a(this.evMs, this.evN), sseN: this.evN,
      mainThreadMs: +(this.layoutMs + this.baseMs + this.drawMs + this.hitMs + this.evMs).toFixed(1),
    };
  },
};

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/* ------------------------------------------------------------------ tokens
   Colors live in CSS custom properties; the canvas reads them back so light
   and dark mode have exactly one source of truth. */

const TOKEN_NAMES = [
  "surface-1", "surface-2", "surface-3", "ink-1", "ink-2", "ink-3",
  "gridline", "baseline", "cat-1", "cat-2", "cat-3", "cat-other",
  "seq-1", "seq-2", "seq-3", "seq-4", "seq-5", "seq-6", "seq-7",
  "unvisited", "accent", "flash",
];

const C = {};      // token -> css color string
const RGB = {};    // token -> [r,g,b]
let SEQ = [];      // sequential ramp stops, low -> high

function parseColor(s) {
  s = String(s).trim();
  if (s[0] === "#") {
    if (s.length === 4) return [17 * parseInt(s[1], 16), 17 * parseInt(s[2], 16), 17 * parseInt(s[3], 16)];
    return [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
  }
  const m = s.match(/-?[\d.]+/g);
  return m ? [+m[0], +m[1], +m[2]] : [0, 0, 0];
}

function readTokens() {
  const cs = getComputedStyle(document.documentElement);
  for (const n of TOKEN_NAMES) {
    const v = cs.getPropertyValue("--" + n).trim();
    C[n] = v;
    RGB[n] = parseColor(v);
  }
  SEQ = [1, 2, 3, 4, 5, 6, 7].map((i) => RGB["seq-" + i]);
  rampCache = new Array(RAMP_STEPS + 1);
  inkCache = new Map();
  const ff = getComputedStyle(document.body).fontFamily;
  if (ff) FONT_STACK = ff;
}

const rgbStr = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;

/** Sequential blue ramp, heat 0..1. Interpolates the documented steps.
    Memoised on 256 buckets: the paint loop asks for this once per cell. */
const RAMP_STEPS = 256;
let rampCache = new Array(RAMP_STEPS + 1);

function rampColor(t) {
  const q = Math.round(clamp(t, 0, 1) * RAMP_STEPS);
  const hit = rampCache[q];
  if (hit !== undefined) return hit;
  const x = (q / RAMP_STEPS) * (SEQ.length - 1);
  const i = Math.min(SEQ.length - 2, Math.floor(x));
  const f = x - i;
  const a = SEQ[i], b = SEQ[i + 1];
  const out = rgbStr([
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  ]);
  rampCache[q] = out;
  return out;
}

/** inkOn() over a colour STRING, memoised — the paint loop repeats a handful of fills. */
let inkCache = new Map();
function inkFor(colorStr) {
  let v = inkCache.get(colorStr);
  if (v === undefined) { v = inkOn(parseColor(colorStr)); inkCache.set(colorStr, v); }
  return v;
}

const LIN = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };

/** WCAG relative luminance. */
function relLum(rgb) {
  return 0.2126 * LIN(rgb[0]) + 0.7152 * LIN(rgb[1]) + 0.0722 * LIN(rgb[2]);
}

/** A label inside a colored mark takes whichever ink actually contrasts better. */
function inkOn(rgb) {
  const l = relLum(rgb);
  return (l + 0.05) / 0.05 >= 1.05 / (l + 0.05) ? "#0b0b0b" : "#ffffff";
}

/* ---------------------------------------------------------------- families
   Categorical color by extension family, in the dataviz slot order.
   A treemap is an all-pairs adjacency surface: only the first three slots
   clear the CVD + normal-vision floors there, so everything past the third
   family folds into a neutral "Other". The tooltip always names the real ext. */

const IMG = new Set(["svg", "png", "webp", "jpg", "jpeg", "gif", "ico", "avif"]);
const FONT = new Set(["ttf", "otf", "woff", "woff2"]);

/** Nouns for a plain repository; /api/tree overrides them for other worlds. */
const REPO_DOMAIN = { unit: "file", container: "directory", world: "source-code repository", units: "files" };

/** depth-1 ancestor of a path ("apps/api/src" -> "apps"). */
function branchOf(path) {
  const i = path.indexOf("/");
  return i === -1 ? path : path.slice(0, i);
}

function familyOf(node) {
  // No extensions in this world (a taxonomy, say): colour by top-level branch.
  if (!S.hasExt) {
    const b = branchOf(node.path);
    const bn = S.byPath.get(b);
    return { key: b, label: bn ? bn.name : S.domain.container, slot: S.branchSlot.get(b) || "cat-other" };
  }
  const e = node.ext || "";
  if (e === "ts") return { key: "ts", label: "TypeScript", slot: "cat-1" };
  if (e === "tsx") return { key: "tsx", label: "React TSX", slot: "cat-2" };
  if (e === "sql") return { key: "sql", label: "SQL", slot: "cat-3" };
  if (e === "md") return { key: "md", label: "Markdown", slot: "cat-other" };
  if (e === "json") return { key: "json", label: "JSON", slot: "cat-other" };
  if (IMG.has(e)) return { key: "img", label: "Image", slot: "cat-other" };
  if (FONT.has(e)) return { key: "font", label: "Font", slot: "cat-other" };
  return { key: "other", label: e ? "." + e : "no extension", slot: "cat-other" };
}

/* ------------------------------------------------------------------- state */

const S = {
  tree: null,
  byPath: new Map(),
  parent: new Map(),
  zoom: "",
  metric: "lines",
  mode: "types",
  modePinned: false,
  hover: null,
  sel: null,
  topResult: null,
  heat: new Map(),          // path -> 0..1 (live during a run, exact after done)
  heatOn: false,            // a search has produced heat
  optP: new Map(),          // path -> { p, step }  (walk: probability at expansion)
  underH: new Map(),        // dir -> under-here 0..1
  beam: new Set(),
  flashes: [],              // { path, t0, dur, color }
  es: null,
  gotDone: false,
  // --- round 2 ---
  domain: REPO_DOMAIN,
  hasExt: true,             // this world's leaves carry file extensions
  hasLines: true,           // ...and line counts
  branchSlot: new Map(),    // depth-1 path -> categorical slot (non-repo worlds)
  branchNames: [],
  otherBranches: 0,
  strategy: "auto",
  repo: null,
  repos: [],
  loading: true,
  cached: false,
  liveNodes: new Map(),
  separation: undefined,
  runMode: "find",          // "find" = one unit; "map" = the heat map IS the answer; "explain" = the chart is
  topic: null,              // { name, includes, excludes }
  // --- explain ---
  view: "map",              // "map" = the treemap; "flow" = the chart explain drew
  flow: null,               // the renderer's api ({ destroy, select, fit, layout }) while a chart is mounted
  flowGraph: null,          // the FlowGraph behind it
  flowSel: null,            // selected node id in the chart
};

/** map and explain both answer with the whole map: no single top result, the topic names the heat. */
const mapLike = () => S.runMode === "map" || S.runMode === "explain";

/** Mirrors F.MEMBER (src/questions.ts): a judged unit is "in" (drawn) at or above this part. */
const PART_MIN = 0.5;

/* --------------------------------------------------------------- tree index */

function indexTree(root) {
  S.byPath.clear();
  S.parent.clear();
  const walk = (n, parent) => {
    S.byPath.set(n.path, n);
    if (parent !== null) S.parent.set(n.path, parent);
    if (n.children) for (const c of n.children) walk(c, n.path);
  };
  walk(root, null);
}

function linesOf(n) {
  if (n._ln !== undefined) return n._ln;
  let v = 0;
  if (n.kind === "file") v = n.lines || 0;
  else for (const c of n.children || []) v += linesOf(c);
  n._ln = v;
  return v;
}

const valueOf = (n) => (S.metric === "size" ? n.size : linesOf(n));

/* ------------------------------------------------------------- squarify
   Bruls, Huizing & van Wijk (2000). `emit(item, x, y, w, h)` per laid-out cell. */

function worstRatio(items, i, j, sum, side, scale) {
  let max = -Infinity, min = Infinity;
  for (let k = i; k <= j; k++) {
    const v = items[k].value;
    if (v > max) max = v;
    if (v < min) min = v;
  }
  const s = sum * scale;
  const s2 = s * s;
  const side2 = side * side;
  return Math.max((side2 * max * scale) / s2, s2 / (side2 * min * scale));
}

function squarify(items, x, y, w, h, emit) {
  let total = 0;
  for (const it of items) total += it.value;
  let i = 0;
  while (i < items.length && w > 0.5 && h > 0.5 && total > 0) {
    const vertical = w >= h;              // cut the strip off the longer side
    const side = vertical ? h : w;
    const scale = (w * h) / total;
    let rowSum = 0;
    let best = Infinity;
    let j = i;
    while (j < items.length) {
      const next = rowSum + items[j].value;
      const r = worstRatio(items, i, j, next, side, scale);
      if (r > best) break;
      best = r;
      rowSum = next;
      j++;
    }
    if (j === i) { rowSum = items[i].value; j = i + 1; }   // degenerate guard
    const thick = (rowSum * scale) / side;
    let off = 0;
    for (let k = i; k < j; k++) {
      const len = (items[k].value * scale) / thick;
      if (vertical) emit(items[k], x, y + off, thick, len);
      else emit(items[k], x + off, y, len, thick);
      off += len;
    }
    if (vertical) { x += thick; w -= thick; }
    else { y += thick; h -= thick; }
    total -= rowSum;
    i = j;
  }
}

/* --------------------------------------------------------------- layout */

const MIN_CELL = 2;          // skip anything under ~2px, per the brief
// Label strips are the loudest chrome on the map: only regions big enough to
// matter get one, so nested directories stop stacking into horizontal banding.
const STRIP_MIN_W = 92;
const STRIP_MIN_H = 36;
const STRIP_H = 11;

let rects = [];              // flat, DFS order: parents before children
let rectIndex = new Map();   // path -> rect (deepest wins; paths are unique)

function layout(w, h) {
  const _t = performance.now();
  rects = [];
  rectIndex = new Map();
  const root = S.byPath.get(S.zoom) || S.tree.root;
  if (!root) return;
  place(root, 0, 0, w, h, 0);
  for (const r of rects) rectIndex.set(r.node.path, r);
  PERF.layoutMs += performance.now() - _t; PERF.layoutN++; PERF.rects = rects.length;
}

function place(node, x, y, w, h, depth) {
  const r = { node, x, y, w, h, depth, strip: 0 };
  rects.push(r);
  if (node.kind === "file") return;
  if (w < 6 || h < 6) return;

  const pad = depth === 0 ? 0 : 1;
  const strip = depth > 0 && w >= STRIP_MIN_W && h >= STRIP_MIN_H ? STRIP_H : 0;
  r.strip = strip;

  const ix = x + pad;
  const iy = y + pad + strip;
  const iw = w - pad * 2;
  const ih = h - pad * 2 - strip;
  if (iw < MIN_CELL || ih < MIN_CELL) return;

  const kids = [];
  for (const c of node.children || []) {
    const v = valueOf(c);
    if (v > 0) kids.push({ node: c, value: v });
  }
  if (!kids.length) return;
  kids.sort((a, b) => b.value - a.value);

  squarify(kids, ix, iy, iw, ih, (it, cx, cy, cw, ch) => {
    if (cw < MIN_CELL || ch < MIN_CELL) return;
    place(it.node, cx, cy, cw, ch, depth + 1);
  });
}

/* ---------------------------------------------------------------- painting */

// Two stacked canvases. The map is painted straight onto `cv` and only when it
// is dirty; hover / frontier / selection / flashes live on `ovl`. A hover frame
// therefore touches neither the map's pixels nor a full-canvas blit of them.
const cv = $("map");
const bctx = cv.getContext("2d");
const ovl = $("overlay");
const octx = ovl.getContext("2d");
let dpr = 1, VW = 0, VH = 0;
let baseDirty = true;
let frameQueued = false;

function fillFor(node) {
  if (S.mode === "heat") {
    const v = S.heat.get(node.path);
    if (v === undefined) return C["unvisited"];
    return rampColor(v);
  }
  if (node.kind === "dir") return C["surface-2"];
  return C[familyOf(node).slot];
}

function paintBase() {
  const _t = performance.now();
  bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  bctx.clearRect(0, 0, VW, VH);
  bctx.fillStyle = C["surface-1"];
  bctx.fillRect(0, 0, VW, VH);
  bctx.textBaseline = "middle";
  bctx.font = `10px ${FONT_STACK}`;              // set once, not per label

  for (const r of rects) {
    const { node, x, y, w, h } = r;
    if (w < MIN_CELL || h < MIN_CELL) continue;

    if (node.kind === "dir") {
      if (r.depth === 0) continue;                       // root frame is the surface
      bctx.fillStyle = fillFor(node);
      bctx.fillRect(x, y, w, h);
      bctx.strokeStyle = C["gridline"];
      bctx.lineWidth = 1;
      bctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
      if (r.strip) {
        const heat = S.mode === "heat" ? S.heat.get(node.path) : undefined;
        const sc = heat !== undefined ? rampColor(heat) : C["surface-3"];
        bctx.fillStyle = sc;
        bctx.fillRect(x + 1, y + 1, w - 2, r.strip - 1);
        label(bctx, node.name, x + 4, y + 1 + r.strip / 2, w - 8, heat !== undefined ? inkFor(sc) : C["ink-2"], 10);
      }
      continue;
    }

    // leaf: 1px surface gap does the separating, no stroke
    const gap = w > 3 && h > 3 ? 1 : 0;
    const fw = w - gap, fh = h - gap;
    const col = fillFor(node);
    bctx.fillStyle = col;
    bctx.fillRect(x, y, fw, fh);
    if (fw >= 44 && fh >= 13) label(bctx, node.name, x + 3, y + fh / 2, fw - 6, inkFor(col), 10);
  }
  baseDirty = false;
  PERF.baseMs += performance.now() - _t; PERF.baseN++;
}

let FONT_STACK = "system-ui, sans-serif";


function label(c, text, x, y, maxW, ink, px) {
  if (maxW < 8) return;
  if (px !== 10) c.font = `${px}px ${FONT_STACK}`;
  if (c.measureText(text).width > maxW) return;
  c.fillStyle = ink;
  c.fillText(text, x, y);
}

function outline(c, r, color, width, inset) {
  c.strokeStyle = color;
  c.lineWidth = width;
  const o = width / 2 + (inset || 0);
  c.strokeRect(r.x + o, r.y + o, Math.max(0, r.w - o * 2), Math.max(0, r.h - o * 2));
}

const rectOf = (path) => rectIndex.get(path);

function draw() {
  const _t = performance.now();
  frameQueued = false;
  if (!rects.length) {
    bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    bctx.fillStyle = C["surface-1"];
    bctx.fillRect(0, 0, VW, VH);
    octx.setTransform(1, 0, 0, 1, 0, 0);
    octx.clearRect(0, 0, ovl.width, ovl.height);
    PERF.drawMs += performance.now() - _t; PERF.drawN++;
    return;
  }
  if (baseDirty) paintBase();

  const ctx = octx;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ovl.width, ovl.height);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // beam paths
  if (S.beam.size) {
    for (const p of S.beam) {
      const r = rectOf(p);
      if (r) outline(ctx, r, C["accent"], 2);
    }
  }
  // top result
  if (S.topResult) {
    const r = rectOf(S.topResult);
    if (r) { outline(ctx, r, C["ink-1"], 3); outline(ctx, r, C["surface-1"], 1, 3); }
  }
  // selection
  if (S.sel) {
    const r = rectOf(S.sel);
    if (r) outline(ctx, r, C["accent"], 2);
  }
  // hover
  if (S.hover) {
    const r = rectOf(S.hover);
    if (r) { outline(ctx, r, C["ink-1"], 1.5); }
  }
  // flashes
  const now = performance.now();
  let live = false;
  for (const f of S.flashes) {
    const t = (now - f.t0) / f.dur;
    if (t >= 1) continue;
    live = true;
    const r = rectOf(f.path);
    if (!r) continue;
    ctx.globalAlpha = 1 - t;
    outline(ctx, r, f.color, 3);
    ctx.globalAlpha = 1;
  }
  if (live) { S.flashes = S.flashes.filter((f) => now - f.t0 < f.dur); requestFrame(); }
  else if (S.flashes.length) S.flashes = [];
  PERF.drawMs += performance.now() - _t; PERF.drawN++;
}

function requestFrame() {
  if (frameQueued) return;
  frameQueued = true;
  requestAnimationFrame(draw);
}

function repaint() { baseDirty = true; requestFrame(); }

function flash(path, color) {
  if (!path) return;
  S.flashes.push({ path, t0: performance.now(), dur: 900, color: color || C["flash"] });
  requestFrame();
}

/* ------------------------------------------------------------------ resize */

function resize() {
  const wrap = $("canvasWrap");
  const w = wrap.clientWidth, h = wrap.clientHeight;
  if (!w || !h) return;
  // Past 2x there is nothing left to resolve in 1px hairlines and flat fills,
  // and the pixel count (and paint cost) grows with the square of the ratio.
  dpr = Math.min(2, window.devicePixelRatio || 1);
  VW = w; VH = h;
  cv.width = ovl.width = Math.round(w * dpr);
  cv.height = ovl.height = Math.round(h * dpr);
  bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  octx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (S.tree) { layout(w, h); $("mapEmpty").hidden = rects.length > 1; repaint(); }
}

/* ----------------------------------------------------------------- tooltip */

const tipEl = $("tip");

function fmtBytes(b) {
  if (b < 1024) return b + " B";
  if (b < 1024 * 1024) return (b / 1024).toFixed(b < 10240 ? 1 : 0) + " KB";
  return (b / 1048576).toFixed(b < 10485760 ? 1 : 0) + " MB";
}
const pct = (v) => (v * 100).toFixed(v > 0 && v < 0.095 ? 1 : 0) + "%";

function row(dl, k, v) {
  const dt = document.createElement("dt"); dt.textContent = k;
  const dd = document.createElement("dd"); dd.textContent = v;
  dl.append(dt, dd);
}

function showTip(r, mx, my) {
  const n = r.node;
  tipEl.textContent = "";

  const p = document.createElement("div");
  p.className = "t-path";
  p.textContent = n.path || "/";
  tipEl.append(p);

  const meta = document.createElement("div");
  meta.className = "t-meta";
  const bits = [
    n.kind === "dir" ? `${S.domain.container} · ${n.files.toLocaleString()} ${S.domain.units}` : familyOf(n).label,
    fmtBytes(n.size),
  ];
  const ln = n.kind === "dir" ? linesOf(n) : n.lines;
  if (ln) bits.push(ln.toLocaleString() + " lines");
  meta.textContent = bits.join("  ·  ");
  tipEl.append(meta);

  if (n.externalId || (n.aliases && n.aliases.length)) {
    const e = document.createElement("div");
    e.className = "t-exp";
    const parts = [];
    if (n.externalId) parts.push(n.externalId);
    if (n.aliases && n.aliases.length) parts.push("aka " + n.aliases.slice(0, 3).join(", "));
    e.textContent = parts.join("  ·  ");
    tipEl.append(e);
  }

  if (n.hint) {
    const h = document.createElement("div");
    h.className = "t-hint";
    h.textContent = n.hint.length > 150 ? n.hint.slice(0, 150) + "…" : n.hint;
    tipEl.append(h);
  }
  if (n.exports && n.exports.length) {
    const e = document.createElement("div");
    e.className = "t-exp";
    e.textContent = "exports " + n.exports.slice(0, 4).join(", ") + (n.exports.length > 4 ? ` +${n.exports.length - 4}` : "");
    tipEl.append(e);
  }
  if (n.themes && n.themes.length) {                     // what the model actually sees of a branch
    const t = document.createElement("div");
    t.className = "t-exp";
    t.textContent = "themes " + n.themes.slice(0, 8).join(", ");
    tipEl.append(t);
  }

  const heat = S.heat.get(n.path);
  const op = S.optP.get(n.path);
  const uh = S.underH.get(n.path);
  if (heat !== undefined || op || uh !== undefined) {
    const dl = document.createElement("dl");
    dl.className = "t-num";
    if (heat !== undefined) row(dl, "heat", pct(heat));
    if (op) row(dl, `p @ step ${op.step}`, pct(op.p));
    if (uh !== undefined) row(dl, "under here", pct(uh));
    tipEl.append(dl);
  } else if (S.heatOn) {
    const dl = document.createElement("dl");
    dl.className = "t-num";
    row(dl, "heat", "never looked at");
    tipEl.append(dl);
  }

  tipEl.hidden = false;
  const tw = tipEl.offsetWidth, th = tipEl.offsetHeight;
  tipEl.style.left = clamp(mx + 14, 4, Math.max(4, VW - tw - 4)) + "px";
  tipEl.style.top = clamp(my + 14, 4, Math.max(4, VH - th - 4)) + "px";
}

function hitTest(x, y) {
  const _t = performance.now();
  let hit = null;
  for (let i = rects.length - 1; i >= 0; i--) {
    const r = rects[i];
    if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) { hit = r; break; }
  }
  PERF.hitMs += performance.now() - _t; PERF.hitN++;
  return hit;
}

cv.addEventListener("mousemove", (e) => {
  const b = cv.getBoundingClientRect();
  const r = hitTest(e.clientX - b.left, e.clientY - b.top);
  const path = r ? r.node.path : null;
  if (path !== S.hover) { S.hover = path; requestFrame(); }
  if (r && r.depth > 0) showTip(r, e.clientX - b.left, e.clientY - b.top);
  else tipEl.hidden = true;
});

cv.addEventListener("mouseleave", () => {
  tipEl.hidden = true;
  if (S.hover) { S.hover = null; requestFrame(); }
});

cv.addEventListener("click", (e) => {
  const b = cv.getBoundingClientRect();
  const r = hitTest(e.clientX - b.left, e.clientY - b.top);
  if (!r || r.depth === 0) return;
  if (r.node.kind === "dir") setZoom(r.node.path);
  else selectFile(r.node.path);
});

/* -------------------------------------------------------------- zoom/crumbs */

function setZoom(path) {
  S.zoom = path;
  tipEl.hidden = true;
  S.hover = null;
  renderCrumbs();
  $("scopeName").textContent = path ? path : `/ (all ${S.domain.units})`;
  resize();
}

function renderCrumbs() {
  const el = $("crumbs");
  el.textContent = "";
  const rootName = (S.tree?.repo || "").split("/").filter(Boolean).pop() || "root";
  const parts = S.zoom ? S.zoom.split("/") : [];
  const mk = (text, path) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = text;
    b.addEventListener("click", () => setZoom(path));
    return b;
  };
  el.append(mk(rootName, ""));
  let acc = "";
  for (const p of parts) {
    acc = acc ? acc + "/" + p : p;
    const sl = document.createElement("span");
    sl.className = "sl";
    sl.textContent = "/";
    el.append(sl, mk(p, acc));
  }
}

/** `line` (explain): open the preview at that line. Explain rows are keyed by node id, not path — onFlowSelect keeps them. */
function selectFile(path, reveal, line) {
  S.sel = path;
  if (reveal) {
    const parent = S.parent.get(path);
    if (parent !== undefined && parent !== S.zoom) setZoom(parent);
    flash(path, C["flash"]);
  }
  requestFrame();
  loadPreview(path, line);
  for (const li of document.querySelectorAll(".res:not(.flowres)")) li.classList.toggle("sel", li.dataset.path === path);
}

/* ---------------------------------------------------------------- preview */

let previewVersion = 0;
async function loadPreview(path, line) {
  const version = ++previewVersion;
  $("prevPath").textContent = path.length > 46 ? "…" + path.slice(-45) : path;
  $("prevPath").title = path;
  $("prevPanel").open = true;
  const pre = $("prevCode");
  pre.textContent = "loading…";
  try {
    const res = await fetch(apiUrl("/api/file", { path }), { signal: AbortSignal.timeout(15_000) });
    const data = await res.json();
    if (version !== previewVersion) return;
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    if (!data.lines) { pre.textContent = data.error || "no preview"; return; }
    if (!line) { pre.textContent = data.lines.join("\n"); pre.scrollTop = 0; return; }
    previewAt(pre, path, data.lines, line);
    $("prevPanel").scrollIntoView({ block: "nearest" });   // the rail may be up at the results
  } catch (err) {
    if (version === previewVersion) pre.textContent = "Preview failed: " + err.message;
  }
}

/** Numbered lines with `line` marked and scrolled into view. /api/file stops at 200 lines; past
    that, the block the chart holds for this spot (verbatim source, from the FlowGraph) stands in. */
function previewAt(pre, path, lines, line) {
  pre.textContent = "";
  const frag = document.createDocumentFragment();
  const width = String(Math.max(lines.length, line)).length;
  let target = null;
  const add = (no, text) => {
    const s = document.createElement("span");
    s.className = "cl" + (no === line ? " hl" : "");
    const ln = document.createElement("span");
    ln.className = "ln";
    ln.textContent = String(no).padStart(width);
    s.append(ln, document.createTextNode(text || " "));
    if (no === line) target = s;
    frag.append(s);
  };
  lines.forEach((t, i) => add(i + 1, t));
  if (!target) {
    const ev = flowEvidenceAt(path, line);
    const note = document.createElement("span");
    note.className = "note";
    note.textContent = `… line ${line} is past the ${lines.length}-line preview` + (ev ? `; the judged ${ev.kind} block:` : "");
    frag.append(note);
    if (ev) ev.lines.forEach((t, k) => add(ev.line + k, t));
  }
  pre.append(frag);
  pre.scrollTop = 0;
  if (target) pre.scrollTop = Math.max(0, target.offsetTop - pre.offsetTop - pre.clientHeight / 3);
  else pre.scrollTop = pre.scrollHeight;
}

/** The chart's evidence block that covers path:line, if any. */
function flowEvidenceAt(path, line) {
  if (!S.flowGraph) return null;
  for (const n of S.flowGraph.nodes) {
    for (const ev of n.evidence || []) {
      if (ev.path === path && line >= ev.line && line < ev.line + ev.lines.length) return ev;
    }
  }
  return null;
}

/* ----------------------------------------------------------------- legend */

function legendSwatch(color, text) {
  const s = document.createElement("span");
  s.className = "lg-item";
  const sw = document.createElement("span");
  sw.className = "lg-sw";
  sw.style.background = color;
  const t = document.createElement("span");
  t.textContent = text;
  s.append(sw, t);
  return s;
}

/** The header carries the topic so the map is legible without the rail. */
function setTopicTag() {
  const tag = $("topicTag");
  const on = mapLike() && S.topic;
  tag.hidden = !on;
  tag.textContent = on ? S.topic.name : "";
  if (on) help(tag, "topic", { underline: false });
}

function renderLegend() {
  const el = $("legend");
  el.textContent = "";

  const sw = (color, text, key) => {
    const s2 = document.createElement("span");
    s2.className = "lg-item";
    const b = document.createElement("span");
    b.className = "lg-sw";
    b.style.background = color;
    const t = document.createElement("span");
    t.textContent = text;
    s2.append(b, t);
    if (key) help(s2, key);
    return s2;
  };

  if (S.mode === "types") {
    if (S.hasExt) {
      el.append(sw(C["cat-1"], ".ts", "types"), sw(C["cat-2"], ".tsx", "types"),
                sw(C["cat-3"], ".sql", "types"), sw(C["cat-other"], "other", "types"));
    } else {
      S.branchNames.forEach((name, i) => el.append(sw(C["cat-" + (i + 1)], name, "branchcolour")));
      if (S.otherBranches > 0) el.append(sw(C["cat-other"], `${S.otherBranches} more`, "branchcolour"));
    }
  } else {
    const wrap = document.createElement("span");
    wrap.className = "lg-item lg-ramp";
    const lab = document.createElement("span");
    lab.textContent = mapLike() && S.topic ? S.topic.name : "heat";
    const t0 = document.createElement("span"); t0.textContent = "0";
    const c = document.createElement("canvas");
    const px = window.devicePixelRatio || 1;
    c.width = Math.round(104 * px); c.height = Math.round(8 * px);
    const g = c.getContext("2d");
    for (let i = 0; i < c.width; i++) { g.fillStyle = rampColor(i / (c.width - 1)); g.fillRect(i, 0, 1, c.height); }
    const t1 = document.createElement("span"); t1.textContent = "1";
    wrap.append(lab, t0, c, t1);
    help(wrap, mapLike() ? "topic" : "heat");
    el.append(wrap, sw(C["unvisited"], "unvisited", "unvisited"));

    if (!mapLike()) {
      const ring = document.createElement("span");
      ring.className = "lg-item";
      const rs = document.createElement("span");
      rs.className = "lg-sw";
      rs.style.cssText = "background:transparent;box-shadow:0 0 0 1.5px " + C["ink-1"];
      const rt = document.createElement("span");
      rt.textContent = "top";
      ring.append(rs, rt);
      help(ring, "topresult");
      el.append(ring);
    }

  }

  const gap = document.createElement("span");
  gap.className = "lg-gap";
  el.append(gap);

  const m = document.createElement("span");
  m.textContent = S.metric === "size" ? (S.hasExt ? "bytes" : "size") : "lines";
  help(m, "metric");
  el.append(m);
}


/* ===================================================================== help
   One dictionary drives both the hover/focus tooltips and the "How it works"
   panel, so a term can never say two different things. `tip` is the 1–3
   sentence hover text; `full` (when present) is the longer prose the panel
   shows. Nouns are templated so the same text serves a repository and a
   taxonomy — see applyDomain(). */

function T(str) {
  const d = S.domain;
  return str
    .replace(/\{units\}/g, d.units)
    .replace(/\{unit\}/g, d.unit)
    .replace(/\{containers\}/g, d.container + "s")
    .replace(/\{container\}/g, d.container)
    .replace(/\{world\}/g, d.world);
}

const HELP = {
  // ---- strategies ----
  strategy: {
    title: "Strategy",
    tip: "How the search moves through the tree. find pools the {units} whose words match the query and judges those; walk descends {container} by {container}; map judges every {unit} that shares the subject’s words; explain draws how a subject works, as a chart made of the tree’s own {units} and references.",
  },
  "strat.auto": { title: "Auto", tip: "Questions beginning with how, explain or trace, or mentioning a flow, use Explain. Other questions use Find. Select a mode to override this rule." },
  "strat.find": {
    title: "find",
    tip: "The default. Recall is code, precision is TypeSafe: a zero-call lexical pool picks the {units} whose words match the query, one Noul per pooled {unit} shortlists them, and the best few are verified against each other. Only when nothing verifies as found does it walk down from the root and the pool’s anchor {containers}.",
    full: "The default. Recall is code, precision is TypeSafe. 1. A zero-call lexical pool (BM25 over each {unit}’s path, content facts and text) picks the {units} whose words match the query — or every {unit}, when the scope holds 250 or fewer. 2. One Noul per pooled {unit}, judged on its content descriptor, shortlists them. 3. The best six by shortlist Noul plus the best two lexical hits are verified against each other, on evidence aimed at the query’s words. 4. Only when nothing verifies as found does it escalate: a walk from the scope root and the pool’s anchor {containers}, whose finishers face the survivors in a second verify.",
  },
  "strat.walk": {
    title: "walk",
    tip: "Beam search down the {container} tree: one Choice per {container} over its children, and the K best paths survive to the next level.",
    full: "Beam search down the {container} tree. At each {container} TypeSafe answers one Choice question over the children (plus a “none of these” option); the K best paths survive to the next level (K = beam width). Path score = the geometric mean of the edge probabilities along the path. A beam can switch between the paths it kept, but a branch that fell out is gone for good.",
  },
  "strat.map": {
    title: "map",
    tip: "For a subject rather than a single {unit} (“where is authentication”). Code narrows the tree to the {units} whose path or content share the subject’s words (zero calls), then one membership Noul per {unit}. No verify stage — the heat map is the answer.",
    full: "For a subject rather than a single {unit} (“where is authentication”). Code narrows the tree to the {units} whose path or content share the subject’s words and their relatives in the tree’s own vocabulary (zero calls, capped at 320 by content); then one membership Noul per {unit} (“is this one of the places where the topic is implemented, configured, or used?”), 80 per call in parallel. No verify stage: the heat map is the answer, and every {unit} ≥ 0.35 is listed. Matches beyond the cap are counted, not judged.",
  },
  "strat.explain": {
    title: "explain",
    tip: "For “how does X work”. A map run gathers the {units} the subject lives in and the surest become seeds; from the seeds it expands over the import graph three hops, judging every reached {unit} (is it a step, is it plumbing, which role); then it judges the comment and code blocks inside each drawn {unit} and every reference between them. Code builds the chart — real identifiers, the authors’ own comments, real references; nothing is generated.",
    full: "For “how does X work”. 1. gather — a map run over the subject (the question with its scaffolding stripped); every {unit} at or above 0.5 is a member, the surest (≥ 0.7, at most six per package, twenty in all) are seeds. 2. expand — breadth-first over the import graph from the seeds, three hops. Each reached {unit} is judged in one round trip — is it a step of the subject (part), is it plumbing, which role does it play — with the real reference that led there in the state. Hubs (more importers than most of the tree) and plumbing (≥ 0.6) are drawn as leaves, never expanded through. 3. evidence — the comment blocks and code windows inside every drawn {unit}, each judged: does it explain or carry out a step? Kept blocks (≥ 0.7) become the {unit}’s evidence; the best comment’s first sentence is its summary. 4. edges — every real reference between drawn {units}, judged: does it carry the subject’s work (≥ 0.35 is drawn; the Noul is the wire’s opacity). 5. build — code: titles, clusters, direction, reading order, caps. found = at least one {unit} ≥ 0.7 joined by a reference; partial = {units} but no story; absent = nothing.",
  },
  beam: {
    title: "beam / width",
    tip: "walk: how many paths survive each level (default 3, the cookbook’s K). find: used only if it escalates to a walk. map and explain: unused.",
  },
  scope: {
    title: "Search only inside this {container}",
    tip: "Restricts the run to the {container} you have zoomed into (the “scope”).",
  },

  // ---- what TypeSafe answers ----
  choice: {
    title: "Choice",
    tip: "TypeSafe picks one option from a set and returns a probability for every option (they sum to 1) plus a confidence. Used at each {container}: the options are its children.",
  },
  noul: {
    title: "Noul",
    tip: "A yes/no judgment returned as a probability from 0 to 1 (0.87 = “very likely yes”). Used for under-here, shortlist, map and verify.",
  },
  none: {
    title: "none",
    tip: "The “__none__” option added to every Choice: “the target is not under any of these entries”. When it wins, the {container} is a dead end.",
  },
  underhere: {
    title: "under-here",
    tip: "A Noul asked alongside each expansion: “is the target somewhere under this {container} at all?” Independent of the Choice; below 0.10 the branch is pruned.",
  },
  confidence: {
    title: "confidence",
    tip: "How concentrated the Choice’s probabilities are (1 = all on one option, 0 = spread evenly). Comes from the distribution, not from the option that won.",
  },
  verify: {
    title: "verify / match",
    tip: "The final judge: each candidate is shown with its path, exported symbols, hint and its evidence lines, then a Noul per candidate with identical criteria plus one Choice across them. Results are ranked by the verify Noul.",
    full: "The final judge. Each candidate {unit} is shown with its path, exported symbols, hint and its evidence — in find, a short head plus windows around the lines matching the query’s rarest words; otherwise the first 25 lines. A Noul per candidate (“is this the {unit}?”) with identical criteria, plus one Choice across all candidates (“pick”). Results are ranked by the verify Noul.",
  },
  pick: {
    title: "pick",
    tip: "The final Choice’s probability for that candidate among the candidates (relative), as opposed to verify (absolute).",
  },
  pathScore: {
    title: "path score",
    tip: "Geometric mean of the edge probabilities from the root to this node, so deep paths are not penalised for being deep.",
  },
  separation: {
    title: "separation",
    tip: "Top score divided by the runner-up. Near 1× means a toss-up; 3× means a clear winner.",
  },
  verdict: {
    title: "verdict",
    tip: "found: top verify ≥ 0.70. partial: ≥ 0.35. absent: below that. Cutoffs from TypeSafe’s line-by-line search cookbook.",
  },

  // ---- reading the trace ----
  lexical: {
    title: "lexical pool",
    tip: "find, zero calls: every {unit}’s path, content facts and text are BM25-scored against the query’s words. A word with df 0 occurs nowhere in this tree (shown muted). The pool is the top 32 overall plus the top 10 by path; bars under “top” are relative to the best hit. Anchors are the {containers} the best hits cluster in — where a walk would start if the pool does not settle it.",
  },
  shortlist: {
    title: "shortlist",
    tip: "find: one Noul per pooled {unit} (“is this the {unit} the query describes?”), judged on its content descriptor, 60 per call in parallel. The best six, plus the best two lexical hits, go on to verify.",
  },
  escalate: {
    title: "escalate",
    tip: "find: the first verify did not reach found, so a walk starts from the scope root and the pool’s anchor {containers}. Its finishers face the surviving candidates in a second verify.",
  },
  batch: {
    title: "batch",
    tip: "map (and the map inside explain): one call of membership Nouls (80 {units}) landed and was painted. Batches run in parallel, so they land out of order.",
  },
  explain_seeds: {
    title: "seeds",
    tip: "explain: the map’s members (membership ≥ 0.5, best first) and the seeds the expansion starts from — the surest (≥ 0.7), at most six per package. Members are what the chart may draw; seeds are where it starts looking.",
  },
  explain_hop: {
    title: "hop",
    tip: "explain: one breadth-first step over the import graph. Every {unit} reached is judged in one round trip — is it a step of the subject (part), is it plumbing, which role — with the reference that led there in the state. “in” = part ≥ 0.5 (drawn); “expanding” = the ones whose own references the next hop follows; hubs and plumbing stay leaves.",
  },
  explain_evidence: {
    title: "evidence",
    tip: "explain: the comment blocks and code windows inside every drawn {unit}, each judged — does it explain or carry out a step of the subject? Blocks at or above 0.7 are kept as the {unit}’s evidence; the best comment’s first sentence becomes its summary in the chart.",
  },
  explain_edges: {
    title: "edges",
    tip: "explain: every real reference (import, re-export, a comment naming the other {unit}) between drawn {units}, judged — does it carry the subject’s work? At or above 0.35 it is drawn; the Noul sets the wire’s opacity.",
  },
  explain_done: {
    title: "chart",
    tip: "The chart is built by code from the judged {units}, blocks and references: titles are real identifiers, summaries the authors’ own comments, wires real references. found = at least one {unit} TypeSafe is sure of (≥ 0.7) joined by a reference; partial = {units} but no story between them; absent = nothing.",
  },
  frontier: {
    title: "frontier / beam row",
    tip: "The best open nodes after this step — the K survivors of a walk.",
  },
  backtrack: {
    title: "backtrack",
    tip: "The leading path jumped to a different branch than the previous leader’s.",
  },
  prune: {
    title: "prune",
    tip: "walk only: a candidate dropped because it fell outside the K survivors (“beam”) or its under-here Noul collapsed (“under_here”).",
  },
  trace: {
    title: "Trace",
    tip: "One row per step — a TypeSafe call, or the zero-call lexical pool — newest at the bottom. Hover any tag in the left column to learn what that step does.",
  },

  // ---- reading the map ----
  heat: {
    title: "Heat",
    tip: "walk: the path score of every node TypeSafe formed an opinion about (verified {units}: their verify Noul). find: each pooled {unit}’s shortlist Noul, verified {units} their verify Noul, and walk path scores if it escalated. map: the {unit}’s membership Noul. explain: the membership Noul, or the part a hop judged, whichever is higher. A {container} is as warm as the warmest {unit} beneath it. Gray = never looked at.",
  },
  view: {
    title: "Map / Flow",
    tip: "Map is the treemap, painted with this run’s heat. Flow is the chart explain drew: one box per {unit} (or symbol, group of siblings, or third-party package), one wire per real reference, rows by role, the heaviest import chain as the main path. Click a box to read its evidence; click a location to open it in Preview.",
  },
  unvisited: {
    title: "never looked at",
    tip: "TypeSafe formed no opinion about this node at all — distinct from “looked at and cold”, which is the palest blue on the ramp.",
  },
  topresult: {
    title: "top result",
    tip: "The candidate with the highest verify Noul, ringed on the map. A map run has no single top result, so the ring is not drawn.",
  },
  types: {
    title: "Types",
    tip: "Colour by {unit} family. Only three families get their own hue, because a treemap is an all-pairs adjacency surface and three is the colourblind-safe ceiling.",
  },
  branchcolour: {
    title: "Branch",
    tip: "This {world} has no {unit} types, so colour is the top-level branch instead — the three largest get a hue, the rest are neutral.",
  },
  metric: {
    title: "Bytes / Lines",
    tip: "What the cell area measures. Lines is the default because a handful of media {units} dominate bytes in this {world}.",
  },
  themes: {
    title: "themes",
    tip: "Words from the {unit} and {container} names beneath a {container}, ranked by how concentrated they are there versus the whole {world}. It is what TypeSafe sees about a {container} it hasn’t opened.",
  },
  topic: {
    title: "topic",
    tip: "The subject a map run tests membership against — the query as typed (explain: the question with its scaffolding stripped). It goes into the state of every membership Noul, so borderline {units} are judged against the same definition.",
  },

  // ---- cost ----
  "stats.calls": { title: "calls", tip: "TypeSafe requests made during this run." },
  "stats.tokens in": { title: "tokens in", tip: "Input tokens, billed at $0.042 per million." },
  "stats.tokens out": { title: "tokens out", tip: "Output tokens. They are free." },
  "stats.api ms": { title: "api ms", tip: "The sum of the per-call latencies." },
  "stats.wall ms": { title: "wall ms", tip: "Real elapsed time. Calls run in parallel, so wall is less than api." },
  "stats.est. cost": { title: "est. cost", tip: "tokens in × $0.042 / 1M." },
  "stats.model": { title: "model", tip: "The TypeSafe model that answered every Choice and Noul in this run." },

  // ---- chrome ----
  zoom: {
    title: "Breadcrumb",
    tip: "Click a {container} on the map to zoom into it; Escape or Backspace zooms out, and any crumb here jumps straight to that level.",
  },
  options: {
    title: "Options",
    tip: "Width (how many paths or frontier nodes survive a step) and whether the run is restricted to the {container} you have zoomed into.",
  },
  results: {
    title: "Results",
    tip: "Candidates ranked by their verify Noul. Each row shows verify%, then pick% (relative to the other candidates), the shortlist Noul (find), path score (walk), and where the candidate came from: the lexical pool, a descent, or the map battery. Click a row to select it on the map.",
  },
  theme: { title: "Theme", tip: "Auto follows the system setting; click to pin light or dark." },
};

/** Section order for the "How it works" panel. */
const HELP_SECTIONS = [
  ["Strategies", ["strat.find", "strat.walk", "strat.map", "strat.explain", "beam", "scope"]],
  ["What TypeSafe answers", ["choice", "noul", "none", "underhere", "confidence", "verify", "pick", "pathScore", "separation", "verdict"]],
  ["Reading the trace", ["lexical", "shortlist", "escalate", "batch", "frontier", "backtrack", "prune", "explain_seeds", "explain_hop", "explain_evidence", "explain_edges", "explain_done"]],
  ["Reading the map", ["heat", "unvisited", "topresult", "types", "metric", "themes", "topic", "view"]],
  ["Cost", ["stats.calls", "stats.tokens in", "stats.tokens out", "stats.api ms", "stats.wall ms", "stats.est. cost"]],
];

/* ---- the shared tooltip ------------------------------------------------- */

const helpTip = document.createElement("div");
helpTip.className = "htip";
helpTip.id = "helpTip";
helpTip.setAttribute("role", "tooltip");
helpTip.hidden = true;
document.body.append(helpTip);
let helpFor = null;

function showHelp(el) {
  const h = HELP[el.dataset.help];
  if (!h) return;
  helpTip.textContent = "";
  const t = document.createElement("b");
  t.textContent = T(h.title || el.dataset.help);
  const p = document.createElement("span");
  p.textContent = T(h.tip);
  helpTip.append(t, p);
  helpTip.hidden = false;

  const r = el.getBoundingClientRect();
  const w = helpTip.offsetWidth, hh = helpTip.offsetHeight;
  let left = clamp(r.left - 6, 8, Math.max(8, window.innerWidth - w - 8));
  let top = r.bottom + 6;
  if (top + hh > window.innerHeight - 8) top = Math.max(8, r.top - hh - 6);
  helpTip.style.left = Math.round(left) + "px";
  helpTip.style.top = Math.round(top) + "px";

  el.setAttribute("aria-describedby", "helpTip");
  helpFor = el;
}

function hideHelp() {
  if (helpFor) helpFor.removeAttribute("aria-describedby");
  helpFor = null;
  helpTip.hidden = true;
}

const helpTarget = (e) => (e.target instanceof Element ? e.target.closest("[data-help]") : null);

document.addEventListener("mouseover", (e) => { const el = helpTarget(e); if (el) showHelp(el); });
document.addEventListener("mouseout", (e) => { if (helpTarget(e)) hideHelp(); });
document.addEventListener("focusin", (e) => { const el = helpTarget(e); if (el) showHelp(el); else hideHelp(); });
document.addEventListener("focusout", hideHelp);
window.addEventListener("scroll", hideHelp, true);

/** Tag an element as explainable: hover, keyboard focus and a dotted underline. */
function help(el, key, opts) {
  el.dataset.help = key;
  if (!opts || opts.underline !== false) el.classList.add("hx");
  if (!el.matches("button, a, input, textarea, select, summary, [tabindex]")) el.tabIndex = 0;
  return el;
}

/* ---- the "How it works" panel ------------------------------------------- */

function renderHowItWorks() {
  const body = $("howBody");
  body.textContent = "";
  for (const [heading, keys] of HELP_SECTIONS) {
    const h = document.createElement("h3");
    h.className = "how-h";
    h.textContent = heading;
    body.append(h);
    const dl = document.createElement("dl");
    dl.className = "how-dl";
    for (const k of keys) {
      const e = HELP[k];
      if (!e) continue;
      const dt = document.createElement("dt");
      dt.textContent = T(e.title || k);
      const dd = document.createElement("dd");
      dd.textContent = T(e.full || e.tip);
      dl.append(dt, dd);
    }
    body.append(dl);
  }
}

/* ------------------------------------------------------------------ trace */

const traceEl = $("trace");
let traceN = 0;

function atBottom() {
  return traceEl.scrollHeight - traceEl.scrollTop - traceEl.clientHeight < 40;
}

/** Pin the trace to its newest row after a layout change. */
function scrollTrace() {
  requestAnimationFrame(() => { flushTrace(); traceEl.scrollTop = traceEl.scrollHeight; });
}

/* A live map emits rows faster than they can be read. Build the node
   immediately (cheap, and keeps the run's full history), but mount in one
   DocumentFragment per animation frame and keep only a window of rows in the
   DOM — one append + one scroll write per frame instead of per event. */
const TRACE_WINDOW = 300;
let tracePending = [];
let traceAll = [];
let traceFlushQueued = false;
let traceShowAll = false;

function traceRow(type, step, build) {
  const d = document.createElement("div");
  d.className = "tr";
  d.dataset.t = type;
  const st = document.createElement("span");
  st.className = "st";
  st.textContent = step === null || step === undefined ? "" : String(step);
  const tg = document.createElement("span");
  tg.className = "tg";
  tg.textContent = tagFor(type);
  const hk = TRACE_HELP[type];
  if (hk) tg.dataset.help = hk;
  const tb = document.createElement("span");
  tb.className = "tb";
  build(tb);
  d.append(st, tg, tb);
  traceAll.push(d);
  tracePending.push(d);
  traceN++;
  if (!traceFlushQueued) { traceFlushQueued = true; requestAnimationFrame(flushTrace); }
}

function flushTrace() {
  traceFlushQueued = false;
  if (!tracePending.length) return;
  const pin = atBottom();
  if (traceN === tracePending.length) traceEl.textContent = "";   // drop the hint row
  const frag = document.createDocumentFragment();
  for (const d of tracePending) frag.append(d);
  tracePending = [];
  traceEl.append(frag);
  if (!traceShowAll) {
    while (traceEl.children.length > TRACE_WINDOW) traceEl.removeChild(traceEl.firstChild);
  }
  $("traceCount").textContent = traceN + " events";
  const hidden = traceShowAll ? 0 : traceAll.length - traceEl.children.length;
  const btn = $("traceShowAll");
  btn.hidden = hidden <= 0;
  if (hidden > 0) btn.textContent = `show all ${traceAll.length} rows (${hidden} older hidden)`;
  if (pin) traceEl.scrollTop = traceEl.scrollHeight;
}

let runT0 = 0, runCalls = 0;

/** The collapsed trace summary: what the search is doing right now. */
function setTraceStatus(text, live) {
  const el = $("traceStatus");
  el.textContent = text;
  el.classList.toggle("live", !!live);
}

/** `call` is false for the steps that cost no TypeSafe call (the lexical pool, an escalation). */
function progress(verb, call = true) {
  if (call) runCalls++;
  const secs = ((performance.now() - runT0) / 1000).toFixed(1);
  setTraceStatus(`${verb} \u00b7 ${runCalls} call${runCalls === 1 ? "" : "s"} \u00b7 ${secs}s`, true);
}

/** A batch of unit Nouls landed (shortlist, map): paint each unit, and warm its {containers} to the max beneath. */
function paintUnits(rows) {
  for (const r of rows) S.heat.set(r.path, r.noul);
  for (const r of rows) {
    if (r.noul <= 0) continue;
    let parent = S.parent.get(r.path);
    while (parent !== undefined) {
      const prev = S.heat.get(parent);
      if (prev === undefined || r.noul > prev) S.heat.set(parent, r.noul);
      if (parent === "") break;
      parent = S.parent.get(parent);
    }
  }
  repaint();
}

/** One line of a trace disclosure: a path and a bar (relative or absolute, the caller decides). */
function traceLine(parent, path, frac, text) {
  const d = document.createElement("div");
  d.className = "trow";
  const bar = document.createElement("span");
  bar.className = "bar";
  const fill = document.createElement("i");
  fill.style.width = (clamp(frac, 0, 1) * 100).toFixed(1) + "%";
  bar.append(fill);
  d.append(pathSpan(path || "/"), bar);
  if (text) d.append(numSpan(text));
  parent.append(d);
}

function resetTrace() {
  traceN = 0;
  traceAll = [];
  tracePending = [];
  traceShowAll = false;
  traceEl.textContent = "";
  $("traceShowAll").hidden = true;
  $("traceCount").textContent = "";
  runT0 = performance.now();
  runCalls = 0;
}

$("traceShowAll").addEventListener("click", () => {
  traceShowAll = true;
  traceEl.textContent = "";
  const frag = document.createDocumentFragment();
  for (const d of traceAll) frag.append(d);
  traceEl.append(frag);
  $("traceShowAll").hidden = true;
  traceEl.scrollTop = traceEl.scrollHeight;
});

const TAG = { explain_seeds: "seeds", explain_hop: "hop", explain_evidence: "evidence", explain_edges: "edges", explain_done: "chart" };

/** Which help entry a trace tag explains. */
const TRACE_HELP = {
  expand: "choice", beam: "frontier", prune: "prune",
  backtrack: "backtrack", verify: "verify", lexical: "lexical", shortlist: "shortlist",
  escalate: "escalate", batch: "batch", done: "verdict", start: "strategy",
  explain_seeds: "explain_seeds", explain_hop: "explain_hop", explain_evidence: "explain_evidence",
  explain_edges: "explain_edges", explain_done: "explain_done",
};

/** Trace labels are shared with the help dictionary. */
function tagFor(type) {
  if (type === "beam") return "beam";
  return TAG[type] || type;
}

/** English-enough pluraliser for the domain nouns (directory -> directories). */
function plural(word, n) {
  if (n === 1) return word;
  return /[^aeiou]y$/.test(word) ? word.slice(0, -1) + "ies" : word + "s";
}

/** Last two segments of a path — enough to recognise it in a one-line row. */
function shortPath(p) {
  if (!p) return "/";
  const parts = p.split("/");
  return parts.length <= 2 ? p : "\u2026/" + parts.slice(-2).join("/");
}

function pathSpan(text) {
  const s = document.createElement("span");
  s.className = "p";
  s.textContent = text;
  return s;
}
function numSpan(text) {
  const s = document.createElement("span");
  s.className = "n";
  s.textContent = text;
  return s;
}

function optionBars(parent, options) {
  if (!options.length) return;
  const [first, ...rest] = options;
  const name = document.createElement("span");
  name.className = "p";
  name.textContent = first.kind === "none" ? "(none)" : first.name + (first.kind === "dir" ? "/" : "");
  const bar = document.createElement("span");
  bar.className = "bar";
  const fill = document.createElement("i");
  fill.style.width = (clamp(first.p, 0, 1) * 100).toFixed(1) + "%";
  bar.append(fill);
  parent.append(document.createTextNode(" \u2192 "), name, bar, numSpan(pct(first.p)));
  if (rest.length) {
    parent.append(numSpan("  " + rest.map((o) =>
      (o.kind === "none" ? "(none)" : o.name + (o.kind === "dir" ? "/" : "")) + " " + pct(o.p)).join(" \u00b7 ")));
  }
}

/* ---------------------------------------------------------------- results */

function renderResults(rows, truncated) {
  const wrap = $("results");
  wrap.textContent = "";
  $("resultsPanel").hidden = false;
  const note = $("truncNote");
  note.hidden = !(S.runMode === "map" && truncated > 0);
  if (!note.hidden) note.textContent = `${truncated.toLocaleString()} lexical match${truncated === 1 ? "" : "es"} beyond the prefilter ${truncated === 1 ? "was" : "were"} not judged`;
  if (!rows.length) { $("resultsMeta").textContent = "no candidates"; return; }

  if (S.runMode === "map") {
    $("resultsMeta").textContent = `${rows.length} place${rows.length === 1 ? "" : "s"}`;
    wrap.append(mapList(rows.slice(0, 80)));
    return;
  }
  const meta = [`${rows.length} candidate${rows.length === 1 ? "" : "s"}`];
  if (S.separation !== undefined) meta.push(`separation ${S.separation.toFixed(1)}\u00d7`);
  $("resultsMeta").textContent = meta.join(" \u00b7 ");

  // rank 1 is the answer line above, so the list carries the runners-up
  wrap.append(resultList(rows.slice(1, 12), 2));
}

/** A map run answers with the whole map; the list is just its readable index. */
function mapList(rows) {
  const ol = document.createElement("ol");
  ol.className = "results";
  rows.forEach((r, i) => {
    const li = document.createElement("li");
    li.className = "res mapres";
    li.dataset.path = r.path;
    if (r.path === S.sel) li.classList.add("sel");
    const rk = document.createElement("span");
    rk.className = "rk";
    rk.textContent = String(i + 1);
    const rp = document.createElement("span");
    rp.className = "rp";
    rp.textContent = r.path;
    const nv = document.createElement("span");
    nv.className = "nv";
    nv.textContent = pct(r.noul ?? r.score);
    const bar = document.createElement("span");
    bar.className = "nb";
    const fill = document.createElement("i");
    fill.style.width = (clamp(r.noul ?? r.score, 0, 1) * 100).toFixed(1) + "%";
    bar.append(fill);
    li.append(rk, rp, nv, bar);
    li.tabIndex = 0; li.setAttribute("role", "button");
    li.addEventListener("keydown", e => { if (e.target === li && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); selectFile(r.path); } });
    li.addEventListener("click", () => selectFile(r.path));
    ol.append(li);
  });
  return ol;
}

/** A candidate's numbers as plain text, no chips: "96% · pick 100% · shortlist 91% · lexical". */
function scoreLine(r) {
  const bits = [pct(r.verify ?? r.score)];
  if (r.pick !== undefined) bits.push("pick " + pct(r.pick));
  if (r.shortlist !== undefined) bits.push("shortlist " + pct(r.shortlist));
  if (r.pathScore !== undefined) bits.push("path " + pct(r.pathScore));
  if (r.noul !== undefined && r.noul !== r.shortlist) bits.push("noul " + pct(r.noul));   // find: noul IS the shortlist Noul
  bits.push(r.via);
  return bits.join("  ·  ");
}

function resultList(rows, startRank) {
  const ol = document.createElement("ol");
  ol.className = "results";
  const base = startRank ?? 1;
  rows.forEach((r, i) => {
    const li = document.createElement("li");
    li.className = "res";
    li.dataset.path = r.path;
    if (r.path === S.sel) li.classList.add("sel");

    const rk = document.createElement("span");
    rk.className = "rk";
    rk.textContent = String(i + base);

    const rp = document.createElement("span");
    rp.className = "rp";
    rp.textContent = r.path;

    const rev = document.createElement("button");
    rev.type = "button";
    rev.className = "reveal";
    rev.textContent = "reveal";
    rev.addEventListener("click", (e) => { e.stopPropagation(); selectFile(r.path, true); });

    const rv = document.createElement("span");
    rv.className = "rv";
    rv.textContent = scoreLine(r);
    help(rv, "verify");

    li.append(rk, rp, rev, rv);
    li.tabIndex = 0; li.setAttribute("role", "button");
    li.addEventListener("keydown", e => { if (e.target === li && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); selectFile(r.path); } });
    li.addEventListener("click", () => selectFile(r.path));
    ol.append(li);
  });
  return ol;
}

/** An explain run answers with the chart; the list is its reading order (title · role · cluster). */
function renderFlowResults(g) {
  const wrap = $("results");
  wrap.textContent = "";
  $("resultsPanel").hidden = false;
  const unit = S.domain.unit;
  const units = g.nodes.filter((n) => n.kind !== "package").length;
  const pk = g.nodes.length - units;
  const refs = g.edges.length;
  $("resultsMeta").textContent = [
    g.verdict,
    `${units} ${plural(unit, units)}`,
    `${refs} reference${refs === 1 ? "" : "s"}`,
    `${pk} package${pk === 1 ? "" : "s"}`,
  ].join(" · ");
  const d = g.dropped || { nodes: 0, edges: 0, hubs: [] };
  const note = $("truncNote");
  note.hidden = !(d.nodes || d.edges);
  if (!note.hidden) {
    const bits = [];
    if (d.nodes) bits.push(`${d.nodes} ${plural(unit, d.nodes)}`);
    if (d.edges) bits.push(`${d.edges} reference${d.edges === 1 ? "" : "s"}`);
    note.textContent = `left out: ${bits.join(" and ")}` + (d.hubs && d.hubs.length ? ` · ${d.hubs.length} hub${d.hubs.length === 1 ? "" : "s"}` : "");
  }
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const clusterTitle = new Map(g.clusters.map((c) => [c.id, c.title]));
  const ol = document.createElement("ol");
  ol.className = "results";
  const order = g.order.filter((id) => byId.has(id));
  for (const n of g.nodes) if (!order.includes(n.id)) order.push(n.id);
  order.forEach((id, i) => {
    const n = byId.get(id);
    const li = document.createElement("li");
    li.className = "res flowres";
    li.dataset.id = id;
    if (id === S.flowSel) li.classList.add("sel");
    const rk = document.createElement("span");
    rk.className = "rk";
    rk.textContent = String(i + 1);
    const rt = document.createElement("span");
    rt.className = "rt";
    rt.textContent = n.title;
    rt.title = n.kind === "package" ? n.title : n.path + (n.symbol ? "#" + n.symbol : "");
    const rr = document.createElement("span");
    rr.className = "rr";
    rr.textContent = n.role + (n.seed ? " · seed" : "");
    const rc = document.createElement("span");
    rc.className = "rc";
    rc.textContent = n.kind === "package" ? "package" : (clusterTitle.get(n.cluster) || n.cluster || "");
    li.append(rk, rt, rr, rc);
    li.tabIndex = 0; li.setAttribute("role", "button");
    li.addEventListener("keydown", e => { if (e.target === li && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); li.click(); } });
    li.addEventListener("click", () => { setView("flow"); if (S.flow) S.flow.select(id); });
    ol.append(li);
  });
  wrap.append(ol);
}

function renderTopic(topic) {
  const box = $("topicBox");
  box.textContent = "";
  if (!topic) { box.hidden = true; return; }
  box.hidden = false;
  const name = document.createElement("div");
  name.className = "tname";
  name.textContent = topic.name || "topic";
  box.append(name);
  const line = (label, list, cls) => {
    if (!list || !list.length) return;
    const d = document.createElement("div");
    d.className = "tline" + (cls ? " " + cls : "");
    const b = document.createElement("b");
    b.textContent = label + " ";
    d.append(b, document.createTextNode(list.join(", ")));
    box.append(d);
  };
  line("includes", topic.includes);
  line("excludes", topic.excludes, "exc");
  help(name, "topic", { underline: false });
}

function renderCost(st) {
  const el = $("costLine");
  el.hidden = false;
  const tokens = st.inputTokens + st.outputTokens;
  const compact = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "k" : String(n));
  const bits = [
    `${st.calls} call${st.calls === 1 ? "" : "s"}`,
    `${compact(tokens)} tokens`,
    `\u2248 $${st.estCostUsd.toFixed(4)}`,
    `${(st.wallMs / 1000).toFixed(1)} s`,
  ];
  el.textContent = (S.cached ? "Cached result · original run: " : "") + bits.join("  \u00b7  ");
  el.title = "";
  HELP["cost.line"] = {
    title: "Cost",
    tip: T(`${st.calls} TypeSafe calls \u00b7 ${st.inputTokens.toLocaleString()} input tokens (billed at $0.042/M) and `
      + `${st.outputTokens.toLocaleString()} output (free) \u00b7 ${st.apiMs.toLocaleString()}ms of call latency in `
      + `${st.wallMs.toLocaleString()}ms wall time, because calls run in parallel \u00b7 model ${st.model}.`),
  };
  help(el, "cost.line", { underline: false });
}

/* ------------------------------------------------------------------ search */

let elapsedTimer;
function setRunning(on) {
  clearInterval(elapsedTimer);
  $("runBtn").disabled = on || S.loading || !S.tree;
  $("qForm").setAttribute("aria-busy", String(on));
  $("suggestions").hidden = on;
  if (on) {
    const started = performance.now();
    const tick = () => { $("mapStatus").textContent = `Searching · ${((performance.now() - started) / 1000).toFixed(1)} s`; };
    tick(); elapsedTimer = setInterval(tick, 100);
  } else if (S.tree) $("mapStatus").textContent = `${S.tree.files.toLocaleString()} files indexed`;
  $("cancelBtn").hidden = !on;
  $("spin").hidden = !on;
}

function stopStream() {
  if (S.es) { S.es.close(); S.es = null; }
  setRunning(false);
}

function setMode(mode, pin) {
  S.mode = mode;
  if (pin) S.modePinned = true;
  for (const b of document.querySelectorAll("[data-mode]")) b.classList.toggle("on", b.dataset.mode === mode);
  renderLegend();
  repaint();
}

function showError(msg) {
  const e = $("err");
  e.hidden = false;
  e.textContent = msg;
  $("retryBtn").hidden = false;
}

/* ------------------------------------------------------------ flow view */

/** Map = the treemap (crumbs, canvases, legend); Flow = the chart in their place. */
function setView(v) {
  const flow = v === "flow" && !!S.flowGraph;
  S.view = flow ? "flow" : "map";
  for (const b of document.querySelectorAll("[data-view]")) b.classList.toggle("on", b.dataset.view === S.view);
  const wasHidden = $("flowHost").hidden;
  $("crumbs").hidden = flow;
  $("canvasWrap").hidden = flow;
  $("legend").hidden = flow;
  $("flowHost").hidden = !flow;
  $("metricSeg").classList.toggle("off", flow);
  $("modeSeg").classList.toggle("off", flow);
  tipEl.hidden = true;
  S.hover = null;
  // a hidden container has no size: re-fit the chart once it can be measured
  if (flow && wasHidden && S.flow) S.flow.fit();
}

function destroyFlow() {
  if (S.flow) { S.flow.destroy(); S.flow = null; }
  S.flowGraph = null;
  S.flowSel = null;
}

/** No chart any more (a new run, another strategy): back to the map, toggle gone. */
function dropFlow() {
  destroyFlow();
  $("viewSeg").hidden = true;
  setView("map");
}

/** Mount a fresh chart. The Flow view is switched on first (treemap hidden, host shown) so the
    renderer measures the whole map area, not a box it shares with the canvases. */
function showFlow(graph) {
  destroyFlow();
  S.flowGraph = graph;
  $("viewSeg").hidden = false;
  setView("flow");
  S.flow = renderFlow($("flowHost"), graph, { onSelect: onFlowSelect, onOpen: openAt, walkthroughCollapsed: true });
}

/** A node was selected in the chart: mark its row, and open its file at its first evidence line. */
function onFlowSelect(id) {
  S.flowSel = id;
  for (const li of document.querySelectorAll(".res.flowres")) li.classList.toggle("sel", li.dataset.id === id);
  if (!id || !S.flowGraph) return;
  const n = S.flowGraph.nodes.find((x) => x.id === id);
  if (!n || n.kind === "package") return;
  if (n.kind === "group") { S.sel = n.path; requestFrame(); return; }   // a folder of siblings: nothing to preview
  const ev = (n.evidence || [])[0];
  openAt(n.path, ev ? ev.line : undefined);
}

/** A location in the chart (evidence block, reference, wire): the Preview panel, at that line. */
function openAt(path, line) {
  selectFile(path, false, line);
}

/* ------------------------------------------------------------------ run */

function runSearch() {
  if (S.loading || !S.tree) return;
  const query = $("q").value.trim();
  if (!query) { showError(S.strategy === "explain" ? "Type a question first." : "Type a description first."); return; }
  stopStream();
  $("err").hidden = true;
  $("retryBtn").hidden = true;
  S.cached = false;
  S.lastResult = null;
  S.liveNodes.clear();

  const strategy = strategyFor(query, document.querySelector("[data-strategy].on").dataset.strategy);
  const beam = clamp(parseInt($("beam").value, 10) || 3, 1, 10);
  const scope = $("scoped").checked ? S.zoom : "";

  // reset run state
  dropFlow();
  S.heat = new Map();
  S.optP = new Map();
  S.underH = new Map();
  S.beam = new Set();
  S.topResult = null;
  S.heatOn = true;
  S.gotDone = false;
  S.runMode = strategy === "map" ? "map" : strategy === "explain" ? "explain" : "find";
  S.topic = null;
  $("topicBox").hidden = true;
  resetTrace();
  $("resultsPanel").hidden = true;
  $("costLine").hidden = true;
  $("truncNote").hidden = true;
  $("verdictBadge").hidden = true;
  $("topPath").hidden = true;
  $("topMeta").hidden = true;
  $("resultsMeta").textContent = "";
  S.separation = undefined;
  setMode("heat");
  setRunning(true);
  let landed = 0, shortlisted = 0;             // batches (map) / units (find) judged so far
  let blocksKept = 0, blocksJudged = 0, edgesKept = 0, edgesJudged = 0;   // explain

  const url = strategy === "explain"
    ? `/api/explain?question=${encodeURIComponent(query)}&scope=${encodeURIComponent(scope)}&depth=3`
    : `/api/search?query=${encodeURIComponent(query)}&strategy=${strategy}`
      + `&scope=${encodeURIComponent(scope)}&beam=${beam}&maxDepth=12`;
  const es = openEventStream(url + "&repo=" + encodeURIComponent(S.repo));
  S.es = es;

  // explain sends no `start`: say so ourselves, in the same row
  if (strategy === "explain") {
    setTraceStatus("starting…", true);
    traceRow("start", null, (tb) => tb.append(numSpan(`explain · depth 3 · scope ${scope || "/"}`)));
  }

  const on = (name, fn) => es.addEventListener(name, (ev) => {
    if (S.es !== es) return;
    const _t = performance.now();
    try { fn(JSON.parse(ev.data)); }
    catch (error) {
      stopStream();
      showError("Could not read the search result: " + error.message);
      setTraceStatus("failed", false);
    }
    PERF.evMs += performance.now() - _t; PERF.evN++;
  });
  on("queue", (d) => { setTraceStatus(d.message || "Waiting for a demo slot…", true); });
  on("cache", (d) => { S.cached = d.hit; });

  on("start", (d) => {
    setTraceStatus("starting\u2026", true);
    traceRow("start", null, (tb) => {
      const bits = [d.params.strategy];
      if (d.params.strategy !== "map") bits.push(`${"beam"} ${d.params.beam}`);
      bits.push(`scope ${d.params.scope || "/"}`);
      tb.append(numSpan(bits.join(" · ")));
    });
  });

  on("expand", (d) => {
    S.underH.set(d.path, d.underHere);
    for (const o of d.options) {
      if (o.kind === "none" || !o.path) continue;
      S.optP.set(o.path, { p: o.p, step: d.step });
      const prev = S.heat.get(o.path);
      if (prev === undefined || o.p > prev) S.heat.set(o.path, o.p);
    }
    const prevH = S.heat.get(d.path);
    if (prevH === undefined || d.underHere > prevH) S.heat.set(d.path, d.underHere);
    flash(d.path, C["flash"]);
    repaint();
    progress("expanding " + (d.path || "/"));
    traceRow("expand", d.step, (tb) => {
      tb.append(pathSpan(d.path || "/"), numSpan("  under " + pct(d.underHere)));
      optionBars(tb, d.options.slice(0, 3));
    });
  });

  on("beam", (d) => {
    S.beam = new Set(d.candidates.map((c) => c.path));
    requestFrame();
    traceRow("beam", d.step, (tb) => {
      const lead = d.candidates[0];
      if (lead) tb.append(pathSpan(lead.path || "/"), numSpan(" " + pct(lead.score)));
      if (d.candidates.length > 1) {
        tb.append(numSpan("  " + d.candidates.slice(1, 4).map((c) => shortPath(c.path) + " " + pct(c.score)).join(" · ")
          + (d.candidates.length > 4 ? ` +${d.candidates.length - 4}` : "")));
      }
    });
  });

  on("prune", (d) => {
    traceRow("prune", d.step, (tb) => {
      tb.append(pathSpan(d.path || "/"), numSpan(`  ${d.reason} · ${pct(d.score)}`));
    });
  });

  on("backtrack", (d) => {
    flash(d.to, C["flash"]);
    traceRow("backtrack", d.step, (tb) => {
      tb.append(numSpan("left "), pathSpan(shortPath(d.from)), numSpan(" \u2192 "), pathSpan(d.to || "/"));
    });
  });

  // find: the zero-call pool. Nothing is painted (no TypeSafe opinion yet); the
  // anchor containers flash so the eye lands where a walk would start.
  on("lexical", (d) => {
    for (const a of d.anchors.slice(0, 3)) flash(a, C["accent"]);
    const units = S.domain.units;
    progress(d.whole ? `shortlisting the whole scope, ${d.paths.length} ${units}` : `pooled ${d.paths.length} ${units}`, false);
    traceRow("lexical", null, (tb) => {
      const shown = d.terms.slice(0, 12);
      shown.forEach((t, i) => {
        if (i) tb.append(numSpan(" · "));
        const s = pathSpan(t.label);
        if (t.df === 0) s.classList.add("dim");
        tb.append(s, numSpan(" " + t.df));
      });
      if (d.terms.length > shown.length) tb.append(numSpan(` +${d.terms.length - shown.length}`));
      if (!shown.length) tb.append(numSpan("no indexable words"));
      tb.append(numSpan((shown.length ? "  · " : "  ")
        + (d.whole ? `whole scope, ${d.paths.length} ${units}` : `pool ${d.paths.length}`)
        + ` · ${Math.round(d.ms)} ms`));
      if (!d.top.length && !d.anchors.length) return;
      const det = document.createElement("details");
      det.className = "trd";
      const sum = document.createElement("summary");
      const parts = [];
      if (d.top.length) parts.push(`top ${d.top.length}`);
      if (d.anchors.length) parts.push(`${d.anchors.length} anchor${d.anchors.length === 1 ? "" : "s"}`);
      sum.textContent = parts.join(" · ");
      det.append(sum);
      const best = d.top[0]?.score || 1;
      for (const t of d.top) traceLine(det, t.path, t.score / best);
      if (d.anchors.length) {
        const a = document.createElement("div");
        a.className = "trow";
        a.append(numSpan("anchors "), pathSpan(d.anchors.join(", ")));
        det.append(a);
      }
      tb.append(det);
    });
  });

  // find: one Noul per pooled unit — painted as it lands, like a map batch
  on("shortlist", (d) => {
    paintUnits(d.candidates);
    shortlisted += d.candidates.length;
    progress(`shortlisting · ${shortlisted} ${S.domain.units}`);
    traceRow("shortlist", null, (tb) => {
      tb.append(numSpan(`${d.candidates.length}`));
      optionBars(tb, d.candidates.slice(0, 3).map((c) => ({ name: shortPath(c.path), kind: "file", p: c.noul })));
    });
  });

  // find: the first verify fell short — a walk starts from the scope root and the anchors
  on("escalate", (d) => {
    for (const s of d.seeds.slice(0, 3)) flash(s, C["accent"]);
    progress("escalating to a walk", false);
    traceRow("escalate", null, (tb) => {
      tb.append(numSpan(d.reason === "partial" ? "best verify only partial" : "nothing verified"),
        numSpan(" → walk from "), pathSpan(scope || "/"));
      if (d.seeds.length) tb.append(numSpan(" + "), pathSpan(d.seeds.map(shortPath).join(", ")));
    });
  });

  // map: one batch of membership Nouls landed; `heat` is every unit in it
  on("batch", (d) => {
    paintUnits(Object.entries(d.heat).map(([path, noul]) => ({ path, noul })));
    landed++;
    progress(`mapping · ${landed}/${d.batches} batches`);
    traceRow("batch", d.batch + 1, (tb) => {
      tb.append(numSpan(`${d.batch + 1}/${d.batches} · ${d.units} ${S.domain.units}`));
      optionBars(tb, d.top.slice(0, 3).map((t) => ({ name: shortPath(t.path), kind: "file", p: t.noul })));
    });
  });

  on("verify", (d) => {
    for (const c of d.candidates) S.heat.set(c.path, c.match);
    repaint();
    progress(`verifying ${d.candidates.length}`);
    traceRow("verify", null, (tb) => {
      tb.append(numSpan(`${d.candidates.length}`));
      optionBars(tb, d.candidates.slice(0, 3).map((c) => ({ name: shortPath(c.path), kind: "file", p: c.match })));
    });
  });

  on("done", (d) => {
    S.gotDone = true;
    stopStream();
    const r = d.result;
    S.lastResult = r;                            // handy from the console: __nav.state.lastResult
    S.heat = new Map(Object.entries(r.heat));
    S.beam = new Set();
    S.topResult = (r.mode === "map") ? null : (r.results[0]?.path || null);
    repaint();

    const badge = $("verdictBadge");
    badge.hidden = false;
    badge.textContent = r.verdict;
    badge.dataset.v = r.verdict;
    help(badge, "verdict", { underline: false });
    S.separation = r.separation;
    S.runMode = r.mode || "find";
    if (S.runMode === "map") {
      S.topic = r.topic || S.topic;
      $("topPath").hidden = true;                 // the map is the answer, not one path
      renderTopic(S.topic);
    } else {
      const top = r.results[0];
      $("topPath").hidden = false;
      $("topPath").textContent = top?.path || "no candidate";
      $("topMeta").hidden = !top;
      if (top) { $("topMeta").textContent = scoreLine(top); help($("topMeta"), "verify", { underline: false }); }
      $("topicBox").hidden = true;
    }
    setTopicTag();
    renderLegend();
    renderResults(r.results, r.truncated || 0);
    renderCost(r.stats);
    setTraceStatus(`${r.verdict} \u00b7 ${r.stats.calls} calls \u00b7 ${(r.stats.wallMs / 1000).toFixed(1)}s`, false);
    traceRow("done", null, (tb) => {
      const bits = [r.verdict];
      if (r.visited.length) bits.push(`${r.visited.length} ${plural(S.domain.container, r.visited.length)}`);
      bits.push(`${Object.keys(r.heat).length} scored`);
      if (r.truncated) bits.push(`${r.truncated} not judged`);
      tb.append(numSpan(bits.join(" · ")));
    });
    scrollTrace();
    if (S.topResult) flash(S.topResult, C["ink-1"]);
    else if (S.runMode === "map" && r.results[0]) flash(r.results[0].path, C["accent"]);
  });

  // explain: the map's members and the seeds the expansion starts from
  on("explain_seeds", (d) => {
    for (const s of d.seeds.slice(0, 3)) flash(s, C["accent"]);
    progress(`${d.members.length} members · expanding from ${d.seeds.length} seed${d.seeds.length === 1 ? "" : "s"}`, false);
    traceRow("explain_seeds", null, (tb) => {
      tb.append(numSpan(`${d.members.length} member${d.members.length === 1 ? "" : "s"}`));
      if (d.truncated) tb.append(numSpan(` · ${d.truncated} not judged`));
      const shown = d.seeds.slice(0, 3);
      tb.append(numSpan(` · ${d.seeds.length} seed${d.seeds.length === 1 ? "" : "s"} `), pathSpan(shown.length ? shown.map(shortPath).join(", ") : "none"));
      if (d.seeds.length > shown.length) tb.append(numSpan(` +${d.seeds.length - shown.length}`));
      if (!d.members.length) return;
      // seeds first, each marked; the rest of the members after them — all with their membership bar
      const det = document.createElement("details");
      det.className = "trd";
      const sum = document.createElement("summary");
      sum.textContent = `members ${d.members.length}`;
      det.append(sum);
      const seedSet = new Set(d.seeds);
      const rows = d.members.filter((m) => seedSet.has(m.path)).concat(d.members.filter((m) => !seedSet.has(m.path)));
      for (const m of rows) traceLine(det, m.path, m.noul, pct(m.noul) + (seedSet.has(m.path) ? " · seed" : ""));
      tb.append(det);
    });
  });

  // explain: one hop of the expansion — every reached unit judged (part / plumbing / role)
  on("explain_hop", (d) => {
    const inN = d.judged.filter((j) => j.part >= PART_MIN).length;
    const warmer = d.judged.filter((j) => (S.heat.get(j.path) ?? -1) < j.part).map((j) => ({ path: j.path, noul: j.part }));
    if (warmer.length) paintUnits(warmer);
    for (const p of d.expanded.slice(0, 3)) flash(p, C["flash"]);
    progress(`hop ${d.hop} · judged ${d.judged.length}`);
    for (const j of d.judged) if (j.part >= PART_MIN) S.liveNodes.set(j.path, {
      id: j.path, kind: "file", path: j.path, title: j.path.split("/").pop(), role: j.role,
      roleConfidence: j.roleConfidence ?? 0, part: j.part, cluster: j.path.split("/")[0],
      seed: false, terminal: j.plumbing >= .6, evidence: [],
    });
    if (S.liveNodes.size) {
      const nodes = [...S.liveNodes.values()].sort((a, b) => b.part - a.part).slice(0, 36);
      const priorView = S.view;
      showFlow({ topic: query, nodes, edges: [], clusters: [], order: nodes.map(n => n.id),
        dropped: { nodes: Math.max(0, S.liveNodes.size - 36), edges: 0, hubs: [] }, verdict: "partial" });
      setView(priorView); // keep the heatmap live; Flow is available while evidence is gathered
    }
    traceRow("explain_hop", d.hop, (tb) => {
      tb.append(numSpan(`judged ${d.judged.length} · ${inN} in · expanding ${d.expanded.length} → ${d.next} next`));
      if (!d.judged.length) return;
      const det = document.createElement("details");
      det.className = "trd";
      const sum = document.createElement("summary");
      sum.textContent = `judged ${d.judged.length}`;
      det.append(sum);
      const rows = d.judged.slice().sort((a, b) => b.part - a.part);
      for (const j of rows) {
        const bits = [pct(j.part), j.role];
        if (j.plumbing >= 0.6) bits.push("plumbing");
        if (d.expanded.includes(j.path)) bits.push("expanded");
        traceLine(det, j.path, j.part, bits.join(" · "));
      }
      tb.append(det);
    });
  });

  // explain: a batch of comment / code blocks judged; `top` = the best explaining ones in it
  on("explain_evidence", (d) => {
    blocksKept += d.kept; blocksJudged += d.judged;
    progress(`reading evidence · ${blocksKept}/${blocksJudged} blocks`);
    traceRow("explain_evidence", null, (tb) => {
      tb.append(numSpan(`${d.kept}/${d.judged} block${d.judged === 1 ? "" : "s"} explain it`));
      if (!d.top.length) return;
      const det = document.createElement("details");
      det.className = "trd";
      const sum = document.createElement("summary");
      sum.textContent = `top ${d.top.length}`;
      det.append(sum);
      for (const t of d.top) {
        const row = document.createElement("div");
        row.className = "trow";
        const bar = document.createElement("span");
        bar.className = "bar";
        const fill = document.createElement("i");
        fill.style.width = (clamp(t.score, 0, 1) * 100).toFixed(1) + "%";
        bar.append(fill);
        const ev = document.createElement("span");
        ev.className = "ev";
        ev.textContent = t.text || "";
        ev.title = t.text || "";
        row.append(pathSpan(`${shortPath(t.path)}:${t.line}`), bar, numSpan(`${pct(t.score)} · ${t.kind} `), ev);
        det.append(row);
      }
      tb.append(det);
    });
  });

  // explain: a batch of references between drawn units judged
  on("explain_edges", (d) => {
    edgesKept += d.kept; edgesJudged += d.judged;
    progress(`judging references · ${edgesKept}/${edgesJudged}`);
    traceRow("explain_edges", null, (tb) => {
      tb.append(numSpan(`${d.kept}/${d.judged} reference${d.judged === 1 ? "" : "s"} carry it`));
    });
  });

  on("explain_done", (d) => {
    S.gotDone = true;
    stopStream();
    const r = d.result;
    const g = r.graph;
    S.lastResult = r;
    S.heat = new Map(Object.entries(r.heat));
    S.beam = new Set();
    S.topResult = null;
    S.runMode = "explain";
    S.topic = { name: g.topic, includes: [], excludes: [] };
    $("verdictBadge").hidden = true;             // the verdict is plain text in the results line
    $("topPath").hidden = true;
    $("topMeta").hidden = true;
    $("topicBox").hidden = true;
    setTopicTag();
    renderLegend();
    repaint();
    showFlow(g);
    renderFlowResults(g);
    renderCost(r.stats);
    setTraceStatus(`${g.verdict} · ${r.stats.calls} calls · ${(r.stats.wallMs / 1000).toFixed(1)}s`, false);
    traceRow("explain_done", null, (tb) => {
      const units = g.nodes.filter((n) => n.kind !== "package").length;
      const bits = [g.verdict, `${units} ${plural(S.domain.unit, units)}`, `${g.edges.length} references`,
        `${r.stats.members} members`, `${r.stats.judged} judged`, `${r.stats.blocks} blocks`];
      if (g.dropped && (g.dropped.nodes || g.dropped.edges)) bits.push(`${g.dropped.nodes} + ${g.dropped.edges} left out`);
      tb.append(numSpan(bits.join(" · ")));
    });
    scrollTrace();
  });

  on("error", (d) => {
    S.gotDone = true;
    stopStream();
    showError(d.message || "search failed");
    setTraceStatus("failed", false);
    traceRow("error", null, (tb) => tb.append(numSpan(d.message || "search failed")));
    scrollTrace();
  });

  es.onerror = (error) => {
    if (S.gotDone || S.es !== es) return;                       // normal end-of-stream
    stopStream();
    showError(error.message || "The connection dropped. Retry the question.");
    setTraceStatus("failed", false);
  };
}

/* ------------------------------------------------------------------ wiring */

$("topPath").addEventListener("click", () => { if (S.topResult) selectFile(S.topResult, true); });
$("qForm").addEventListener("submit", (e) => { e.preventDefault(); runSearch(); });
function cancelRun() {
  if (!S.es) return;
  stopStream();
  setTraceStatus("cancelled", false);
  traceRow("cancel", null, (tb) => tb.append(numSpan("cancelled")));
  scrollTrace();
}
$("cancelBtn").addEventListener("click", cancelRun);
$("retryBtn").addEventListener("click", () => { if (!S.repos.length) boot(); else if (!S.tree) loadRepo(S.repo); else runSearch(); });
window.addEventListener("pagehide", stopStream);
$("q").addEventListener("input", updateRouteHint);

$("q").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); runSearch(); }
});

for (const b of document.querySelectorAll("[data-strategy]")) {
  b.addEventListener("click", () => {
    for (const o of document.querySelectorAll("[data-strategy]")) { o.classList.toggle("on", o === b); o.setAttribute("aria-pressed", String(o === b)); }
    S.strategy = b.dataset.strategy;
    const unused = S.strategy === "map" || S.strategy === "explain";
    $("beamLbl").textContent = "beam";
    $("beam").disabled = unused;
    $("beam").parentElement.style.opacity = unused ? "0.4" : "";
    setQueryPrompt();
    updateRouteHint();
    if (S.flow) dropFlow();                      // the chart belongs to the explain that drew it
  });
}
for (const b of document.querySelectorAll("[data-view]")) {
  b.addEventListener("click", () => setView(b.dataset.view));
}

/** The box asks for a description — or, for explain, a question. */
function setQueryPrompt() {
  const q = $("q");
  const d = S.domain;
  if (S.strategy === "explain") {
    q.placeholder = "ask how something works, e.g. how does authentication work";
    q.setAttribute("aria-label", "Ask how something works");
    return;
  }
  q.placeholder = S.strategy === "auto" ? "Ask where something lives, or how it works…" : `Describe the ${d.unit} you are looking for…`;
  q.setAttribute("aria-label", "Describe what you are looking for");
}
for (const b of document.querySelectorAll("[data-metric]")) {
  b.addEventListener("click", () => {
    for (const o of document.querySelectorAll("[data-metric]")) o.classList.toggle("on", o === b);
    S.metric = b.dataset.metric;
    renderLegend();
    resize();
  });
}
for (const b of document.querySelectorAll("[data-mode]")) {
  b.addEventListener("click", () => setMode(b.dataset.mode, true));
}

const THEMES = ["auto", "light", "dark"];
$("themeBtn").addEventListener("click", () => {
  const cur = document.documentElement.dataset.theme || "auto";
  const next = THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length];
  document.documentElement.dataset.theme = next;
  $("themeBtn").textContent = next[0].toUpperCase() + next.slice(1);
  $("themeBtn").title = "Theme: " + next;
  readTokens();
  renderLegend();
  repaint();
});
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  readTokens(); renderLegend(); repaint();
});

window.addEventListener("keydown", (e) => {
  const inField = /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(e.target.tagName);
  if (e.key === "/" && !inField) { e.preventDefault(); $("q").focus(); return; }
  if (e.key === "Escape") {
    if (!helpTip.hidden) { hideHelp(); return; }
    if (S.es) { cancelRun(); return; }
    if (inField) { e.target.blur(); return; }
    if (S.zoom) setZoom(S.parent.get(S.zoom) ?? "");
    return;
  }
  if (e.key === "Backspace" && !inField && S.zoom) {
    e.preventDefault();
    setZoom(S.parent.get(S.zoom) ?? "");
  }
});

new ResizeObserver(() => resize()).observe($("canvasWrap"));

window.__nav = {
  perf: PERF, state: S, rects: () => rects,
  /** Synchronous full repaints (base + overlay), ms per repaint. */
  bench(n = 40) {
    const t = performance.now();
    for (let i = 0; i < n; i++) { baseDirty = true; frameQueued = false; draw(); }
    return +((performance.now() - t) / n).toFixed(3);
  },
  /** Overlay-only frames, as a hover produces, ms per frame. */
  benchHover(n = 300) {
    baseDirty = true; frameQueued = false; draw();
    const t = performance.now();
    for (let i = 0; i < n; i++) {
      const r = hitTest(40 + (i * 11) % (VW - 80), 30 + (i * 17) % (VH - 60));
      S.hover = r ? r.node.path : null;
      frameQueued = false; draw();
    }
    return +((performance.now() - t) / n).toFixed(3);
  },
  canvasPixels: () => cv.width * cv.height,
};

/* -------------------------------------------------------------------- boot */

function apiUrl(path, params = {}) {
  return path + "?" + new URLSearchParams({ repo: S.repo || "local", ...params });
}
function updateRouteHint() {
  const mode = strategyFor($("q").value, S.strategy);
  $("routeHint").textContent = S.strategy === "auto"
    ? ($("q").value.trim() ? `Auto → ${mode === "explain" ? "a flow of real references" : "the file that answers it"}` : "A file for “where”. A flow for “how”.")
    : ({ find: "Find the file that answers the question.", map: "Map the files that belong to a subject.", explain: "Trace a subject through real references." })[S.strategy];
}
let repoVersion = 0;
async function loadRepo(id) {
  const version = ++repoVersion;
  stopStream();
  ++previewVersion;
  S.repo = id;
  S.loading = true;
  S.tree = null;
  S.byPath.clear(); S.parent.clear();
  rects = []; rectIndex.clear(); repaint();
  S.zoom = ""; S.sel = null; S.topResult = null; S.heat.clear(); S.optP.clear(); S.underH.clear(); S.beam.clear();
  S.heatOn = false; S.topic = null; S.lastResult = null; S.flashes = []; S.mode = "types";
  dropFlow(); resetTrace(); setTraceStatus("Trace", false);
  $("resultsPanel").hidden = true; $("costLine").hidden = true; $("prevPanel").open = false;
  $("prevCode").textContent = ""; $("prevPath").textContent = "nothing selected";
  $("err").hidden = true; $("retryBtn").hidden = true; $("runBtn").disabled = true;
  $("repoPath").textContent = "Loading repository…"; $("mapStatus").textContent = "Loading index…";
  setTopicTag();
  const repo = S.repos.find(r => r.id === id);
  $("repoSelect").value = id;
  $("repoDescription").textContent = repo?.description || "";
  const source = $("repoSource");
  source.hidden = !/^https:\/\//.test(repo?.url || "");
  if (!source.hidden) source.href = repo.url;
  $("suggestions").textContent = "";
  for (const question of repo?.questions || []) {
    const button = document.createElement("button");
    button.type = "button"; button.textContent = question;
    button.addEventListener("click", () => { $("q").value = question; updateRouteHint(); $("q").focus(); runSearch(); });
    $("suggestions").append(button);
  }
  try {
    const res = await fetch(apiUrl("/api/tree"), { signal: AbortSignal.timeout(30_000) });
    const tree = await res.json();
    if (version !== repoVersion) return;
    if (!res.ok) throw new Error(tree.error || `HTTP ${res.status}`);
    if (!tree.root || !Number.isFinite(tree.files)) throw new Error("The repository index is invalid.");
    S.tree = tree; S.loading = false;
    indexTree(S.tree.root); applyDomain(); renderLegend(); renderCrumbs(); resize(); setRunning(false);
    const url = new URL(location.href); url.searchParams.set("repo", id); history.replaceState(null, "", url);
    $("mapStatus").textContent = `${tree.files.toLocaleString()} files indexed`;
  } catch (err) {
    if (version !== repoVersion) return;
    S.loading = false;
    $("mapStatus").textContent = "Repository unavailable";
    showError("Could not load this repository: " + err.message);
  }
}
async function boot() {
  readTokens(); renderLegend();
  try {
    const res = await fetch("/api/repos", { signal: AbortSignal.timeout(15_000) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    if (!Array.isArray(data.repos) || !data.repos.length) throw new Error("No repositories are configured.");
    S.repos = data.repos;
    const select = $("repoSelect"); select.textContent = "";
    for (const repo of S.repos) { const option = document.createElement("option"); option.value = repo.id; option.textContent = repo.name; select.append(option); }
    select.disabled = false;
    const requested = new URLSearchParams(location.search).get("repo");
    const id = S.repos.some(r => r.id === requested) ? requested : (data.defaultRepo || S.repos[0].id);
    await loadRepo(id);
  } catch (error) { $("mapStatus").textContent = "Connection unavailable"; showError("Could not load repositories: " + error.message); }
}
$("repoSelect").addEventListener("change", () => loadRepo($("repoSelect").value));
boot();

/** Teach the chrome this tree's nouns, and work out what it can even be coloured by. */
function applyDomain() {
  S.domain = S.tree.domain || REPO_DOMAIN;
  const d = S.domain;

  let hasExt = false, hasLines = false;
  for (const n of S.byPath.values()) {
    if (n.kind !== "file") continue;
    if (n.ext) hasExt = true;
    if (n.lines) hasLines = true;
    if (hasExt && hasLines) break;
  }
  S.hasExt = hasExt;
  S.hasLines = hasLines;

  // No extensions to colour by: fall back to the top-level branch, capped at the
  // three validated categorical slots (a treemap is an all-pairs adjacency surface).
  S.branchSlot = new Map();
  S.branchNames = [];
  S.otherBranches = 0;
  if (!hasExt) {
    const kids = (S.tree.root.children || []).slice().sort((a, b) => b.files - a.files);
    kids.slice(0, 3).forEach((k, i) => {
      S.branchSlot.set(k.path, "cat-" + (i + 1));
      S.branchNames.push(k.name);
    });
    S.otherBranches = Math.max(0, kids.length - 3);
  }

  const segs = S.tree.repo.split("/").filter(Boolean);
  $("repoPath").textContent = S.repos.find(r => r.id === S.repo)?.name || (segs.length > 2 ? "…/" : "/") + segs.slice(-2).join("/");
  HELP.repo = {
    title: S.tree.repo.split("/").filter(Boolean).pop() || "tree",
    tip: `${S.tree.repo} \u2014 ${S.tree.files.toLocaleString()} ${d.units}, indexed in ${S.tree.buildMs}ms. `
      + `Indexed once: names, paths, themes, exported symbols and text (for the lexical pool). TypeSafe is shown a short descriptor per ${d.unit}, never a whole one.`,
  };
  setQueryPrompt();
  $("containerNoun").textContent = d.container;
  $("scopeName").textContent = `/ (all ${d.units})`;
  $("modeTypes").textContent = hasExt ? "Types" : "Branch";
  $("metricSize").textContent = hasExt ? "Bytes" : "Size";
  $("metricLines").hidden = !hasLines;
  if (!hasLines) {
    S.metric = "size";
    $("metricSize").classList.add("on");
    $("metricLines").classList.remove("on");
  }
  document.querySelector(".map").setAttribute("aria-label", `${d.world} treemap`);
  wireHelp();
  renderHowItWorks();
}

/** Attach the help layer to everything static. Dynamic nodes call help() as they are built. */
function wireHelp() {
  help($("repoPath"), "repo", { underline: false });
  help($("crumbs"), "zoom", { underline: false });
  for (const b of document.querySelectorAll("[data-strategy]")) help(b, "strat." + b.dataset.strategy, { underline: false });
  for (const b of document.querySelectorAll("[data-metric]")) help(b, "metric", { underline: false });
  help($("modeTypes"), S.hasExt ? "types" : "branchcolour", { underline: false });
  help($("modeHeat"), "heat", { underline: false });
  for (const b of document.querySelectorAll("[data-view]")) help(b, "view", { underline: false });
  help($("beamLbl"), "beam");
  help($("optsPanel").querySelector("summary"), "options", { underline: false });
  help($("containerNoun"), "scope");
  help($("resultsInfo"), "results", { underline: false });
  help($("tracePanel").querySelector("summary"), "trace", { underline: false });
  help($("themeBtn"), "theme", { underline: false });
}
