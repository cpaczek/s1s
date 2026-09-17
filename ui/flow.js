/* flow.js — renderer for a FlowGraph (src/flow/types.ts): a layered chart plus a walkthrough.

   layoutFlow(graph, opts)      pure, deterministic, Node-runnable. Text measurement is injected through
                                opts.measure(text, fontKey); the default is a character-width table.
   renderFlow(el, graph, opts)  inline SVG chart + synchronized walkthrough, pan/zoom, hover/select.

   Layout in one breath: every node sits in a row keyed (stage, depth) — stage is its role's rank in
   FLOW_ROLE_ORDER, never earlier than a static importer's stage; depth is the reference chain inside a
   stage. Rows are therefore honest: a row labelled GUARD holds guards. Third-party packages form a floor
   under everything, fed by one bus. Clusters (workspace packages) are packed as non-overlapping bands;
   per-row barycenter sweeps order the nodes; long edges get dummy channels in the gaps between bands.
   The heaviest import chain is the spine: one strong stroke, and the "Main path" of the walkthrough.
   Nothing here invents text: every word drawn comes from the graph. */

export const FLOW_ROLE_ORDER = ["ui", "client", "entrypoint", "guard", "handler", "service", "config", "persistence", "external", "test"];
const RANK = new Map(FLOW_ROLE_ORDER.map((r, i) => [r, i]));

export const FONTS = {
  title: { size: 12, weight: 500, family: "sans" },
  titleKey: { size: 12.5, weight: 600, family: "sans" },
  pkg: { size: 11.5, weight: 500, family: "mono" },
  sub: { size: 10, weight: 400, family: "mono" },
  summary: { size: 11, weight: 400, family: "sans" },
  label: { size: 10, weight: 400, family: "mono" },
  role: { size: 9, weight: 500, family: "sans", tracking: 0.06 },
  cluster: { size: 10.5, weight: 500, family: "sans" },
};

const DEFAULTS = {
  nodeGap: 24, // between nodes in one row
  clusterGap: 44, // between cluster bands side by side
  layerGap: 52, // between rows
  channel: 14, // between parallel edge channels
  track: 8, // between parallel side-edge tracks
  clusterPad: 10,
  clusterHead: 18,
  margin: 20,
  gutter: 0, // the stage labels live in screen space (renderer), not in the chart
  keyWidth: 230,
  minWidth: 120,
  maxWidth: 196,
  keyShare: 0.3, // share of nodes drawn as rich cards (seeds and the spine always are)
  keyMin: 4,
  keyMax: 12,
  richLimit: 36, // above this many nodes only seeds and the spine get rich cards
  labelMin: 0.72, // carries needed for a label to be shown without hovering
  spineMin: 0.55, // carries needed for an edge to be part of the spine
  floorGap: 28, // between third-party packages
  sweeps: 10,
  debug: false,
};

/* ----------------------------------------------------------------- text */

const NARROW = /[iljI.,:;'`|!\s]/;
const SEMI = /[tfr()[\]{}\/\\\-"*]/;
const WIDE = /[mwMW@%]/;
const CAPS = /[A-HJ-LN-VX-Z]/;
function charUnits(ch) {
  if (NARROW.test(ch)) return 0.3;
  if (SEMI.test(ch)) return 0.4;
  if (WIDE.test(ch)) return 0.82;
  if (CAPS.test(ch)) return 0.66;
  if (/[0-9]/.test(ch)) return 0.56;
  if (ch.charCodeAt(0) > 0x2e7f) return 1.0; // CJK
  return 0.54;
}
/** Default measurement: a per-character width table. Good enough for boxes; the browser injects canvas. */
export function approxMeasure(text, fontKey) {
  const f = FONTS[fontKey] || FONTS.title;
  let w = 0;
  if (f.family === "mono") w = text.length * 0.6;
  else for (const ch of text) w += charUnits(ch);
  if (f.weight >= 600) w *= 1.04;
  if (f.tracking) w += text.length * f.tracking;
  return w * f.size;
}

function ellipsisEnd(text, maxW, font, measure) {
  if (measure(text, font) <= maxW) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (measure(text.slice(0, mid).trimEnd() + "…", font) <= maxW) lo = mid; else hi = mid - 1;
  }
  return lo === 0 ? "…" : text.slice(0, lo).trimEnd() + "…";
}
/** Middle ellipsis that keeps the tail (file name) whole: `apps/admin-api/…/mcp/verifier.ts`. */
function ellipsisMid(text, maxW, font, measure) {
  if (measure(text, font) <= maxW) return text;
  const cut = text.lastIndexOf("/");
  const tail = cut >= 0 ? text.slice(cut) : text.slice(-10);
  if (measure("…" + tail, font) > maxW) return ellipsisEnd(text, maxW, font, measure);
  const head = text.slice(0, text.length - tail.length);
  let lo = 0, hi = head.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (measure(head.slice(0, mid) + "…" + tail, font) <= maxW) lo = mid; else hi = mid - 1;
  }
  return head.slice(0, lo) + "…" + tail;
}
/** Word-wrap into at most maxLines; the last line ends in an ellipsis when text was dropped; every line fits. */
function wrapText(text, maxW, font, maxLines, measure) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = "";
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const next = cur ? cur + " " + w : w;
    if (measure(next, font) <= maxW) { cur = next; continue; }
    if (cur) lines.push(cur);
    cur = w;
    if (lines.length === maxLines) break;
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  const used = lines.join(" ");
  if (used.length < text.trim().length || lines.length > maxLines) {
    lines.length = Math.min(lines.length, maxLines);
    const last = lines.length - 1;
    const rest = text.slice(text.indexOf(lines[last]));
    lines[last] = ellipsisEnd(rest, maxW, font, measure);
  }
  return lines.map((l) => ellipsisEnd(l, maxW, font, measure));
}
/** Identifiers handed over: as many as fit, then "+N"; never an ellipsis inside an identifier. */
function labelText(names, maxW, measure) {
  if (!names || !names.length) return "";
  let t = names[0];
  for (let i = 1; i < names.length; i++) {
    const next = t + ", " + names[i];
    const rest = names.length - i;
    if (measure(next + (rest > 1 ? " +" + (rest - 1) : ""), "label") > maxW) return t + " +" + rest;
    t = next;
  }
  return measure(t, "label") <= maxW ? t : ellipsisEnd(t, maxW, "label", measure);
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const dirname = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const basename = (p) => p.slice(p.lastIndexOf("/") + 1);
const fmt = (v) => Math.round(v * 10) / 10;

/** The path line under a title, relative to the node's cluster: `src/mcp` under `apps/admin-api`. */
function subline(n) {
  if (n.kind === "package") return "";
  let p = n.kind === "file" ? dirname(n.path || "") : n.path || "";
  const c = n.cluster || "";
  if (c && p === c) p = n.kind === "file" ? "" : basename(p);
  else if (c && p.startsWith(c + "/")) p = p.slice(c.length + 1);
  if (n.kind === "group" && p) p += "/";
  return p;
}

/* -------------------------------------------------------------- geometry */

/** Channels of edges that share a target and a line style merge into one trunk (a fan-in reads as a river). */
const styleOf = (e) => (e.back ? "b" : e.kind === "mention" ? "m" : e.kind === "via" ? "v" : "i");
const bundleOf = (it) => (it.real ? null : it.edge.to + "|" + styleOf(it.edge));

const AR = 6; // arrow length
const JOG = 10, SWEEP = 13, CORNER = 6;
/** Path data for a polyline: orthogonal runs get rounded corners, a diagonal hop becomes an S sweep. */
function pathOf(pts) {
  const p = pts.filter((q, i) => i === 0 || Math.abs(q[0] - pts[i - 1][0]) > 0.01 || Math.abs(q[1] - pts[i - 1][1]) > 0.01);
  if (p.length < 2) return "";
  let d = `M${fmt(p[0][0])} ${fmt(p[0][1])}`;
  for (let i = 1; i < p.length; i++) {
    const [x0, y0] = p[i - 1], [x1, y1] = p[i];
    const diag = Math.abs(x1 - x0) > 0.5 && Math.abs(y1 - y0) > 0.5;
    if (diag) { const ym = (y0 + y1) / 2; d += `C${fmt(x0)} ${fmt(ym)} ${fmt(x1)} ${fmt(ym)} ${fmt(x1)} ${fmt(y1)}`; continue; }
    const next = p[i + 1];
    const nextOrtho = next && !(Math.abs(next[0] - x1) > 0.5 && Math.abs(next[1] - y1) > 0.5) && !(Math.abs(next[0] - x1) < 0.5 && Math.abs(x1 - x0) < 0.5) && !(Math.abs(next[1] - y1) < 0.5 && Math.abs(y1 - y0) < 0.5);
    if (!nextOrtho) { d += `L${fmt(x1)} ${fmt(y1)}`; continue; }
    const l1 = Math.hypot(x1 - x0, y1 - y0), l2 = Math.hypot(next[0] - x1, next[1] - y1);
    const r = Math.min(CORNER, l1 / 2, l2 / 2);
    const u1 = [(x1 - x0) / l1, (y1 - y0) / l1], u2 = [(next[0] - x1) / l2, (next[1] - y1) / l2];
    d += `L${fmt(x1 - u1[0] * r)} ${fmt(y1 - u1[1] * r)}Q${fmt(x1)} ${fmt(y1)} ${fmt(x1 + u2[0] * r)} ${fmt(y1 + u2[1] * r)}`;
  }
  return d;
}
/** Sample points along a polyline (the S sweeps sampled on their cubic) for collision tests. */
function samplePath(pts, step = 6) {
  const out = [];
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
    const n = Math.max(2, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / step));
    const diag = Math.abs(x1 - x0) > 0.5 && Math.abs(y1 - y0) > 0.5;
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      if (diag) { const mt = 1 - t; out.push([mt * mt * mt * x0 + 3 * mt * mt * t * x0 + 3 * mt * t * t * x1 + t * t * t * x1, y0 + (y1 - y0) * t]); }
      else out.push([x0 + (x1 - x0) * t, y0 + (y1 - y0) * t]);
    }
  }
  return out;
}
const inRect = (p, r, m = 0) => p[0] > r[0] - m && p[0] < r[2] + m && p[1] > r[1] - m && p[1] < r[3] + m;

/* ---------------------------------------------------------------- layout */

/** 0. Sanitize: stable node and edge order, third-party packages set aside as the floor. */
function prepare(graph, opts) {
  const o = { ...DEFAULTS, ...opts };
  const measure = o.measure || approxMeasure;
  const byId = new Map();
  for (const n of graph.nodes || []) if (n && typeof n.id === "string") byId.set(n.id, n);
  const orderIdx = new Map((graph.order || []).map((id, i) => [id, i]));
  const oi = (id) => (orderIdx.has(id) ? orderIdx.get(id) : 1e9);
  const nodes = [...byId.values()].sort((a, b) => oi(a.id) - oi(b.id) || cmp(a.id, b.id));
  const edges = (graph.edges || [])
    .filter((e) => e && byId.has(e.from) && byId.has(e.to) && e.from !== e.to)
    .map((e) => ({ ...e, names: Array.isArray(e.names) ? e.names : [], carries: Number.isFinite(e.carries) ? clamp(e.carries, 0, 1) : 0.5, at: typeof e.at === "string" ? e.at : "" }))
    .sort((a, b) => cmp(a.from, b.from) || cmp(a.to, b.to) || cmp(a.kind, b.kind) || cmp(a.at, b.at))
    .map((e, i) => ({ ...e, i }));
  const floor = new Set(nodes.filter((n) => n.kind === "package").map((n) => n.id));
  const body = nodes.filter((n) => !floor.has(n.id));
  return { graph, o, measure, byId, oi, nodes, edges, floor, body };
}

/** 1. Rows: (stage, depth) per node. Stage = role rank, never before a static importer's stage; depth =
   reference chain inside the stage. Tests sit just above what they exercise. Packages sit on the floor. */
