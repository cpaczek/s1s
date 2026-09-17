import type { Client } from "../client.ts";
import type { RepoIndex } from "../index/build.ts";
import type { ChoiceAnswer, NoulAnswer, Structured } from "../types.ts";
import type { BeamEntry, NavEvent } from "./events.ts";
import { NONE, REPO_DOMAIN, T, verifyQuestions, verifyState, type Candidate } from "../questions.ts";
import { askChildren, isBacktrack, type Emit, type Tally } from "./walk.ts";
import { candidateFor, verify } from "./verify.ts";

/**
 * EXPLORE — the walk that can go back up.
 *
 * Best-first search over the whole tree with a global frontier: every child ever
 * generated stays a candidate (nothing is discarded like a beam does). Leaves are
 * verified as soon as they lead the frontier. When a branch turns out dead — its
 * Choice went to `__none__`, its under-here Noul collapsed, or its leaf failed
 * verification — the search WALKS UP: it re-asks the parent's Choice with the dead
 * children excluded, so the probability mass the trap absorbed flows back to the
 * siblings, whose subtrees are rescored in place. A leaf that verifies ≥ FOUND does
 * not end the search on its own: the frontier runs a few more steps, then one
 * COMPARATIVE verify (Noul per candidate + a Choice across them, like walk/scan)
 * decides among every leaf worth considering. Otherwise it stops when the call
 * budget is spent.
 */
export type ExploreItem = {
  path: string;
  kind: "dir" | "file";
  parent: string | null;
  edgeP: number;
  probProduct: number;
  decisions: number;
  /** Geometric mean of edge probabilities (length-normalised). */
  score: number;
  /** Multiplicative penalty from dead real picks beneath this node (1 = untouched). Ranking uses score × penalty. */
  penalty: number;
  /** Direct children that died after being real picks (edge p ≥ WALK_UP_MIN_P). */
  deadPicks: number;
  /** Best verify Noul seen beneath this node. */
  bestVerify: number;
  status: "open" | "expanded" | "dead" | "verified";
  verify?: number;
};

export type ExploreOutcome = {
  /** Leaves that were verified, best first (dead leaves included, at the bottom). */
  verified: ExploreItem[];
  /** The comparative endgame's pick probability per path, when it ran. */
  pick?: Map<string, number>;
  heat: Map<string, number>;
  visited: string[];
  dead: string[];
  walkUps: number;
  found?: string;
  separation?: number;
};

const geo = (probProduct: number, decisions: number) =>
  decisions === 0 ? 1 : probProduct > 0 ? Math.exp(Math.log(probProduct) / decisions) : 0;
const rank = (it: ExploreItem) => it.score * it.penalty;

