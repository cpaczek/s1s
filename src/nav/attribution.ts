import type { NavEvent, SearchResult } from "./events.ts";
import { T } from "../questions.ts";

/**
 * LOSS ATTRIBUTION — for a query whose right answer is known, say at which
 * stage the search lost it. Pure code over the event trace + the result: no
 * calls. The stages, from best to worst:
 *
 *   hit         the top result is accepted
 *   rank        accepted and verified ≥ PARTIAL, but something else out-ranked it
 *   verify      it reached verification and the verify Noul rejected it (< PARTIAL)
 *   shortlist   find: it was in the lexical pool, and its shortlist Noul kept it out of verification
 *   unverified  TypeSafe saw it as an option (or scored it) but it never reached verification
 *   descent     an ancestor was expanded, but the next container on the way down never was
 *   first_hop   the same, and the ancestor is the scope root
 *   unretrieved find: the lexical pool never contained it, and no walk reached it
 *   unseen      nothing on its path was ever looked at
 */
export type LossStage = "hit" | "rank" | "verify" | "shortlist" | "unverified" | "descent" | "first_hop" | "unretrieved" | "unseen";

export type Loss = {
  stage: LossStage;
  /** The accepted path this describes (the one that got furthest). */
  path: string;
  /** Deepest container on the way to `path` that was expanded ("" = root). */
  at?: string;
  /** What the right child got at that expansion, and its 1-based rank among the options. */
  childP?: number;
  childRank?: number;
  /** Its verify Noul (or map/scan Noul), when it got one. */
  verify?: number;
};

const ORDER: LossStage[] = ["unseen", "unretrieved", "first_hop", "descent", "unverified", "shortlist", "verify", "rank", "hit"];

/** Best probability each option ever got per expanded container (seeded walks may overlap; keep the max). */
function expansions(events: NavEvent[]): Map<string, Map<string, number>> {
  const byDir = new Map<string, Map<string, number>>();
  for (const e of events) {
    if (e.type !== "expand") continue;
    const seen = byDir.get(e.path) ?? new Map<string, number>();
    for (const o of e.options) if (o.kind !== "none") seen.set(o.path, Math.max(seen.get(o.path) ?? 0, o.p));
    byDir.set(e.path, seen);
  }
  return byDir;
}

/** Find: path → shortlist Noul for everything shortlisted; `pooled` = whether a lexical stage ran at all. */
function shortlists(events: NavEvent[]): { pooled: boolean; nouls: Map<string, number> } {
  const nouls = new Map<string, number>();
  for (const e of events) if (e.type === "shortlist") for (const c of e.candidates) nouls.set(c.path, c.noul);
  return { pooled: events.some((e) => e.type === "lexical"), nouls };
}

function lossFor(path: string, byDir: Map<string, Map<string, number>>, short: ReturnType<typeof shortlists>, result: SearchResult): Loss {
  const i = result.results.findIndex((r) => r.path === path);
  if (i === 0) return { stage: "hit", path, verify: result.results[0].verify ?? result.results[0].noul };
  if (i > 0) {
    const v = result.results[i].verify ?? result.results[i].noul ?? 0;
    return { stage: v >= T.PARTIAL ? "rank" : "verify", path, verify: v };
  }

  // The chain of containers from the scope down to the unit's parent.
  const scope = result.params.scope;
  const rel = scope ? path.slice(scope.length + 1) : path;
  const parts = rel.split("/");
  const chain = [scope];
  for (let k = 0; k < parts.length - 1; k++) chain.push((chain[k] ? chain[k] + "/" : "") + parts[k]);

  // Find: a shortlisted unit got as far as TypeSafe's first look — further than any descent loss.
  const noul = short.nouls.get(path);
  if (noul !== undefined) return { stage: "shortlist", path, verify: noul };

  let at: string | undefined;
  for (const dir of chain) if (byDir.has(dir)) at = dir;
  if (at === undefined && short.pooled) return { stage: "unretrieved", path };
  if (at === undefined) {
    // No descent at all (a battery): it is unverified when it got a score, unseen otherwise.
    const h = result.heat[path];
    return h === undefined ? { stage: "unseen", path } : { stage: "unverified", path, verify: h };
  }
  const next = chain[chain.indexOf(at) + 1] ?? path;
  const seen = byDir.get(at)!;
  const childP = seen.get(next) ?? 0;
  const childRank = [...seen.values()].filter((p) => p > childP).length + 1;
  const stage: LossStage = next === path ? "unverified" : at === scope ? "first_hop" : "descent";
  return { stage, path, at, childP, childRank };
}

/** The loss of the accepted path that got furthest; undefined for an "absent" gold row. */
export function attributeLoss(events: NavEvent[], result: SearchResult, accept: string[]): Loss | undefined {
  if (!accept.length) return undefined;
  const byDir = expansions(events);
  const short = shortlists(events);
  const further = (a: Loss, b: Loss) => ORDER.indexOf(a.stage) - ORDER.indexOf(b.stage) || (a.childP ?? 0) - (b.childP ?? 0);
  return accept.map((p) => lossFor(p, byDir, short, result)).reduce((best, l) => (further(l, best) > 0 ? l : best));
}