function stageNodes(S) {
  const { byId, edges, body, floor } = S;
  const bodySet = new Set(body.map((n) => n.id));
  const isTest = (id) => byId.get(id).role === "test";
  const structural = edges.filter((e) => !e.back && e.kind !== "mention" && bodySet.has(e.from) && bodySet.has(e.to));
  const main = structural.filter((e) => !isTest(e.from));
  const outS = new Map(body.map((n) => [n.id, []]));
  for (const e of main) outS.get(e.from).push(e);
  for (const l of outS.values()) l.sort((a, b) => cmp(a.to, b.to) || a.i - b.i);
  // cycles the graph did not flag: the edge closing a DFS cycle is drawn as a back edge
  const state = new Map();
  const broken = new Set();
  const dfs = (root) => {
    const stack = [[root, 0]];
    state.set(root, 1);
    while (stack.length) {
      const top = stack[stack.length - 1];
      const list = outS.get(top[0]);
      if (top[1] >= list.length) { state.set(top[0], 2); stack.pop(); continue; }
      const e = list[top[1]++];
      const s = state.get(e.to);
      if (s === 1) broken.add(e); else if (!s) { state.set(e.to, 1); stack.push([e.to, 0]); }
    }
  };
  for (const n of body) if (!state.has(n.id)) dfs(n.id);
  const fwd = main.filter((e) => !broken.has(e));
  const pred = new Map(body.map((n) => [n.id, []]));
  const succ = new Map(body.map((n) => [n.id, []]));
  const indeg = new Map(body.map((n) => [n.id, 0]));
  for (const e of fwd) { pred.get(e.to).push(e.from); succ.get(e.from).push(e.to); indeg.set(e.to, indeg.get(e.to) + 1); }
  let ready = body.filter((n) => indeg.get(n.id) === 0).map((n) => n.id).sort(cmp);
  const topo = [];
  while (ready.length) {
    const id = ready.shift();
    topo.push(id);
    for (const s of succ.get(id)) { indeg.set(s, indeg.get(s) - 1); if (indeg.get(s) === 0) { ready.push(s); ready.sort(cmp); } }
  }
  const stage = new Map(), depth = new Map();
  for (const id of topo) {
    if (isTest(id)) continue;
    const n = byId.get(id);
    let st = RANK.has(n.role) ? RANK.get(n.role) : 5;
    for (const p of pred.get(id)) if (!isTest(p) && stage.has(p)) st = Math.max(st, stage.get(p));
    let dp = 0;
    for (const p of pred.get(id)) if (!isTest(p) && stage.has(p) && stage.get(p) === st) dp = Math.max(dp, depth.get(p) + 1);
    stage.set(id, st); depth.set(id, dp);
  }
  for (const n of body) {
    if (!isTest(n.id)) continue;
    const ss = structural.filter((e) => e.from === n.id && !isTest(e.to) && stage.has(e.to)).map((e) => e.to)
      .sort((a, b) => stage.get(a) - stage.get(b) || depth.get(a) - depth.get(b) || cmp(a, b));
    if (ss.length) { stage.set(n.id, stage.get(ss[0])); depth.set(n.id, depth.get(ss[0]) - 0.5); }
    else { stage.set(n.id, RANK.get("test")); depth.set(n.id, 0); }
  }
  const keyOf = (id) => stage.get(id) * 1000 + Math.round((depth.get(id) + 1) * 10);
  const keys = [...new Set(body.map((n) => keyOf(n.id)))].sort((a, b) => a - b);
  const layerOfKey = new Map(keys.map((k, i) => [k, i]));
  const layer = new Map();
  for (const n of body) layer.set(n.id, layerOfKey.get(keyOf(n.id)));
  const L = keys.length;
  for (const id of floor) layer.set(id, L);
  const rowRole = keys.map((k) => {
    const members = body.filter((n) => keyOf(n.id) === k);
    return members.every((n) => n.role === "test") ? "test" : FLOW_ROLE_ORDER[Math.floor(k / 1000)] || "service";
  });
  Object.assign(S, { layer, L, broken, rowRole, isTest });
}

/** 2. Edge classes: routed (down the rows, with channels), floor (into the third-party bus), side (back,
   upward, sideways: orthogonal loops). */
function classifyEdges(S) {
  const { edges, layer, floor, broken } = S;
  const routed = [], side = [], floorE = [];
  for (const e of edges) {
    const fF = floor.has(e.from), tF = floor.has(e.to);
    const back = !!e.back || broken.has(e);
    const lf = layer.get(e.from), lt = layer.get(e.to);
    if (tF && !fF) floorE.push({ e, back });
    else if (!fF && lt > lf) routed.push({ e, back });
    else side.push({ e, back });
  }
  Object.assign(S, { routed, side, floorE });
}

/** 3. Spine: the heaviest chain of static references (import / reexport / via, never a mention), weighted by
   carries plus a little of each node's part, so it neither tails off onto weak edges nor skips seeds. */
function findSpine(S) {
  const { routed, byId, layer, oi, o, body } = S;
  const elig = routed.filter((r) => !r.back && r.e.kind !== "mention" && r.e.carries >= o.spineMin);
  const inc = new Map();
  for (const r of elig) { if (!inc.has(r.e.to)) inc.set(r.e.to, []); inc.get(r.e.to).push(r); }
  const order = body.slice().sort((a, b) => layer.get(a.id) - layer.get(b.id) || oi(a.id) - oi(b.id) || cmp(a.id, b.id));
  const score = new Map(), via = new Map();
  for (const n of order) {
    let best = 0, bestR = null;
    // A hop counts by how surely the reference carries the subject AND how surely the unit it reaches
    // is a step of it: a long chain through borderline units must not outrank the real story.
    const sure = Math.max(0.2, Number.isFinite(n.part) ? n.part : 0.5);
    for (const r of inc.get(n.id) || []) {
      const s = score.get(r.e.from) + r.e.carries * sure;
      if (s > best + 1e-9 || (Math.abs(s - best) <= 1e-9 && bestR && oi(r.e.from) < oi(bestR.e.from))) { best = s; bestR = r; }
    }
    score.set(n.id, best + 0.5 * (Number.isFinite(n.part) ? n.part : 0.5));
    via.set(n.id, bestR);
  }
  let end = null;
  for (const n of order) if (!end || score.get(n.id) > score.get(end.id) + 1e-9) end = n;
  const chain = [], spineEdges = new Set();
  for (let n = end; n;) { chain.unshift(n.id); const r = via.get(n.id); if (!r) break; spineEdges.add(r.e.i); n = byId.get(r.e.from); }
  S.spine = chain.length >= 3 ? chain : [];
  S.spineEdges = chain.length >= 3 ? spineEdges : new Set();
}

/** 4. Cards: rich (title, path, the authors' sentence) for seeds, the spine and the top share by part;
   compact (title, path) elsewhere; a mono pill for packages. Every text is fitted to its card. */
function measureNodes(S) {
  const { nodes, body, o, measure, layer, rowRole, floor, oi } = S;
  const spineSet = new Set(S.spine);
  const rich = new Set();
  for (const n of body) if (n.summary && (n.seed || spineSet.has(n.id))) rich.add(n.id);
  if (nodes.length <= o.richLimit) {
    const more = body.filter((n) => n.summary && !rich.has(n.id)).sort((a, b) => (b.part || 0) - (a.part || 0) || oi(a.id) - oi(b.id) || cmp(a.id, b.id));
    const k = clamp(Math.ceil(nodes.length * o.keyShare), o.keyMin, o.keyMax) - rich.size;
    for (const n of more.slice(0, Math.max(0, k))) rich.add(n.id);
  }
  const PADX = 12, PADY = 8;
  const spec = new Map();
  for (const n of nodes) {
    const isPkg = floor.has(n.id);
    const isRich = rich.has(n.id);
    const title = String(n.title || basename(n.path || "") || n.id);
    const titleFont = isPkg ? "pkg" : isRich ? "titleKey" : "title";
    const roleText = isPkg || n.role === rowRole[layer.get(n.id)] ? "" : String(n.role).toUpperCase();
    const roleW = roleText ? measure(roleText, "role") + 12 : 0;
    const sub = subline(n);
    const titleW = measure(title, titleFont);
    const subW = sub ? measure(sub, "sub") : 0;
    let w;
    if (isPkg) w = clamp(titleW + 28, 72, 220);
    else if (isRich) w = clamp(titleW + roleW + 2 * PADX + 2, o.keyWidth, o.keyWidth + 40);
    else w = clamp(Math.max(titleW + roleW + 2, Math.min(subW, 150)) + 2 * PADX, o.minWidth, o.maxWidth);
    const inner = w - 2 * PADX;
    const titleT = ellipsisEnd(title, inner - roleW, titleFont, measure);
    const subT = sub ? ellipsisMid(sub, inner, "sub", measure) : "";
    const maxLines = nodes.length <= 12 ? 3 : 2;
    const lines = isRich && n.summary ? wrapText(String(n.summary), inner, "summary", maxLines, measure) : [];
    const h = isPkg ? 26 : PADY + 14 + (subT ? 2 + 12 : 0) + (lines.length ? 4 + lines.length * 14 : 0) + PADY;
    spec.set(n.id, { w, h, title: titleT, titleFont, role: roleText, sub: subT, lines, rich: isRich, spine: spineSet.has(n.id) });
  }
  S.spec = spec;
}

/** 5. Items and rows: real nodes, dummy channel points for long edges, cluster bands and their rows. */
function buildItems(S) {
  const { graph, nodes, body, floor, layer, L, spec, routed, floorE, oi, o } = S;
  const cl = new Map();
  for (const c of graph.clusters || []) if (c && typeof c.id === "string") cl.set(c.id, { id: c.id, title: String(c.title || c.id), members: [], l0: Infinity, l1: -Infinity });
  for (const n of body) {
    const cid = n.cluster || "";
    if (!cl.has(cid)) cl.set(cid, { id: cid, title: cid, members: [], l0: Infinity, l1: -Infinity });
    const c = cl.get(cid);
    c.members.push(n.id);
    c.l0 = Math.min(c.l0, layer.get(n.id));
    c.l1 = Math.max(c.l1, layer.get(n.id));
  }
  for (const [id, c] of [...cl]) if (!c.members.length) cl.delete(id);
  const clusters = [...cl.values()];
  const clusterOf = (id) => (floor.has(id) ? null : S.byId.get(id).cluster || "");
  const spans = (cid, l) => { const c = cl.get(cid); return !!c && c.l0 <= l && l <= c.l1; };
  const items = new Map();
  for (const n of nodes) items.set(n.id, { id: n.id, real: true, node: n, layer: layer.get(n.id), cluster: clusterOf(n.id), floor: floor.has(n.id), w: spec.get(n.id).w, h: spec.get(n.id).h, x: 0 });
  let dseq = 0;
  const chains = []; // routed + floor edges with their dummy chains
  for (const r of [...routed, ...floorE]) {
    const e = r.e;
    const lf = layer.get(e.from), lt = layer.get(e.to);
    const chain = [e.from];
    for (let l = lf + 1; l < lt; l++) {
      const lane = spans(clusterOf(e.from), l) ? clusterOf(e.from) : clusterOf(e.to) && spans(clusterOf(e.to), l) ? clusterOf(e.to) : null;
      const id = "d" + dseq++;
      items.set(id, { id, real: false, edge: e, layer: l, cluster: lane, w: 0, h: 0, x: 0 });
      chain.push(id);
    }
    chain.push(e.to);
    r.chain = chain;
    chains.push(r);
  }
  const up = new Map(), down = new Map();
  for (const it of items.values()) { up.set(it.id, []); down.set(it.id, []); }
  for (const r of chains) for (let i = 0; i + 1 < r.chain.length; i++) { down.get(r.chain[i]).push(r.chain[i + 1]); up.get(r.chain[i + 1]).push(r.chain[i]); }
  // a free dummy is represented, for barycenters, by the nearest placed chain element in that direction
  const proxyUp = new Map(), proxyDown = new Map();
  for (const r of chains) {
    let last = r.chain[0];
    for (const id of r.chain) { const it = items.get(id); if (it.real || it.cluster) last = id; else proxyUp.set(id, last); }
    last = r.chain[r.chain.length - 1];
    for (let i = r.chain.length - 1; i >= 0; i--) { const id = r.chain[i]; const it = items.get(id); if (it.real || it.cluster) last = id; else proxyDown.set(id, last); }
  }
  const px = (id, dir) => { const it = items.get(id); if (it.real || it.cluster || it.placed) return it.x; return items.get(dir === "up" ? proxyUp.get(id) : proxyDown.get(id)).x; };
  const rows = new Map(); // `${cluster}\0${layer}` -> [items]
  const rowKey = (c, l) => c + "\0" + l;
  for (const it of items.values()) {
    if (it.cluster === null || it.cluster === undefined) continue;
    const k = rowKey(it.cluster, it.layer);
    if (!rows.has(k)) rows.set(k, []);
    rows.get(k).push(it);
  }
  for (const r of rows.values()) r.sort((a, b) => (a.real !== b.real ? (a.real ? -1 : 1) : a.real ? oi(a.id) - oi(b.id) || cmp(a.id, b.id) : cmp(bundleOf(a), bundleOf(b)) || a.edge.i - b.edge.i));
  const gapBetween = (a, b) => (a.real && b.real ? o.nodeGap : !a.real && !b.real && bundleOf(a) === bundleOf(b) ? 0 : o.channel);
  const rowWidth = (r) => { let w = 0; for (let i = 0; i < r.length; i++) { w += r[i].w; if (i) w += gapBetween(r[i - 1], r[i]); } return w; };
  for (const c of clusters) {
    let w = S.measure(c.title, "cluster") + 8;
    for (let l = c.l0; l <= c.l1; l++) { const r = rows.get(rowKey(c.id, l)); if (r) w = Math.max(w, rowWidth(r)); }
    c.w = w + 2 * o.clusterPad;
  }
  const floorItems = nodes.filter((n) => floor.has(n.id)).map((n) => items.get(n.id));
  Object.assign(S, { cl, clusters, clusterOf, spans, items, chains, up, down, proxyUp, proxyDown, px, rows, rowKey, gapBetween, rowWidth, floorItems, L });
}