export async function explore(opts: {
  client: Client;
  index: RepoIndex;
  query: Structured;
  scope: string;
  width?: number;
  maxCalls?: number;
  emit: Emit;
  tally: Tally;
}): Promise<ExploreOutcome> {
  const { client, index, query, emit, tally } = opts;
  const width = opts.width ?? T.EXPLORE_WIDTH;
  const maxCalls = opts.maxCalls ?? T.EXPLORE_MAX_CALLS;
  const domain = index.domain ?? REPO_DOMAIN;
  const scopeNode = index.byPath.get(opts.scope);
  if (!scopeNode || scopeNode.kind !== "dir") throw new Error(`scope is not a ${domain.container}: ${opts.scope || "/"}`);

  const items = new Map<string, ExploreItem>();
  const heat = new Map<string, number>();
  const visited: string[] = [];
  const dead: string[] = [];
  const walkUpsDone = new Map<string, number>();
  /** Parents whose decision must be re-asked before the next pick. */
  const pendingWalkUps = new Set<string>();
  let calls = 0;
  let step = 0;
  let found: string | undefined;
  let foundAtStep: number | undefined;
  let walkUps = 0;
  let prevTop: ExploreItem | undefined;

  const startCalls = tally.calls;
  const spent = () => tally.calls - startCalls;
  const setHeat = (it: ExploreItem) => heat.set(it.path, it.status === "verified" || it.status === "dead" ? (it.verify ?? rank(it)) : rank(it));

  items.set(opts.scope, { path: opts.scope, kind: "dir", parent: null, edgeP: 1, probProduct: 1, decisions: 0, score: 1, penalty: 1, deadPicks: 0, bestVerify: 0, status: "open" });

  const ancestorsOf = function* (it: ExploreItem) {
    let p = it.parent;
    while (p !== null) {
      const a = items.get(p);
      if (!a) break;
      yield a;
      p = a.parent;
    }
  };

  const markDead = (it: ExploreItem, reason: "none" | "under_here" | "verify" | "exhausted", value: number) => {
    if (it.status === "dead") return;
    it.status = "dead";
    dead.push(it.path);
    setHeat(it);
    emit({ type: "dead", step, path: it.path, reason, value });
    // A 2% child dying says nothing about the parent's decision; a real pick dying does.
    if (it.edgeP < T.WALK_UP_MIN_P || it.parent === null) return;
    const parent = items.get(it.parent);
    if (!parent) return;
    parent.deadPicks++;
    if ((walkUpsDone.get(it.parent) ?? 0) < T.WALK_UPS_PER_DIR) pendingWalkUps.add(it.parent);
    // Evidence flows UP: every ancestor loses a little rank (soft), and a parent that
    // has buried enough of its own real picks with nothing even partial beneath it is
    // exhausted (hard) — which re-decides ITS parent without it, and so on upward.
    for (const a of ancestorsOf(it)) {
      a.penalty *= T.DEAD_DECAY;
      if (a.status !== "dead") setHeat(a);
    }
    if (
      parent.parent !== null &&
      parent.status === "expanded" &&
      parent.deadPicks >= T.DEAD_PICKS_TO_EXHAUST &&
      parent.bestVerify < T.PARTIAL
    ) {
      markDead(parent, "exhausted", parent.deadPicks);
    }
  };

  /** Multiply a subtree's path probabilities by `factor` (its root's edge changed). */
  const rescale = (root: ExploreItem, newEdgeP: number) => {
    const factor = root.edgeP > 0 ? newEdgeP / root.edgeP : 0;
    root.edgeP = newEdgeP;
    const prefix = root.path + "/";
    for (const it of items.values()) {
      if (it.path !== root.path && !it.path.startsWith(prefix)) continue;
      it.probProduct = root.edgeP > 0 || factor > 0 ? it.probProduct * factor : 0;
      it.score = geo(it.probProduct, it.decisions);
      if (it.status !== "verified") setHeat(it);
    }
  };

  const expandInto = (parent: ExploreItem, probs: Record<string, number>) => {
    const node = index.byPath.get(parent.path)!;
    for (const k of node.children ?? []) {
      if (items.has(k.path)) continue;
      const p = probs[k.name] ?? 0;
      const it: ExploreItem = {
        path: k.path,
        kind: k.kind,
        parent: parent.path,
        edgeP: p,
        probProduct: parent.probProduct * p,
        decisions: parent.decisions + 1,
        score: geo(parent.probProduct * p, parent.decisions + 1),
        penalty: parent.penalty,
        deadPicks: 0,
        bestVerify: 0,
        status: "open",
      };
      items.set(k.path, it);
      setHeat(it);
    }
  };

  const confirmOver = () => found !== undefined && foundAtStep !== undefined && step - foundAtStep >= T.EXPLORE_CONFIRM_STEPS;
  while (spent() < maxCalls && !confirmOver()) {
    // 1. Walk up: re-decide any parent whose preferred child died.
    if (pendingWalkUps.size) {
      const parents = [...pendingWalkUps];
      pendingWalkUps.clear();
      await Promise.all(
        parents.map(async (parentPath) => {
          const parent = items.get(parentPath);
          const node = index.byPath.get(parentPath);
          if (!parent || !node || parent.status === "dead") return;
          const excluded = (node.children ?? []).filter((k) => items.get(k.path)?.status === "dead").map((k) => k.path);
          const live = (node.children ?? []).filter((k) => !excluded.includes(k.path));
          if (!live.length) {
            // Nothing left to choose from: the branch is spent (the scope root never dies).
            if (parent.parent !== null) markDead(parent, "exhausted", excluded.length);
            return;
          }
          walkUpsDone.set(parentPath, (walkUpsDone.get(parentPath) ?? 0) + 1);
          walkUps++;
          const r = await askChildren(client, query, node, live, tally, domain);
          calls++;
          emit({ type: "walk_up", step, path: parentPath, excluded, options: r.seen, underHere: r.underHere, latencyMs: r.latencyMs, tokens: r.tokens });
          for (const k of live) {
            const it = items.get(k.path);
            if (it && it.status !== "dead") rescale(it, r.probs[k.name] ?? 0);
          }
          const pNone = r.probs[NONE] ?? 0;
          if (parent.decisions > 0 && pNone >= T.NONE_DEAD) markDead(parent, "none", pNone);
        }),
      );
    }

    // 2. Pick the best open items (dirs to expand, leaves to verify).
    const open = [...items.values()].filter((i) => i.status === "open").sort((a, b) => rank(b) - rank(a));
    if (!open.length) break;
    const pick = open.slice(0, width);
    const dirs = pick.filter((i) => i.kind === "dir");
    const files = pick.filter((i) => i.kind === "file");

    await Promise.all([
      ...dirs.map(async (d) => {
        d.status = "expanded";
        visited.push(d.path);
        const node = index.byPath.get(d.path)!;
        const r = await askChildren(client, query, node, node.children ?? [], tally, domain);
        calls++;
        emit({ type: "expand", step, path: d.path, parentScore: d.score, options: r.seen, underHere: r.underHere, confidence: r.confidence, latencyMs: r.latencyMs, tokens: r.tokens });
        expandInto(d, r.probs);
        const pNone = r.probs[NONE] ?? 0;
        if (d.decisions > 0) {
          if (pNone >= T.NONE_DEAD) markDead(d, "none", pNone);
          else if (r.underHere < T.UNDER_HERE_PRUNE) markDead(d, "under_here", r.underHere);
        }
      }),
      (async () => {
        if (!files.length) return;
        const cands: Candidate[] = files.map((f) => candidateFor(index, f.path));
        const res = await client(verifyState(query, cands), verifyQuestions(cands, domain));
        calls++;
        tally.calls++;
        tally.inputTokens += res.usage.input_tokens;
        tally.outputTokens += res.usage.output_tokens;
        tally.apiMs += res.latencyMs;
        tally.model = res.model;
        const best = res.answers.best as ChoiceAnswer;
        const rows = files.map((f, i) => ({ path: f.path, match: (res.answers[`match_${i}`] as NoulAnswer | undefined)?.noul ?? 0, pick: best.probabilities[f.path] ?? 0 }));
        emit({ type: "verify", candidates: rows, latencyMs: res.latencyMs, tokens: res.usage.input_tokens + res.usage.output_tokens });
        files.forEach((f, i) => {
          f.verify = rows[i].match;
          f.status = "verified";
          setHeat(f);
          for (const a of ancestorsOf(f)) a.bestVerify = Math.max(a.bestVerify, f.verify);
          if (f.verify >= T.FOUND) {
            if (!found || (items.get(found)?.verify ?? 0) < f.verify) found = f.path;
            if (foundAtStep === undefined) foundAtStep = step;
          } else if (f.verify < T.PARTIAL) {
            markDead(f, "verify", f.verify);
          }
        });
      })(),
    ]);

    const frontier = [...items.values()].filter((i) => i.status === "open").sort((a, b) => rank(b) - rank(a));
    const entries: BeamEntry[] = frontier.slice(0, 8).map((i) => ({ path: i.path, kind: i.kind, score: rank(i), depth: i.decisions, finished: false }));
    emit({ type: "beam", step, candidates: entries });
    const top = frontier[0];
    if (top && isBacktrack(prevTop as never, top as never)) emit({ type: "backtrack", step, from: prevTop!.path, to: top.path });
    if (top) prevTop = top;
    step++;
  }

  // Endgame: one comparative verify over everything worth comparing — leaves that
  // verified ≥ PARTIAL plus the best still-open leaves — exactly what walk/scan do.
  let pick: Map<string, number> | undefined;
  const contenders = [...items.values()].filter((i) => i.kind === "file" && i.verify !== undefined && i.verify >= T.PARTIAL);
  const openLeaves = [...items.values()].filter((i) => i.kind === "file" && i.status === "open").sort((a, b) => rank(b) - rank(a));
  const finalists = [...contenders, ...openLeaves].slice(0, T.VERIFY_TOP);
  if (finalists.length >= 1 && (contenders.length >= 1 || found) && spent() < maxCalls + 1) {
    const rows = await verify({ client, index, query, candidates: finalists.map((f) => ({ path: f.path, via: "explore" as const, pathScore: f.score })), emit, tally });
    calls++;
    pick = new Map(rows.map((r) => [r.path, r.pick ?? 0]));
    for (const r of rows) {
      const it = items.get(r.path)!;
      it.verify = r.verify;
      it.status = (r.verify ?? 0) < T.PARTIAL ? "dead" : "verified";
      setHeat(it);
    }
    found = rows[0] && (rows[0].verify ?? 0) >= T.FOUND ? rows[0].path : undefined;
  }

  const verified = [...items.values()]
    .filter((i) => i.verify !== undefined)
    .sort((a, b) => (b.verify ?? 0) - (a.verify ?? 0) || (pick?.get(b.path) ?? 0) - (pick?.get(a.path) ?? 0));
  const separation = verified.length >= 2 && (verified[1].verify ?? 0) > 0 ? (verified[0].verify ?? 0) / (verified[1].verify ?? 1) : undefined;
  void calls;
  return { verified, heat, visited, dead, walkUps, found, separation, pick };
}

export type { NavEvent };