/** 6. Cluster bands: order and x, minimising weighted distance between linked clusters (exhaustive for
   up to 6 clusters, adjacent-swap descent beyond), plus room for the channels that run between them. */
function packClusters(S) {
  const { clusters, chains, clusterOf, o } = S;
  const cidx = new Map(clusters.map((c, i) => [c.id, i]));
  const cEdges = new Map();
  for (const r of chains) {
    const a = clusterOf(r.e.from), b = clusterOf(r.e.to);
    if (a === b || a === null || b === null) continue;
    const k = a < b ? a + "|" + b : b + "|" + a;
    cEdges.set(k, (cEdges.get(k) || 0) + 0.5 + r.e.carries);
  }
  const cPairs = [...cEdges].map(([k, w]) => { const [a, b] = k.split("|"); return { a: cidx.get(a), b: cidx.get(b), w }; });
  const yOverlap = (a, b) => a.l0 <= b.l1 && b.l0 <= a.l1;
  const extra = new Map();
  const gapFor = (left, right) => o.clusterGap + (extra.get(left + "|" + right) || 0);
  function pack(order) {
    const pos = new Array(clusters.length).fill(null);
    for (const ci of order) {
      const c = clusters[ci];
      const cands = [0];
      for (const di of order) { if (pos[di] === null || di === ci) continue; const d = clusters[di]; if (yOverlap(c, d)) cands.push(pos[di] + d.w + gapFor(d.id, c.id)); }
      let best = null, bestCost = Infinity;
      for (const x of cands) {
        let ok = true;
        for (const di of order) {
          if (pos[di] === null || di === ci) continue;
          const d = clusters[di];
          if (!yOverlap(c, d)) continue;
          if (!(x >= pos[di] + d.w + gapFor(d.id, c.id) - 1e-6 || x + c.w + gapFor(c.id, d.id) <= pos[di] + 1e-6)) { ok = false; break; }
        }
        if (!ok) continue;
        let cost = 0;
        for (const p of cPairs) {
          const other = p.a === ci ? p.b : p.b === ci ? p.a : -1;
          if (other < 0 || pos[other] === null) continue;
          cost += p.w * Math.abs(x + c.w / 2 - (pos[other] + clusters[other].w / 2));
        }
        if (cost < bestCost - 1e-9 || (Math.abs(cost - bestCost) <= 1e-9 && x < best)) { best = x; bestCost = cost; }
      }
      pos[ci] = best === null ? 0 : best;
    }
    let total = 0;
    for (const p of cPairs) total += p.w * Math.abs(pos[p.a] + clusters[p.a].w / 2 - (pos[p.b] + clusters[p.b].w / 2));
    const width = clusters.length ? Math.max(...clusters.map((c, i) => pos[i] + c.w)) : 0;
    return { pos, cost: total + 0.35 * width };
  }
  let bestOrder = clusters.map((_, i) => i);
  if (clusters.length > 1) {
    let best = pack(bestOrder);
    if (clusters.length <= 6) {
      const perm = bestOrder.slice();
      const rec = (k) => {
        if (k === perm.length) { const r = pack(perm); if (r.cost < best.cost - 1e-9) { best = r; bestOrder = perm.slice(); } return; }
        for (let i = k; i < perm.length; i++) { [perm[k], perm[i]] = [perm[i], perm[k]]; rec(k + 1); [perm[k], perm[i]] = [perm[i], perm[k]]; }
      };
      rec(0);
    } else {
      let improved = true, guard = 0;
      while (improved && guard++ < 60) {
        improved = false;
        for (let i = 0; i + 1 < bestOrder.length; i++) {
          const cand = bestOrder.slice(); [cand[i], cand[i + 1]] = [cand[i + 1], cand[i]];
          const r = pack(cand);
          if (r.cost < best.cost - 1e-9) { best = r; bestOrder = cand; improved = true; }
        }
      }
    }
  }
  const applyPack = () => { const r = pack(bestOrder); clusters.forEach((c, i) => { c.x0 = o.margin + o.gutter + r.pos[i]; c.x1 = c.x0 + c.w; }); };
  applyPack();
  Object.assign(S, { extra, applyPack });
}

/** 7. Order inside the rows (barycenter sweeps keeping the best crossing count), channel positions in
   the gaps between bands, third-party packages under the sources that use them. */
function orderRows(S) {
  const { clusters, rows, rowKey, items, chains, up, down, px, gapBetween, rowWidth, L, o, floorItems, extra, applyPack, spans, oi } = S;
  const placeInitial = () => {
    for (const c of clusters) for (let l = c.l0; l <= c.l1; l++) {
      const r = rows.get(rowKey(c.id, l)); if (!r) continue;
      let x = c.x0 + o.clusterPad + (c.w - 2 * o.clusterPad - rowWidth(r)) / 2;
      for (let i = 0; i < r.length; i++) { if (i) x += gapBetween(r[i - 1], r[i]); r[i].x = x + r[i].w / 2; x += r[i].w; }
    }
  };
  placeInitial();
  const bandLo = () => (clusters.length ? Math.min(...clusters.map((c) => c.x0)) : o.margin + o.gutter);
  const bandHi = () => (clusters.length ? Math.max(...clusters.map((c) => c.x1)) : o.margin + o.gutter + 400);
  /* 1D placement with min separations (pool-adjacent-violators on blocks) */
  function placeRow(r, targets, lo, hi, gap) {
    const n = r.length;
    if (!n) return;
    const sep = [];
    for (let i = 0; i + 1 < n; i++) sep.push(r[i].w / 2 + (gap === undefined ? gapBetween(r[i], r[i + 1]) : gap) + r[i + 1].w / 2);
    const pre = [0]; for (let i = 0; i < sep.length; i++) pre.push(pre[i] + sep[i]);
    const off = (s, j) => pre[j] - pre[s];
    const blocks = [];
    for (let i = 0; i < n; i++) {
      let b = { s: i, e: i, x: targets[i] };
      while (blocks.length) {
        const p = blocks[blocks.length - 1];
        if (b.x >= p.x + off(p.s, b.s) - 1e-9) break;
        blocks.pop();
        let sum = 0; for (let j = p.s; j <= b.e; j++) sum += targets[j] - off(p.s, j);
        b = { s: p.s, e: b.e, x: sum / (b.e - p.s + 1) };
      }
      blocks.push(b);
    }
    const pos = new Array(n);
    for (const b of blocks) for (let j = b.s; j <= b.e; j++) pos[j] = b.x + off(b.s, j);
    const loC = lo + r[0].w / 2, hiC = hi - r[n - 1].w / 2;
    const total = pre[n - 1];
    if (total > hiC - loC) { for (let j = 0; j < n; j++) pos[j] = loC + pre[j]; }
    else {
      for (let j = 0; j < n; j++) pos[j] = clamp(pos[j], loC + pre[j], hiC - (total - pre[j]));
      for (let j = 1; j < n; j++) pos[j] = Math.max(pos[j], pos[j - 1] + sep[j - 1]);
    }
    for (let j = 0; j < n; j++) r[j].x = pos[j];
  }
  const rowsAt = (l) => { const out = []; for (const c of clusters) { const r = rows.get(rowKey(c.id, l)); if (r) out.push({ c, r }); } return out; };
  const shareTargets = (r, tg) => { // bundle mates move as one
    const sum = new Map(), cnt = new Map();
    r.forEach((it, i) => { const k = bundleOf(it); if (!k) return; sum.set(k, (sum.get(k) || 0) + tg[i]); cnt.set(k, (cnt.get(k) || 0) + 1); });
    r.forEach((it, i) => { const k = bundleOf(it); if (k) tg[i] = sum.get(k) / cnt.get(k); });
  };
  function sweepLayer(l, fixedDir) {
    for (const { c, r } of rowsAt(l)) {
      const tg = r.map((it) => {
        const a = fixedDir === "up" ? up.get(it.id) : down.get(it.id);
        const b = fixedDir === "up" ? down.get(it.id) : up.get(it.id);
        const use = a.length ? a : b;
        const dir = a.length ? fixedDir : fixedDir === "up" ? "down" : "up";
        if (!use.length) return it.x;
        let s = 0; for (const id of use) s += px(id, dir); return s / use.length;
      });
      shareTargets(r, tg);
      const order = r.map((_, i) => i).sort((i, j) => tg[i] - tg[j] || i - j);
      const sorted = order.map((i) => r[i]);
      placeRow(sorted, order.map((i) => tg[i]), c.x0 + o.clusterPad, c.x1 - o.clusterPad);
      r.splice(0, r.length, ...sorted);
    }
  }
  /* third-party packages: under the mean of what reaches them, spread apart, kept in reading order */
  const placeFloor = () => {
    if (!floorItems.length) return;
    for (const it of floorItems) {
      const ups = up.get(it.id);
      if (ups.length) { let s = 0; for (const u of ups) s += px(u, "up"); it.x = s / ups.length; }
      else if (!it.x) it.x = (bandLo() + bandHi()) / 2;
    }
    const sorted = floorItems.slice().sort((a, b) => a.x - b.x || oi(a.id) - oi(b.id) || cmp(a.id, b.id));
    placeRow(sorted, sorted.map((it) => it.x), bandLo() + o.clusterPad, Math.max(bandHi() - o.clusterPad, bandLo() + o.clusterPad + sorted.reduce((s, it) => s + it.w + o.floorGap, 0)), o.floorGap);
  };
  placeFloor();
  function crossings() {
    let n = 0, len = 0;
    for (let l = 0; l < L; l++) {
      const segs = [];
      for (const r of chains) for (let i = 0; i + 1 < r.chain.length; i++) {
        const a = items.get(r.chain[i]); if (a.layer !== l) continue;
        segs.push([px(r.chain[i], "down"), px(r.chain[i + 1], "up")]);
      }
      for (const s of segs) len += Math.abs(s[0] - s[1]);
      for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) {
        const a = segs[i], b = segs[j];
        if ((a[0] < b[0] && a[1] > b[1]) || (a[0] > b[0] && a[1] < b[1])) n++;
      }
    }
    return n * 1000 + len * 0.02;
  }
  const snapshot = () => { const m = new Map(); for (const it of items.values()) m.set(it.id, it.x); const ro = new Map(); for (const [k, r] of rows) ro.set(k, r.slice()); return { m, ro }; };
  const restore = (s) => { for (const it of items.values()) it.x = s.m.get(it.id); for (const [k, r] of s.ro) rows.get(k).splice(0, rows.get(k).length, ...r); };
  function sweeps() {
    let best = crossings(), bestS = snapshot();
    for (let it = 0; it < o.sweeps; it++) {
      if (it % 2 === 0) for (let l = 1; l < L; l++) sweepLayer(l, "up");
      else for (let l = L - 2; l >= 0; l--) sweepLayer(l, "down");
      placeFloor();
      const s = crossings();
      if (s < best - 1e-9) { best = s; bestS = snapshot(); }
    }
    restore(bestS);
    for (let pass = 0; pass < 2; pass++) for (let l = 0; l < L; l++) for (const { c, r } of rowsAt(l)) {
      const tg = r.map((it) => { const ids = [...up.get(it.id).map((id) => [id, "up"]), ...down.get(it.id).map((id) => [id, "down"])]; if (!ids.length) return it.x; let s = 0; for (const [id, d] of ids) s += px(id, d); return s / ids.length; });
      shareTargets(r, tg);
      for (let i = 1; i < tg.length; i++) tg[i] = Math.max(tg[i], tg[i - 1]);
      placeRow(r, tg, c.x0 + o.clusterPad, c.x1 - o.clusterPad);
    }
    placeFloor();
  }
  sweeps();

  /* free channels: straight-line guesses snapped into the gaps between bands; interior gaps preferred */
  const freeD = [...items.values()].filter((it) => !it.real && !it.cluster);
  function gapsAt(l) {
    const bands = clusters.filter((c) => spans(c.id, l)).sort((a, b) => a.x0 - b.x0);
    const gaps = [];
    let prev = null;
    for (const b of bands) { gaps.push({ lo: prev ? prev.x1 : -Infinity, hi: b.x0, left: prev ? prev.id : null, right: b.id }); prev = b; }
    gaps.push({ lo: prev ? prev.x1 : -Infinity, hi: Infinity, left: prev ? prev.id : null, right: null });
    gaps.forEach((g, i) => { g.key = l + ":" + i; });
    return gaps;
  }
  const GM = 12;
  function guessX(d) {
    const a = items.get(S.proxyUp.get(d.id)), b = items.get(S.proxyDown.get(d.id));
    if (b.layer === a.layer) return a.x;
    return a.x + (b.x - a.x) * (d.layer - a.layer) / (b.layer - a.layer);
  }
  function chooseGap(gaps, x) {
    for (const g of gaps) if (x >= g.lo && x <= g.hi) return g;
    let best = gaps[0], bd = Infinity;
    for (const g of gaps) {
      let d = Math.min(Math.abs(x - g.lo), Math.abs(x - g.hi));
      if (g.lo === -Infinity || g.hi === Infinity) d += 160; // the open margin costs more than an interior gap
      if (d < bd) { bd = d; best = g; }
    }
    return best;
  }
  let occ = new Map();
  function placeFree() {
    for (const d of freeD) { d.gx = guessX(d); d.fixed = false; d.placed = true; }
    const gapOf = new Map();
    for (const d of freeD) gapOf.set(d.id, chooseGap(gapsAt(d.layer), d.gx));
    occ = new Map(); // layer -> [{ x, key }]: a channel is free for its own bundle
    const occAdd = (l, x, key) => { if (!occ.has(l)) occ.set(l, []); occ.get(l).push({ x, key }); };
    const free = (l, x, key) => !(occ.get(l) || []).some((v) => v.key !== key && Math.abs(v.x - x) < o.channel - 1e-6);
    const runs = [];
    for (const r of chains) {
      let run = [];
      for (const id of r.chain) { const it = items.get(id); if (!it.real && !it.cluster) run.push(it); else { if (run.length) runs.push({ r, run }); run = []; } }
    }
    runs.sort((a, b) => b.run.length - a.run.length || a.r.e.i - b.r.e.i);
    const groups = new Map();
    for (const rr of runs) { const last = rr.run[rr.run.length - 1]; const k = bundleOf(last) + "|" + gapOf.get(last.id).key; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(rr); }
    const settledX = new Map(); // bundle key -> xs already taken by mates
    const settle = (members) => {
      const all = members.flatMap((m) => m.run);
      const key = bundleOf(all[0]);
      let lo = -Infinity, hi = Infinity;
      for (const d of all) { const g = gapOf.get(d.id); lo = Math.max(lo, g.lo === -Infinity ? -1e9 : g.lo + GM); hi = Math.min(hi, g.hi === Infinity ? 1e9 : g.hi - GM); }
      if (lo > hi) return false;
      // join a mate's channel when it lies in range: a fan-in becomes one trunk
      for (const x of settledX.get(key) || []) if (x >= lo && x <= hi && all.every((d) => free(d.layer, x, key))) {
        for (const d of all) { d.x = x; d.fixed = true; }
        for (const l of new Set(all.map((d) => d.layer))) occAdd(l, x, key);
        return true;
      }
      const prefs = [];
      const below = items.get(down.get(members[0].run[members[0].run.length - 1].id)[0]);
      if (below.real && !below.floor) prefs.push(below.x);
      const aboves = members.map((m) => items.get(up.get(m.run[0].id)[0])).filter((a) => a.real);
      if (aboves.length) prefs.push(aboves.reduce((s, a) => s + a.x, 0) / aboves.length);
      if (below.real && below.floor) prefs.push(below.x);
      prefs.push(all.reduce((s, d) => s + d.gx, 0) / all.length);
      let chosen = null;
      for (const p of prefs) {
        const base = clamp(p, lo, hi);
        for (let k = 0; k < 8 && chosen === null; k++) for (const x of k ? [base + k * o.channel, base - k * o.channel] : [base]) {
          if (x < lo || x > hi) continue;
          if (all.every((d) => free(d.layer, x, key))) { chosen = x; break; }
        }
        if (chosen !== null) break;
      }
      if (chosen === null) return false;
      for (const d of all) { d.x = chosen; d.fixed = true; }
      for (const l of new Set(all.map((d) => d.layer))) occAdd(l, chosen, key);
      if (!settledX.has(key)) settledX.set(key, []);
      settledX.get(key).push(chosen);
      return true;
    };
    for (const members of groups.values()) { if (!settle(members)) for (const m of members) settle([m]); }
    const need = new Map();
    for (let l = 0; l < L; l++) {
      for (const g of gapsAt(l)) {
        const ds = freeD.filter((d) => d.layer === l && gapOf.get(d.id).key === g.key).sort((a, b) => a.gx - b.gx || a.edge.i - b.edge.i);
        if (!ds.length) continue;
        const loose = ds.filter((d) => !d.fixed);
        const lo = g.lo === -Infinity ? -1e9 : g.lo + GM, hi = g.hi === Infinity ? 1e9 : g.hi - GM;
        if (g.lo === -Infinity) {
          let x = Infinity;
          for (const d of loose.slice().reverse()) { x = Math.min(clamp(d.gx, lo, hi), x - o.channel); while (!free(l, x, bundleOf(d))) x -= o.channel; d.x = x; occAdd(l, x, bundleOf(d)); }
        } else {
          let x = -Infinity;
          for (const d of loose) { x = Math.max(clamp(d.gx, lo, hi), x + o.channel); while (!free(l, x, bundleOf(d))) x += o.channel; d.x = x; occAdd(l, x, bundleOf(d)); }
        }
        const xs = ds.map((d) => d.x);
        const span = Math.max(...xs) - Math.min(...xs) + 2 * GM;
        const width = g.hi - g.lo;
        if (g.left && g.right && (span > width + 1e-6 || Math.max(...xs) > g.hi - GM + 1e-6 || Math.min(...xs) < g.lo + GM - 1e-6)) {
          const k = g.left + "|" + g.right;
          need.set(k, Math.max(need.get(k) || 0, span - width + o.channel));
        }
      }
    }
    return need;
  }
  const shiftBands = () => {
    const old = new Map(clusters.map((c) => [c.id, c.x0]));
    applyPack();
    for (const it of items.values()) if (it.cluster) it.x += clusters.find((c) => c.id === it.cluster).x0 - old.get(it.cluster);
  };
  const placeFreeRounds = () => {
    for (let round = 0; round < 3; round++) {
      const need = placeFree();
      if (!need.size) break;
      let grew = false;
      for (const [k, v] of need) { const cur = extra.get(k) || 0; if (v > cur + 0.5) { extra.set(k, cur + v); grew = true; } }
      if (!grew) break;
      shiftBands();
    }
    placeFloor();
  };
  placeFreeRounds();
  sweeps();
  placeFreeRounds();
  placeFree();
  Object.assign(S, { gapsAt, occ, GM, bandLo, bandHi });
}

/** 8. Side edges (back, upward, same row): orthogonal loops through a free vertical channel — beside the
   nodes when the band has room, else in a gap between bands — with horizontal runs on tracks in the
   row gaps. Symbolic here (channels, gaps, tracks); y comes in placeY. */
function routeSides(S) {
  const { side, items, clusters, spans, gapsAt, occ, o, L, GM } = S;
  const realAt = (l) => [...items.values()].filter((it) => it.real && it.layer === l);
  const blockedH = (l, xa, xb, skip) => {
    const lo = Math.min(xa, xb), hi = Math.max(xa, xb);
    return realAt(l).some((it) => !skip.has(it.id) && it.x + it.w / 2 > lo && it.x - it.w / 2 < hi);
  };
  const insideForeign = (x, l, allowed) => clusters.some((c) => spans(c.id, l) && !allowed.has(c.id) && x > c.x0 && x < c.x1);
  const dummies = [...items.values()].filter((it) => !it.real);
  const channelBusy = (x, l0, l1) => {
    for (let l = l0; l <= l1; l++) if ((occ.get(l) || []).some((v) => Math.abs(v.x - x) < o.channel - 2)) return true;
    return dummies.some((d) => d.layer >= l0 && d.layer <= l1 && Math.abs(d.x - x) < o.channel - 2);
  };
  const nodeBusy = (x, l0, l1, skip) => { for (let l = l0; l <= l1; l++) if (realAt(l).some((it) => !skip.has(it.id) && x > it.x - it.w / 2 - 8 && x < it.x + it.w / 2 + 8)) return true; return false; };
  const occAdd = (x, l0, l1) => { for (let l = l0; l <= l1; l++) { if (!occ.has(l)) occ.set(l, []); occ.get(l).push({ x, key: null }); } };
  const tracks = Array.from({ length: L + 2 }, () => []); // index g + 1 for gap g in -1..L
  const routes = [];
  for (const { e, back } of side) {
    const from = items.get(e.from), to = items.get(e.to);
    const lf = from.layer, lt = to.layer;
    const R = { e, back, from, to };
    if (lt === lf) {
      const sgn = to.x >= from.x ? 1 : -1;
      const sameHome = from.cluster === to.cluster;
      if (sameHome && !blockedH(lf, from.x + sgn * from.w / 2, to.x - sgn * to.w / 2, new Set([from.id, to.id]))) {
        R.kind = "direct"; R.sgn = sgn;
      } else {
        const over = from.floor;
        R.kind = over ? "loopOver" : "loopUnder";
        R.gap = over ? lf - 1 : lf;
        R.fx = from.x + sgn * (from.w / 2 - 12); R.tx = to.x - sgn * (to.w / 2 - 12);
        R.trackRef = { g: R.gap, lo: Math.min(R.fx, R.tx), hi: Math.max(R.fx, R.tx), i: e.i };
        tracks[R.gap + 1].push(R.trackRef);
      }
      routes.push(R);
      continue;
    }
    // upward: to sits above from
    const mid = (from.x + to.x) / 2;
    const skip = new Set([from.id, to.id]);
    const allowed = new Set([from.cluster, to.cluster].filter((c) => c !== null && c !== undefined));
    const cands = [];
    const right = Math.max(from.x + from.w / 2, to.x + to.w / 2) + 26, left = Math.min(from.x - from.w / 2, to.x - to.w / 2) - 26;
    cands.push(right, left);
    // gaps common to every crossed row
    let ivs = [[-1e9, 1e9]];
    for (let l = lt; l <= lf; l++) {
      const gs = gapsAt(l).map((g) => [g.lo === -Infinity ? -1e9 : g.lo + GM, g.hi === Infinity ? 1e9 : g.hi - GM]);
      const next = [];
      for (const a of ivs) for (const b of gs) { const lo = Math.max(a[0], b[0]), hi = Math.min(a[1], b[1]); if (hi >= lo) next.push([lo, hi]); }
      ivs = next;
    }
    for (const [lo, hi] of ivs) cands.push(clamp(mid, lo, hi));
    const ok = (x) => !nodeBusy(x, lt, lf, skip) && !channelBusy(x, lt, lf) && ![...Array(lf - lt + 1).keys()].some((k) => insideForeign(x, lt + k, allowed));
    let cx = null;
    const tryX = (base) => { for (let k = 0; k < 6; k++) for (const x of k ? [base + k * o.channel, base - k * o.channel] : [base]) if (ok(x)) return x; return null; };
    const sorted = cands.map((x, i) => ({ x, i, d: Math.abs(x - mid) - (i < 2 ? 40 : 0) })).sort((a, b) => a.d - b.d || a.i - b.i);
    for (const c of sorted) { cx = tryX(c.x); if (cx !== null) break; }
    if (cx === null) { let x = (clusters.length ? Math.min(...clusters.map((c) => c.x0)) : from.x) - 30; while (channelBusy(x, lt, lf)) x -= o.channel; cx = x; }
    occAdd(cx, lt, lf);
    R.kind = "up"; R.cx = cx;
    const s = cx > from.x ? 1 : -1;
    R.exitSide = !blockedH(lf, from.x + s * from.w / 2, cx, skip);
    if (!R.exitSide) { R.fx = from.x + s * (from.w / 2 - 12); R.gapA = lf - 1; R.trackA = { g: R.gapA, lo: Math.min(R.fx, cx), hi: Math.max(R.fx, cx), i: e.i }; tracks[R.gapA + 1].push(R.trackA); }
    const s2 = to.x > cx ? 1 : -1;
    R.entrySide = !blockedH(lt, cx, to.x - s2 * to.w / 2, skip);
    if (!R.entrySide) { R.tx = to.x - s2 * (to.w / 2 - 12); R.gapB = lt - 1; R.trackB = { g: R.gapB, lo: Math.min(R.tx, cx), hi: Math.max(R.tx, cx), i: e.i }; tracks[R.gapB + 1].push(R.trackB); }
    routes.push(R);
  }
  const trackCount = new Array(L + 2).fill(0);
  tracks.forEach((list, gi) => {
    list.sort((a, b) => a.lo - b.lo || a.hi - b.hi || a.i - b.i);
    const slots = [];
    for (const t of list) {
      let s = slots.findIndex((iv) => iv.every(([lo, hi]) => t.hi + 10 < lo || t.lo - 10 > hi));
      if (s < 0) { s = slots.length; slots.push([]); }
      slots[s].push([t.lo, t.hi]); t.track = s;
    }
    trackCount[gi] = slots.length;
  });
  Object.assign(S, { sideRoutes: routes, trackCount });
}

/** 9. Vertical geometry: row tops, gap heights (sweeps, then side tracks, then the next cluster head),
   the third-party bus and floor. */
function placeY(S) {
  const { items, L, o, trackCount, floorItems, chains } = S;
  const layerH = new Array(L).fill(0);
  for (const it of items.values()) if (it.real && !it.floor) layerH[it.layer] = Math.max(layerH[it.layer], it.h);
  const gapH = (l) => { const t = trackCount[l + 1]; return t ? 66 + (t - 1) * o.track : o.layerGap; };
  const top = new Array(L);
  let y = o.margin + o.clusterPad + o.clusterHead + (trackCount[0] ? 10 + trackCount[0] * o.track : 0);
  for (let l = 0; l < L; l++) { top[l] = y; y += layerH[l] + (l + 1 < L ? gapH(l) : 0); }
  const lBot = (l) => top[l] + layerH[l];
  let yb = L ? lBot(L - 1) + o.clusterPad : o.margin;
  if (L && trackCount[L]) yb += 12 + trackCount[L] * o.track;
  // one bus track per third-party package that anything reaches
  const busOf = new Map();
  const fed = floorItems.filter((it) => chains.some((r) => r.e.to === it.id)).sort((a, b) => a.x - b.x || cmp(a.id, b.id));
  fed.forEach((it, i) => busOf.set(it.id, i));
  const busY0 = yb + 12;
  let floorTop = null, floorBottom = null;
  if (floorItems.length) {
    floorTop = L ? busY0 + Math.max(0, fed.length - 1) * o.track + 22 : yb + (trackCount[0] ? 12 + trackCount[0] * o.track : 0);
    const fy = floorTop + o.clusterHead + 4;
    let fh = 0;
    for (const it of floorItems) { it.y = fy; fh = Math.max(fh, it.h); }
    floorBottom = fy + fh + 8;
  }
  for (const it of items.values()) if (!it.floor) it.y = it.real ? top[it.layer] : top[it.layer] + layerH[it.layer] / 2;
  const trackY = (g, t) => (!L ? floorTop - 10 - t * o.track : g < 0 ? top[0] - o.clusterPad - o.clusterHead - 10 - t * o.track : g >= L - 1 ? lBot(L - 1) + o.clusterPad + 10 + t * o.track : lBot(g) + 30 + t * o.track);
  Object.assign(S, { layerH, top, lBot, busY: (id) => busY0 + (busOf.get(id) || 0) * o.track, floorTop, floorBottom, trackY, gapH });
}

/** 10. Output: nodes, clusters, edge paths with arrows, labels that collide with nothing, stage bands. */
function emit(S) {
  const { graph, nodes, items, clusters, chains, sideRoutes, spec, top, lBot, layerH, L, o, measure, floorItems, floorTop, floorBottom, busY, trackY, rowRole, spineEdges, floor } = S;
  const bandLo = S.bandLo(), bandHi = S.bandHi();
  /* normalise: everything positive */
  let minX = Infinity;
  for (const it of items.values()) minX = Math.min(minX, it.x - it.w / 2 - (it.real ? 0 : o.channel / 2));
  for (const c of clusters) minX = Math.min(minX, c.x0);
  for (const r of sideRoutes) if (r.kind === "up") minX = Math.min(minX, r.cx - 6);
  if (!Number.isFinite(minX)) minX = o.margin + o.gutter;
  const dx = o.margin + o.gutter - minX;
  for (const it of items.values()) it.x += dx;
  for (const c of clusters) { c.x0 += dx; c.x1 += dx; }
  for (const r of sideRoutes) { if (r.kind === "up") r.cx += dx; if (r.fx !== undefined) r.fx += dx; if (r.tx !== undefined) r.tx += dx; }

  const outNodes = nodes.map((n) => {
    const it = items.get(n.id), s = spec.get(n.id);
    return { id: n.id, x: it.x - it.w / 2, y: it.y, w: it.w, h: it.h, layer: it.layer, cluster: it.floor ? null : n.cluster || "", kind: n.kind, role: n.role, part: n.part, seed: !!n.seed, terminal: !!n.terminal, floor: it.floor, rich: s.rich, spine: s.spine, text: { title: s.title, titleFont: s.titleFont, role: s.role, sub: s.sub, lines: s.lines } };
  });
  const outClusters = clusters.map((c) => {
    let x0 = Infinity, x1 = -Infinity;
    for (const it of items.values()) if (it.cluster === c.id) { x0 = Math.min(x0, it.x - it.w / 2 - (it.real ? 0 : o.channel / 2)); x1 = Math.max(x1, it.x + it.w / 2 + (it.real ? 0 : o.channel / 2)); }
    x0 -= o.clusterPad; x1 += o.clusterPad;
    x1 = Math.max(x1, x0 + measure(c.title, "cluster") + 2 * o.clusterPad);
    const yy = top[c.l0] - o.clusterPad - o.clusterHead;
    const y1 = lBot(c.l1) + o.clusterPad;
    return { id: c.id, title: c.title, x: x0, y: yy, w: x1 - x0, h: y1 - yy, floor: false };
  });
  if (floorItems.length) {
    const fc = (graph.clusters || []).find((c) => c && Array.isArray(c.nodes) && c.nodes.some((id) => floor.has(id)));
    let x0 = Math.min(bandLo + dx, ...floorItems.map((it) => it.x - it.w / 2 - o.clusterPad));
    let x1 = Math.max(bandHi + dx, ...floorItems.map((it) => it.x + it.w / 2 + o.clusterPad));
    x1 = Math.max(x1, x0 + measure(fc ? fc.title : "third-party", "cluster") + 2 * o.clusterPad);
    outClusters.push({ id: fc ? fc.id : "third-party", title: fc ? String(fc.title || fc.id) : "third-party", x: x0, y: floorTop, w: x1 - x0, h: floorBottom - floorTop, floor: true });
  }

  /* ports: outgoing ends spread along the bottom; incoming ends share one port per line style, so a
     fan-in converges on a single approach */
  const outPorts = new Map(), inPorts = new Map();
  const style = (r) => (r.back ? "b" : r.e.kind === "mention" ? "m" : r.e.kind === "via" ? "v" : "i");
  for (const n of nodes) {
    const it = items.get(n.id);
    const outs = chains.filter((r) => r.chain[0] === n.id).map((r) => ({ r, x: items.get(r.chain[1]).x })).sort((a, b) => a.x - b.x || a.r.e.i - b.r.e.i);
    const k = outs.length, sp = k > 1 ? Math.min(14, (it.w - 24) / (k - 1)) : 0;
    outs.forEach((p, i) => outPorts.set(p.r.e.i, it.x + (i - (k - 1) / 2) * sp));
    const ins = chains.filter((r) => r.chain[r.chain.length - 1] === n.id);
    if (it.floor) { for (const r of ins) inPorts.set(r.e.i, it.x); continue; }
    const groups = new Map();
    for (const r of ins) { const key = style(r); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(r); }
    const gl = [...groups.values()].map((rs) => ({ rs, x: rs.reduce((s, r) => s + items.get(r.chain[r.chain.length - 2]).x, 0) / rs.length })).sort((a, b) => a.x - b.x || a.rs[0].e.i - b.rs[0].e.i);
    const kg = gl.length, spg = kg > 1 ? Math.min(14, (it.w - 24) / (kg - 1)) : 0;
    gl.forEach((g, i) => { for (const r of g.rs) inPorts.set(r.e.i, it.x + (i - (kg - 1) / 2) * spg); });
  }

  const outEdges = [];
  const mkEdge = (r, pts, arrow, cands, extra) => ({ from: r.e.from, to: r.e.to, kind: r.e.kind, back: r.back, carries: r.e.carries, names: r.e.names, at: r.e.at, via: r.e.via, d: pathOf(pts), points: pts, arrow, spine: spineEdges.has(r.e.i), cands, ...extra });
  for (const r of chains) {
    const e = r.e;
    const from = items.get(e.from), to = items.get(e.to);
    const px0 = outPorts.get(e.i), tx = inPorts.get(e.i);
    const pts = [[px0, from.y + from.h]];
    const cands = [];
    let cx = px0, cy = lBot(from.layer);
    if (from.y + from.h < cy - 0.5) pts.push([cx, cy]);
    const step = (nx, ny) => { // from (cx, cy) at a row bottom to (nx, ny) at the top of the next row
      if (Math.abs(nx - cx) > 0.5) { const ys = Math.min(cy + SWEEP, (cy + ny) / 2); pts.push([cx, ys - JOG], [nx, ys + JOG]); cands.push({ x: (cx + nx) / 2, y: ys - JOG - 7, kind: "sweep", anchor: "middle" }); }
      pts.push([nx, ny]);
      cx = nx; cy = ny;
    };
    for (let i = 1; i + 1 < r.chain.length; i++) { const d = items.get(r.chain[i]); step(d.x, top[d.layer]); pts.push([d.x, lBot(d.layer)]); cy = lBot(d.layer); }
    if (to.floor) {
      const by = busY(to.id);
      if (Math.abs(tx - cx) > 0.5) { pts.push([cx, by], [tx, by]); cands.unshift({ x: cx + 5, y: by - 7, kind: "beside", anchor: "start" }); }
      pts.push([tx, to.y - AR]);
      cands.unshift({ x: px0 + 5, y: from.y + from.h + 13, kind: "beside", anchor: "start" });
    } else {
      step(tx, top[to.layer]);
      if (to.y > top[to.layer] + 0.5) pts.push([tx, to.y]);
      pts[pts.length - 1] = [tx, to.y - AR];
      cands.unshift({ x: tx + 5, y: to.y - 9, kind: "beside", anchor: "start" });
      cands.push({ x: px0 + 5, y: from.y + from.h + 13, kind: "beside", anchor: "start" });
    }
    outEdges.push(mkEdge(r, pts, { x: tx, y: to.y, dir: "down" }, cands, { side: false, floor: to.floor }));
  }
  for (const r of sideRoutes) {
    const { from, to } = r;
    const fcy = from.y + from.h / 2, tcy = to.y + to.h / 2;
    let pts, arrow;
    const cands = [];
    if (r.kind === "direct") {
      const x0 = from.x + r.sgn * from.w / 2, x1 = to.x - r.sgn * to.w / 2;
      pts = Math.abs(fcy - tcy) < 1 ? [[x0, fcy], [x1 - r.sgn * AR, tcy]] : [[x0, fcy], [(x0 + x1) / 2, fcy], [(x0 + x1) / 2, tcy], [x1 - r.sgn * AR, tcy]];
      arrow = { x: x1, y: tcy, dir: r.sgn > 0 ? "right" : "left" };
      cands.push({ x: (x0 + x1) / 2, y: Math.min(fcy, tcy) - 6, kind: "above", anchor: "middle" });
    } else if (r.kind === "loopUnder" || r.kind === "loopOver") {
      const yT = trackY(r.gap, r.trackRef.track);
      const under = r.kind === "loopUnder";
      pts = under ? [[r.fx, from.y + from.h], [r.fx, yT], [r.tx, yT], [r.tx, to.y + to.h + AR]] : [[r.fx, from.y], [r.fx, yT], [r.tx, yT], [r.tx, to.y - AR]];
      arrow = under ? { x: r.tx, y: to.y + to.h, dir: "up" } : { x: r.tx, y: to.y, dir: "down" };
      cands.push({ x: (r.fx + r.tx) / 2, y: yT - 5, kind: "above", anchor: "middle" });
    } else {
      pts = [];
      const s = r.cx > from.x ? 1 : -1;
      if (r.exitSide) pts.push([from.x + s * from.w / 2, fcy], [r.cx, fcy]);
      else { const yA = trackY(r.gapA, r.trackA.track); pts.push([r.fx, from.y], [r.fx, yA], [r.cx, yA]); }
      const s2 = to.x > r.cx ? 1 : -1;
      if (r.entrySide) { pts.push([r.cx, tcy], [to.x - s2 * to.w / 2 - s2 * AR, tcy]); arrow = { x: to.x - s2 * to.w / 2, y: tcy, dir: s2 > 0 ? "right" : "left" }; }
      else { const yB = trackY(r.gapB, r.trackB.track); pts.push([r.cx, yB], [r.tx, yB], [r.tx, to.y - AR]); arrow = { x: r.tx, y: to.y, dir: "down" }; }
      const ymid = (pts[1][1] + pts[pts.length - 2][1]) / 2;
      cands.push({ x: r.cx + 5, y: ymid + 3, kind: "beside", anchor: "start" });
    }
    outEdges.push(mkEdge(r, pts, arrow, cands, { side: true, floor: false }));
  }

  /* labels: the identifiers handed over. Shown when they sit clear of every node, wire and other label;
     otherwise kept for hover. Never an ellipsis inside an identifier: "first +N". */
  const placed = outNodes.map((n) => [n.x - 2, n.y - 2, n.x + n.w + 2, n.y + n.h + 2]);
  for (const c of outClusters) placed.push([c.x, c.y, c.x + 16 + measure(c.title, "cluster"), c.y + o.clusterHead]);
  const samples = outEdges.map((e) => samplePath(e.points));
  const hitRect = (r) => placed.some((q) => r[0] < q[2] && r[2] > q[0] && r[1] < q[3] && r[3] > q[1]);
  const hitWire = (r) => samples.some((ps) => ps.some((p) => inRect(p, r, 1)));
  const ranked = outEdges.map((e) => ({ e })).filter(({ e }) => e.names.length && e.kind !== "mention").sort((a, b) => (b.e.spine ? 1 : 0) - (a.e.spine ? 1 : 0) || b.e.carries - a.e.carries || cmp(a.e.from, b.e.from) || cmp(a.e.to, b.e.to));
  for (const { e } of ranked) {
    const text = labelText(e.names, 150, measure);
    const w = measure(text, "label") + 6, h = 13;
    const box = (c) => { const x0 = c.anchor === "middle" ? c.x - w / 2 : c.x; return [x0, c.y - h / 2, x0 + w, c.y + h / 2]; };
    let shown = null;
    if (e.carries >= o.labelMin || e.spine) for (const c of e.cands) { const r = box(c); if (!hitRect(r) && !hitWire(r)) { shown = c; placed.push(r); break; } }
    const c = shown || e.cands[0];
    if (c) e.label = { x: c.x, y: c.y, text, anchor: c.anchor || "middle", w, h, shown: !!shown };
    delete e.cands;
  }
  for (const e of outEdges) delete e.cands;

  /* stage bands: consecutive rows of one role merge; the floor is EXTERNAL */
  const stages = [];
  for (let l = 0; l < L; l++) {
    const last = stages[stages.length - 1];
    if (last && last.text === rowRole[l]) { last.h = lBot(l) - last.y; continue; }
    stages.push({ y: top[l], h: layerH[l], text: rowRole[l] });
  }
  if (floorItems.length) stages.push({ y: floorTop + o.clusterHead, h: floorBottom - floorTop - o.clusterHead, text: "external" });

  let maxX = 0, maxY = 0;
  for (const c of outClusters) { maxX = Math.max(maxX, c.x + c.w); maxY = Math.max(maxY, c.y + c.h); }
  for (const n of outNodes) { maxX = Math.max(maxX, n.x + n.w); maxY = Math.max(maxY, n.y + n.h); }
  for (const e of outEdges) for (const p of e.points) { maxX = Math.max(maxX, p[0] + 8); maxY = Math.max(maxY, p[1] + 4); }
  for (const e of outEdges) if (e.label) maxX = Math.max(maxX, (e.label.anchor === "middle" ? e.label.x + e.label.w / 2 : e.label.x + e.label.w) + 4);
  for (const s of stages) maxY = Math.max(maxY, s.y + s.h);
  const out = { width: Math.ceil(maxX + o.margin), height: Math.ceil(maxY + o.margin), nodes: outNodes, clusters: outClusters, edges: outEdges, stages, spine: S.spine.slice(), layers: L };
  if (o.debug) out.dummies = [...items.values()].filter((it) => !it.real).map((it) => ({ id: it.id, x: it.x, y: it.y, layer: it.layer, lane: it.cluster, from: it.edge.from, to: it.edge.to }));
  return out;
}

export function layoutFlow(graph, opts = {}) {
  const S = prepare(graph || {}, opts);
  stageNodes(S);
  classifyEdges(S);
  findSpine(S);
  measureNodes(S);
  buildItems(S);
  packClusters(S);
  orderRows(S);
  routeSides(S);
  placeY(S);
  return emit(S);
}

/* -------------------------------------------------------------- renderer */

const SVG_NS = "http://www.w3.org/2000/svg";
function svgEl(tag, attrs, parent) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) if (attrs[k] !== undefined && attrs[k] !== null) el.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(el);
  return el;
}
function htmlEl(tag, cls, parent, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  if (parent) parent.appendChild(el);
  return el;
}
function makeMeasure() {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  const cs = getComputedStyle(document.documentElement);
  const fam = { sans: cs.getPropertyValue("--sans").trim() || "system-ui, sans-serif", mono: cs.getPropertyValue("--mono").trim() || "ui-monospace, monospace" };
  const cache = new Map();
  if (!ctx) return approxMeasure;
  return (text, fontKey) => {
    const f = FONTS[fontKey] || FONTS.title;
    const k = fontKey + "\0" + text;
    let v = cache.get(k);
    if (v === undefined) {
      ctx.font = `${f.weight} ${f.size}px ${fam[f.family]}`;
      v = ctx.measureText(text).width + (f.tracking ? text.length * f.tracking * f.size : 0);
      cache.set(k, v);
    }
    return v;
  };
}
const splitAt = (at) => { const i = at.lastIndexOf(":"); return i < 0 ? [at, 1] : [at.slice(0, i), Number(at.slice(i + 1)) || 1]; };

export function renderFlow(container, graph, opts = {}) {
  const measure = opts.measure || makeMeasure();
  const layout = layoutFlow(graph, { ...opts, measure });
  const nodeById = new Map((graph.nodes || []).map((n) => [n.id, n]));
  const lnode = new Map(layout.nodes.map((n) => [n.id, n]));
  const order = (graph.order || []).filter((id) => nodeById.has(id));
  for (const n of graph.nodes || []) if (!order.includes(n.id)) order.push(n.id);
  const spineSet = new Set(layout.spine);

  container.classList.add("flow");
  container.textContent = "";
  const chart = htmlEl("div", "flow-chart", container);
  const walkHost = opts.walkthrough || htmlEl("aside", "flow-walk", container);
  const collapsible = !opts.walkthrough;
  let collapsed = collapsible && (container.dataset.walkCollapsed !== undefined
    ? container.dataset.walkCollapsed === "true" : !!opts.walkthroughCollapsed);
  container.classList.toggle("walk-collapsed", collapsed);

  /* --- svg --- */
  const svg = svgEl("svg", { class: "flow-svg", tabindex: "0", role: "group", "aria-label": graph.topic || "flow" }, chart);
  const view = svgEl("g", { class: "flow-view" }, svg);
  const gClusters = svgEl("g", { class: "flow-clusters" }, view);
  const gEdges = svgEl("g", { class: "flow-edges" }, view);
  const gNodes = svgEl("g", { class: "flow-nodes" }, view);
  const gLabels = svgEl("g", { class: "flow-labels" }, view);
  const gutter = htmlEl("div", "flow-gutter", chart);
  gutter.setAttribute("aria-hidden", "true");
  const stageEls = layout.stages.map((s) => { const d = htmlEl("div", "flow-stage", gutter, s.text); d.dataset.y = s.y; d.dataset.h = s.h; return d; });

  for (const c of layout.clusters) {
    const g = svgEl("g", { class: "flow-cluster" + (c.floor ? " is-floor" : ""), "data-id": c.id }, gClusters);
    svgEl("rect", { x: c.x, y: c.y, width: c.w, height: c.h, rx: 6 }, g);
    svgEl("text", { x: c.x + 12, y: c.y + 14 }, g).textContent = c.title;
  }

  const edgeEls = [];
  for (const e of layout.edges) {
    const cls = ["flow-edge", "k-" + e.kind, e.back ? "is-back" : "", e.side ? "is-side" : "", e.spine ? "is-spine" : ""].filter(Boolean).join(" ");
    const g = svgEl("g", { class: cls, "data-from": e.from, "data-to": e.to }, gEdges);
    g.style.setProperty("--o", (0.35 + 0.5 * e.carries).toFixed(2));
    svgEl("path", { class: "flow-hit", d: e.d }, g);
    svgEl("path", { class: "flow-line", d: e.d }, g);
    const a = e.arrow, s = 3.4, l = 6.5;
    const tri = a.dir === "down" ? `${fmt(a.x)},${fmt(a.y)} ${fmt(a.x - s)},${fmt(a.y - l)} ${fmt(a.x + s)},${fmt(a.y - l)}`
      : a.dir === "up" ? `${fmt(a.x)},${fmt(a.y)} ${fmt(a.x - s)},${fmt(a.y + l)} ${fmt(a.x + s)},${fmt(a.y + l)}`
      : a.dir === "left" ? `${fmt(a.x)},${fmt(a.y)} ${fmt(a.x + l)},${fmt(a.y - s)} ${fmt(a.x + l)},${fmt(a.y + s)}`
      : `${fmt(a.x)},${fmt(a.y)} ${fmt(a.x - l)},${fmt(a.y - s)} ${fmt(a.x - l)},${fmt(a.y + s)}`;
    svgEl("polygon", { class: "flow-arrow", points: tri }, g);
    const src = nodeById.get(e.from), dst = nodeById.get(e.to);
    svgEl("title", {}, g).textContent = `${src ? src.title : e.from} → ${dst ? dst.title : e.to} · ${e.kind}${e.back ? " (back)" : ""}${e.names.length ? " · " + e.names.join(", ") : ""}${e.via && e.via.length ? " · via " + e.via.map(basename).join(" › ") : ""}${e.at ? " · " + e.at : ""}`;
    if (e.label) {
      const lg = svgEl("g", { class: "flow-label" + (e.label.shown ? " is-shown" : ""), "data-from": e.from, "data-to": e.to }, gLabels);
      svgEl("text", { x: e.label.x, y: e.label.y + 3.5, "text-anchor": e.label.anchor }, lg).textContent = e.label.text;
      e.labelEl = lg;
    }
    e.el = g;
    edgeEls.push(e);
  }

  const nodeEls = new Map();
  for (const id of order) {
    const n = lnode.get(id), src = nodeById.get(id);
    if (!n) continue;
    const cls = ["flow-node", "kind-" + n.kind, n.rich ? "is-rich" : "is-compact", n.seed ? "is-seed" : "", n.spine ? "is-spine" : "", n.terminal ? "is-terminal" : ""].filter(Boolean).join(" ");
    const g = svgEl("g", { class: cls, "data-id": id, tabindex: "0", role: "button", "aria-label": `${src.title}, ${src.role}${src.summary ? ": " + src.summary : ""}` }, gNodes);
    g.style.setProperty("--pw", Math.pow(clamp(((n.part || 0) - 0.5) / 0.5, 0, 1), 2).toFixed(3));
    if (n.kind === "group") {
      svgEl("rect", { class: "flow-stack", x: n.x + 6, y: n.y + 6, width: n.w, height: n.h, rx: 4 }, g);
      svgEl("rect", { class: "flow-stack", x: n.x + 3, y: n.y + 3, width: n.w, height: n.h, rx: 4 }, g);
    }
    svgEl("rect", { class: "flow-box", x: n.x, y: n.y, width: n.w, height: n.h, rx: 4 }, g);
    if (n.seed) svgEl("rect", { class: "flow-seed", x: n.x, y: n.y + 6, width: 2, height: n.h - 12 }, g);
    const PADX = 12, PADY = 8;
    if (n.kind === "package") {
      svgEl("text", { class: "flow-title f-pkg", x: n.x + n.w / 2, y: n.y + n.h / 2 + 4, "text-anchor": "middle" }, g).textContent = n.text.title;
    } else {
      let ty = n.y + PADY + 11;
      svgEl("text", { class: "flow-title f-" + n.text.titleFont, x: n.x + PADX, y: ty }, g).textContent = n.text.title;
      if (n.text.role) svgEl("text", { class: "flow-role", x: n.x + n.w - PADX, y: ty - 0.5, "text-anchor": "end" }, g).textContent = n.text.role;
      if (n.text.sub) { ty += 14; svgEl("text", { class: "flow-sub", x: n.x + PADX, y: ty }, g).textContent = n.text.sub; }
      if (n.text.lines.length) {
        ty += 4;
        const t = svgEl("text", { class: "flow-summary", x: n.x + PADX, y: ty }, g);
        n.text.lines.forEach((line) => { svgEl("tspan", { x: n.x + PADX, dy: 14 }, t).textContent = line; });
      }
    }
    svgEl("title", {}, g).textContent = `${src.title} · ${src.role}${src.kind === "package" ? "" : "\n" + src.path + (src.symbol ? "#" + src.symbol : "")}${src.summary ? "\n" + src.summary : ""}`;
    nodeEls.set(id, g);
  }

  const near = new Map();
  for (const n of layout.nodes) near.set(n.id, new Set([n.id]));
  for (const e of layout.edges) { near.get(e.from).add(e.to); near.get(e.to).add(e.from); }

  /* --- walkthrough --- */
  walkHost.classList.add("flow-walk");
  walkHost.textContent = "";
  const head = htmlEl("header", "flow-head", walkHost);
  htmlEl("div", "flow-topic", head, graph.topic || "");
  const meta = htmlEl("div", "flow-meta", head);
  const v = htmlEl("span", "flow-verdict", meta, graph.verdict || "");
  v.dataset.v = graph.verdict || "";
  const d = graph.dropped || { nodes: 0, edges: 0, hubs: [] };
  htmlEl("span", "", meta, ` · ${(graph.nodes || []).length} steps · ${(graph.edges || []).length} references` + (d.nodes || d.edges ? ` · ${d.nodes || 0} nodes and ${d.edges || 0} references left out` : ""));
  if (layout.spine.length) {
    const sp = htmlEl("div", "flow-spine", head);
    htmlEl("span", "flow-spine-k", sp, "Main path");
    layout.spine.forEach((id, i) => {
      if (i) htmlEl("span", "flow-spine-a", sp, "→");
      const b = htmlEl("button", "flow-spine-s", sp, nodeById.get(id).title);
      b.type = "button";
      b.addEventListener("click", () => api.select(id));
    });
  }
  const ol = htmlEl("ol", "flow-steps", walkHost);
  const stepEls = new Map();
  let prevRole = null;
  order.forEach((id, i) => {
    const n = nodeById.get(id);
    if (n.role !== prevRole) { htmlEl("li", "flow-stage-h", ol, n.role); prevRole = n.role; }
    const li = htmlEl("li", "flow-step kind-" + n.kind + (n.seed ? " is-seed" : "") + (spineSet.has(id) ? " is-spine" : ""), ol);
    li.dataset.id = id;
    li.tabIndex = 0;
    const h = htmlEl("div", "flow-step-h", li);
    htmlEl("span", "flow-n", h, String(i + 1));
    htmlEl("span", "flow-t", h, n.title).title = n.title;
    const tag = [n.kind === "package" ? "package" : n.kind === "group" ? "group" : "", n.seed ? "seed" : ""].filter(Boolean).join(" · ");
    if (tag) htmlEl("span", "flow-r", h, tag);
    if (n.kind !== "package") {
      const p = htmlEl("div", "flow-p", li);
      const base = basename(n.path || "");
      htmlEl("span", "h", p, (n.path || "").slice(0, (n.path || "").length - base.length));
      htmlEl("span", "t", p, base + (n.symbol ? "#" + n.symbol : ""));
    }
    if (n.kind === "group" && Array.isArray(n.members)) {
      const m = htmlEl("div", "flow-members", li);
      for (const mid of n.members) htmlEl("div", "", m, n.path && mid.startsWith(n.path + "/") ? mid.slice(n.path.length + 1) : mid);
    }
    if (n.summary) htmlEl("p", "flow-s", li, n.summary);
    const outs = (graph.edges || []).filter((e) => e && e.from === id && nodeById.has(e.to) && e.to !== id);
    const ins = (graph.edges || []).filter((e) => e && e.to === id && nodeById.has(e.from) && e.from !== id);
    if (outs.length || ins.length) {
      const refs = htmlEl("div", "flow-refs", li);
      const addRef = (e, dir) => {
        const other = dir === "out" ? e.to : e.from;
        const names = Array.isArray(e.names) ? e.names : [];
        const row = htmlEl("div", "flow-ref k-" + e.kind + (e.back ? " is-back" : ""), refs);
        htmlEl("span", "flow-ref-d", row, dir === "out" ? "→" : "←");
        const b = htmlEl("button", "flow-ref-t", row, nodeById.get(other).title);
        b.type = "button";
        b.addEventListener("click", (ev) => { ev.stopPropagation(); api.select(other); });
        const via = Array.isArray(e.via) ? e.via.map(basename).join(" › ") : "";
        const what = names.length ? names.join(", ") : e.kind === "mention" ? "named in a comment" : e.kind === "via" ? "via " + via : e.kind === "reexport" ? "re-export" : "side-effect import";
        const full = what + (e.kind === "via" && names.length ? " · via " + via : "") + (e.kind === "mention" && names.length ? " · in a comment" : "") + (e.back ? " · back" : "");
        const nm = htmlEl("span", "flow-ref-n", row, full);
        nm.title = full;
        if (e.at) {
          const [ap, al] = splitAt(e.at);
          const at = htmlEl("button", "flow-ref-at", row, basename(ap) + ":" + al);
          at.title = e.at;
          at.type = "button";
          at.addEventListener("click", (ev) => { ev.stopPropagation(); if (opts.onOpen) opts.onOpen(ap, al); });
        }
      };
      for (const e of outs) addRef(e, "out");
      for (const e of ins) addRef(e, "in");
    }
    const evs = Array.isArray(n.evidence) ? n.evidence : [];
    if (evs.length) {
      const det = htmlEl("details", "flow-ev", li);
      htmlEl("summary", "", det, `${evs.length} ${evs.length === 1 ? "block" : "blocks"} of evidence`);
      for (const ev of evs) {
        const b = htmlEl("div", "flow-evb k-" + ev.kind, det);
        const bh = htmlEl("div", "flow-evh", b);
        const loc = htmlEl("button", "flow-loc", bh, `${ev.path}:${ev.line}`);
        loc.type = "button";
        loc.title = `open ${ev.path}:${ev.line}`;
        loc.addEventListener("click", (e2) => { e2.stopPropagation(); if (opts.onOpen) opts.onOpen(ev.path, ev.line); });
        htmlEl("span", "flow-evk", bh, ev.kind === "comment" ? "comment" : "code");
        const pre = htmlEl("pre", "flow-code", b);
        const lines = Array.isArray(ev.lines) ? ev.lines : [];
        const width = String(ev.line + lines.length - 1).length;
        lines.forEach((line, k) => {
          const row = htmlEl("span", "flow-cl", pre);
          htmlEl("span", "ln", row, String(ev.line + k).padStart(width));
          htmlEl("span", "lc", row, line || " ");
        });
      }
    }
    li.addEventListener("click", (ev) => { if (ev.target.closest("summary, button")) return; api.select(id); });
    li.addEventListener("keydown", (ev) => { if (ev.target !== li) return; if (ev.key === "Enter") { ev.preventDefault(); api.select(id); } else stepKeys(ev, id); });
    li.addEventListener("pointerenter", () => { hovered = id; refresh(); });
    li.addEventListener("pointerleave", () => { if (hovered === id) { hovered = null; refresh(); } });
    stepEls.set(id, li);
  });
  if (Array.isArray(d.hubs) && d.hubs.length) {
    const foot = htmlEl("div", "flow-dropped", walkHost);
    htmlEl("span", "", foot, "hubs left out: ");
    d.hubs.forEach((h2, i) => { htmlEl("code", "", foot, h2); if (i < d.hubs.length - 1) htmlEl("span", "", foot, ", "); });
  }

  /* --- pan / zoom --- */
  const tf = { k: 1, x: 0, y: 0 };
  const GUT = layout.stages.length ? (chart.clientWidth < 600 ? 60 : 84) : 0; // screen pixels reserved for the stage labels
  let userMoved = false;
  const placeStages = () => {
    const H = chart.clientHeight || 600;
    gutter.style.left = Math.max(0, Math.min(tf.x - GUT, (chart.clientWidth || 800) - GUT)) + "px";
    let lastTop = -Infinity;
    stageEls.forEach((el) => {
      const y = +el.dataset.y * tf.k + tf.y + Math.min(12 * tf.k, 12);
      const bottom = (+el.dataset.y + +el.dataset.h) * tf.k + tf.y;
      const on = y > -14 && y < H && bottom > 0 && y - lastTop >= 14;
      el.hidden = !on;
      if (on) { el.style.top = y + "px"; lastTop = y; }
    });
  };
  const apply = () => { view.setAttribute("transform", `translate(${fmt(tf.x)} ${fmt(tf.y)}) scale(${Math.round(tf.k * 1000) / 1000})`); zoomLabel.textContent = Math.round(tf.k * 100) + "%"; placeStages(); };
  const fit = (overview = false) => {
    const W = (chart.clientWidth || 800) - GUT, H = chart.clientHeight || 600;
    const pad = 16;
    tf.k = clamp(Math.min((W - 2 * pad) / Math.max(1, layout.width), (H - 2 * pad) / Math.max(1, layout.height)), 0.15, 1);
    tf.x = GUT + (W - layout.width * tf.k) / 2;
    tf.y = (H - layout.height * tf.k) / 2;
    // On a phone, begin with readable source nodes instead of an illegible thumbnail.
    // The explicit Fit control still gives the full overview; pan/zoom explores the rest.
    if (!overview && chart.clientWidth < 600 && layout.nodes.length) {
      const first = lnode.get(selected) || lnode.get(order[0]) || layout.nodes[0];
      tf.k = Math.max(tf.k, 1);
      tf.x = GUT + (W - first.w * tf.k) / 2 - first.x * tf.k;
      tf.y = 72 - first.y * tf.k;
    }
    userMoved = overview;
    apply();
  };
  const zoomBy = (f, cx, cy) => {
    const k2 = clamp(tf.k * f, 0.15, 3);
    const W = chart.clientWidth, H = chart.clientHeight;
    if (cx === undefined) { cx = W / 2; cy = H / 2; }
    tf.x = cx - (cx - tf.x) * (k2 / tf.k);
    tf.y = cy - (cy - tf.y) * (k2 / tf.k);
    tf.k = k2;
    userMoved = true;
    apply();
  };
  const bar = htmlEl("div", "flow-zoom", chart);
  const bOut = htmlEl("button", "", bar); bOut.type = "button"; bOut.title = "Zoom out"; bOut.setAttribute("aria-label", "Zoom out");
  const zoomLabel = htmlEl("span", "flow-zoom-k", bar, "100%");
  const bIn = htmlEl("button", "", bar); bIn.type = "button"; bIn.title = "Zoom in"; bIn.setAttribute("aria-label", "Zoom in");
  for (const [button, d] of [[bOut, "M5 12h14"], [bIn, "M5 12h14M12 5v14"]]) {
    const icon = svgEl("svg", { class: "flow-control-icon", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.6", "stroke-linecap": "round", "aria-hidden": "true" }, button);
    svgEl("path", { d }, icon);
  }
  const bFit = htmlEl("button", "", bar, "fit"); bFit.type = "button"; bFit.title = "Fit to view (0)";
  bOut.addEventListener("click", () => zoomBy(1 / 1.25));
  bIn.addEventListener("click", () => zoomBy(1.25));
  bFit.addEventListener("click", () => fit(true));
  if (collapsible) {
    const toggle = htmlEl("button", "flow-walk-toggle", chart);
    toggle.type = "button";
    const update = () => {
      toggle.textContent = collapsed ? "Show walkthrough" : "Hide walkthrough";
      toggle.setAttribute("aria-expanded", String(!collapsed));
      container.classList.toggle("walk-collapsed", collapsed);
      container.dataset.walkCollapsed = String(collapsed);
    };
    toggle.addEventListener("click", () => { collapsed = !collapsed; update(); fit(); });
    update();
  }

  const onWheel = (ev) => {
    ev.preventDefault();
    const r = svg.getBoundingClientRect();
    const f = Math.exp(-ev.deltaY * (ev.deltaMode === 1 ? 0.05 : 0.0016));
    zoomBy(f, ev.clientX - r.left, ev.clientY - r.top);
  };
  svg.addEventListener("wheel", onWheel, { passive: false });
  let drag = null, pinch = null, suppressClick = false;
  const pointers = new Map();
  const pinchStart = () => {
    const [a, b] = [...pointers.values()];
    const bounds = svg.getBoundingClientRect();
    pinch = { distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), k: tf.k,
      x: ((a.x + b.x) / 2 - bounds.left - tf.x) / tf.k,
      y: ((a.y + b.y) / 2 - bounds.top - tf.y) / tf.k };
    drag = null; suppressClick = true;
  };
  svg.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (pointers.size === 2) { pinchStart(); return; }
    suppressClick = false;
    drag = { x: ev.clientX, y: ev.clientY, tx: tf.x, ty: tf.y, moved: false, id: ev.pointerId };
  });
  svg.addEventListener("pointermove", (ev) => {
    if (!pointers.has(ev.pointerId)) return;
    pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (pinch && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const bounds = svg.getBoundingClientRect();
      tf.k = clamp(pinch.k * Math.hypot(a.x - b.x, a.y - b.y) / pinch.distance, 0.15, 3);
      tf.x = (a.x + b.x) / 2 - bounds.left - pinch.x * tf.k;
      tf.y = (a.y + b.y) / 2 - bounds.top - pinch.y * tf.k;
      userMoved = true; apply(); return;
    }
    if (!drag) return;
    const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 3) return;
    if (!drag.moved) { try { svg.setPointerCapture(drag.id); } catch { /* pointer gone */ } }
    drag.moved = true; userMoved = true;
    tf.x = drag.tx + dx; tf.y = drag.ty + dy; apply();
    svg.classList.add("is-dragging");
  });
  const endDrag = (ev) => {
    pointers.delete(ev.pointerId);
    if ((drag && drag.moved) || pinch) suppressClick = true;
    pinch = null; drag = null; svg.classList.remove("is-dragging");
  };
  svg.addEventListener("pointerup", endDrag);
  svg.addEventListener("pointercancel", endDrag);
  svg.addEventListener("click", (ev) => {
    if (suppressClick) { suppressClick = false; return; }
    const g = ev.target.closest(".flow-node");
    if (g) { api.select(g.dataset.id, { reveal: false }); return; }
    const eg = ev.target.closest(".flow-edge");
    if (eg) { const e = edgeEls.find((x) => x.el === eg); if (e && e.at && opts.onOpen) { const [p, l] = splitAt(e.at); opts.onOpen(p, l); } return; }
    api.select(null);
  });
  const stepKeys = (ev, fromId) => {
    const isNext = ev.key === "ArrowDown" || ev.key === "j", isPrev = ev.key === "ArrowUp" || ev.key === "k";
    if (!isNext && !isPrev) return false;
    ev.preventDefault();
    const cur = fromId || selected;
    const i = cur ? order.indexOf(cur) : -1;
    const next = order[isNext ? Math.min(order.length - 1, i + 1) : Math.max(0, i - 1)];
    if (next) { api.select(next); const g = nodeEls.get(next); if (g && ev.currentTarget === svg) g.focus({ preventScroll: true }); }
    return true;
  };
  svg.addEventListener("keydown", (ev) => {
    const g = ev.target.closest && ev.target.closest(".flow-node");
    if (g && (ev.key === "Enter" || ev.key === " ")) { ev.preventDefault(); api.select(g.dataset.id); return; }
    if (ev.key === "Escape") { api.select(null); return; }
    if (ev.key === "+" || ev.key === "=") { ev.preventDefault(); zoomBy(1.25); }
    else if (ev.key === "-") { ev.preventDefault(); zoomBy(1 / 1.25); }
    else if (ev.key === "0") { ev.preventDefault(); fit(true); }
    else if ((g || ev.key === "j" || ev.key === "k") && stepKeys(ev, g ? g.dataset.id : null)) return;
    else if (ev.key.startsWith("Arrow")) { ev.preventDefault(); const s = 40; tf.x += ev.key === "ArrowLeft" ? s : ev.key === "ArrowRight" ? -s : 0; tf.y += ev.key === "ArrowUp" ? s : ev.key === "ArrowDown" ? -s : 0; userMoved = true; apply(); }
  });

  /* --- hover / selection --- */
  let selected = null, hovered = null, hotEdge = null;
  const focusOn = (id) => {
    const set = id ? near.get(id) : null;
    const on = !!id || !!hotEdge;
    container.classList.toggle("is-focus", on);
    for (const [nid, g] of nodeEls) { g.classList.toggle("is-near", (!!set && set.has(nid)) || (!!hotEdge && (hotEdge.from === nid || hotEdge.to === nid))); g.classList.toggle("is-hot", nid === id); }
    for (const e of edgeEls) {
      const lit = (!!id && (e.from === id || e.to === id)) || e === hotEdge;
      e.el.classList.toggle("is-near", lit);
      if (e.labelEl) e.labelEl.classList.toggle("is-near", lit);
    }
  };
  const refresh = () => focusOn(hovered || selected);
  for (const [id, g] of nodeEls) {
    g.addEventListener("pointerenter", () => { hovered = id; refresh(); });
    g.addEventListener("pointerleave", () => { if (hovered === id) { hovered = null; refresh(); } });
    g.addEventListener("focus", () => { hovered = id; refresh(); });
    g.addEventListener("blur", () => { if (hovered === id) { hovered = null; refresh(); } });
  }
  for (const e of edgeEls) {
    e.el.addEventListener("pointerenter", () => { hotEdge = e; refresh(); });
    e.el.addEventListener("pointerleave", () => { if (hotEdge === e) { hotEdge = null; refresh(); } });
  }
  const ensureVisible = (id) => {
    const n = lnode.get(id);
    const W = chart.clientWidth, H = chart.clientHeight;
    const x0 = n.x * tf.k + tf.x, y0 = n.y * tf.k + tf.y, x1 = x0 + n.w * tf.k, y1 = y0 + n.h * tf.k;
    const m = 24;
    if (x0 >= GUT + m && y0 >= m && x1 <= W - m && y1 <= H - m) return;
    tf.x = GUT + (W - GUT) / 2 - (n.x + n.w / 2) * tf.k;
    tf.y = H / 2 - (n.y + n.h / 2) * tf.k;
    userMoved = true;
    apply();
  };
  const api = {
    select(id, sopts = {}) {
      if (id && !lnode.has(id)) id = null;
      if (selected && nodeEls.has(selected)) { nodeEls.get(selected).classList.remove("is-selected"); const s = stepEls.get(selected); if (s) s.classList.remove("is-selected"); }
      selected = id;
      container.classList.toggle("has-selection", !!id);
      if (id) {
        nodeEls.get(id).classList.add("is-selected");
        const li = stepEls.get(id);
        if (li) {
          li.classList.add("is-selected");
          const det = li.querySelector("details.flow-ev");
          if (det) det.open = true;
          li.scrollIntoView({ block: "nearest", behavior: "auto" });
        }
        if (sopts.reveal !== false) ensureVisible(id);
      }
      refresh();
      if (opts.onSelect) opts.onSelect(id);
    },
    fit,
    layout,
    destroy() {
      svg.removeEventListener("wheel", onWheel);
      if (ro) ro.disconnect();
      container.textContent = "";
      container.classList.remove("flow", "is-focus", "has-selection", "walk-collapsed");
    },
  };
  let ro = null;
  if (typeof ResizeObserver !== "undefined") { ro = new ResizeObserver(() => { if (!userMoved) fit(); else placeStages(); }); ro.observe(chart); }
  fit();
  return api;
}
