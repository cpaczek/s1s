// The contract between the navigator (server) and the UI (SSE events).
import type { FlowGraph, FlowRole } from "../flow/types.ts";

/**
 * find    = lexical pool → shortlist → verify, walking only when that does not find it (the default);
 * walk    = beam descent → verify;  explore = best-first descent with walk-ups;
 * map     = every unit that belongs to a subject (a heat map, not one answer).
 */
export type Strategy = "find" | "walk" | "explore" | "map";

/** Every strategy, for the CLI, the bench ("all") and the UI. */
export const STRATEGIES: readonly Strategy[] = ["find", "walk", "explore", "map"];

export type SearchParams = {
  query: string;
  strategy: Strategy;
  /** Directory path to search under ("" = repo root). */
  scope: string;
  beam: number;
  maxDepth: number;
};

export type OptionSeen = { name: string; path: string; kind: "dir" | "file" | "none"; p: number };

export type BeamEntry = { path: string; kind: "dir" | "file"; score: number; depth: number; finished: boolean };

export type NavEvent =
  | { type: "start"; params: SearchParams; at: number }
  | {
      type: "expand";
      step: number;
      path: string;
      parentScore: number;
      options: OptionSeen[];
      underHere: number;
      confidence: number;
      latencyMs: number;
      tokens: number;
    }
  | { type: "beam"; step: number; candidates: BeamEntry[] }
  | { type: "prune"; step: number; path: string; reason: "beam" | "under_here"; score: number }
  | { type: "backtrack"; step: number; from: string; to: string }
  /** Explore: a node is abandoned — a dir whose Choice went to `__none__` / under_here collapsed, or a leaf that failed verification. */
  | { type: "dead"; step: number; path: string; reason: "none" | "under_here" | "verify" | "exhausted"; value: number }
  /** Explore: the walk went back UP to `path` and re-decided among its children with the dead ones excluded. */
  | {
      type: "walk_up";
      step: number;
      path: string;
      excluded: string[];
      options: OptionSeen[];
      underHere: number;
      latencyMs: number;
      tokens: number;
    }
  /** Find: the zero-call lexical pool. `terms` with df 0 do not occur in this tree; `paths` is the whole pool, best first. */
  | {
      type: "lexical";
      terms: Array<{ label: string; df: number; weight: number }>;
      paths: string[];
      top: Array<{ path: string; score: number }>;
      anchors: string[];
      /** True when the scope is small enough that every unit was shortlisted (no pool needed). */
      whole: boolean;
      ms: number;
    }
  /** Find: TypeSafe judged which of the tree's own words belong to the query; the accepted ones joined the lexical query. */
  | { type: "terms"; offered: number; accepted: Array<{ term: string; noul: number }>; added: string[]; latencyMs: number; tokens: number }
  /** Find: one Noul per pooled unit, judged on its content descriptor. */
  | { type: "shortlist"; candidates: Array<{ path: string; noul: number }>; latencyMs: number; tokens: number }
  /** Find: the first verify did not find it — a walk starts from the scope root and these lexical anchors. */
  | { type: "escalate"; reason: "partial" | "absent"; seeds: string[] }
  /** Map: one batch of membership Nouls landed. `heat` is every unit in the batch → its Noul, so the UI paints it exactly as it lands. */
  | {
      type: "batch";
      batch: number;
      batches: number;
      units: number;
      top: Array<{ path: string; noul: number }>;
      heat: Record<string, number>;
      latencyMs: number;
      tokens: number;
    }
  | { type: "verify"; candidates: Array<{ path: string; match: number; pick: number }>; latencyMs: number; tokens: number }
  /** Explain: the map's members (best first) and the seeds the expansion starts from. */
  | { type: "explain_seeds"; members: Array<{ path: string; noul: number }>; seeds: string[]; truncated: number }
  /** Explain: one hop of the expansion — every unit judged (is it a step, plumbing, which role), which were expanded through, how many neighbours the next hop judges. */
  | {
      type: "explain_hop";
      hop: number;
      judged: Array<{ path: string; part: number; plumbing: number; role: FlowRole; roleConfidence: number; reachedFrom?: string }>;
      expanded: string[];
      next: number;
      latencyMs: number;
      tokens: number;
    }
  /** Explain: a batch of comment / code blocks was judged; `top` = the best explaining blocks in it. */
  | { type: "explain_evidence"; judged: number; kept: number; top: Array<{ path: string; line: number; kind: "comment" | "code"; score: number; text: string }>; latencyMs: number; tokens: number }
  /** Explain: a batch of references between drawn units was judged. */
  | { type: "explain_edges"; judged: number; kept: number; latencyMs: number; tokens: number }
  | { type: "explain_done"; result: ExplainResult }
  | { type: "done"; result: SearchResult }
  | { type: "error"; message: string };

export type ResultRow = {
  path: string;
  /** Final ranking key: verify Noul when verified, else the strategy's own score. */
  score: number;
  verify?: number;
  pick?: number;
  pathScore?: number;
  noul?: number;
  /** Find: its shortlist Noul. */
  shortlist?: number;
  /** Where the candidate came from: the lexical pool, a descent, or the map battery. */
  via: "lexical" | "walk" | "explore" | "map";
};

export type SearchStats = {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  apiMs: number;
  wallMs: number;
  estCostUsd: number;
  model: string;
  /** Explore: how many times a parent was re-decided with dead children excluded. */
  walkUps?: number;
  /** Explore: nodes abandoned (none / under_here / verify / exhausted). */
  dead?: number;
};

export type SearchResult = {
  params: SearchParams;
  results: ResultRow[];
  /** path → 0..1 for every node TypeSafe formed an opinion about. Unlisted = never looked at. */
  heat: Record<string, number>;
  /** Directories expanded (walk/explore) or covered by the battery (map). */
  visited: string[];
  stats: SearchStats;
  /** Walk only: top path score / runner-up path score. */
  separation?: number;
  verdict: "found" | "partial" | "absent";
  /** find: results are candidates for ONE unit; map: results are every unit judged part of the topic (the heat map is the answer). */
  mode: "find" | "map";
  topic?: { name: string; includes: string[]; excludes: string[] };
  /** Map: units that matched the subject's words but were beyond the prefilter cap and never judged. */
  truncated?: number;
};

export type ExplainParams = { question: string; scope: string; depth: number; tests: boolean };

/** What `explain` returns: the chart, plus the heat every judged unit got, for the treemap. */
export type ExplainResult = {
  params: ExplainParams;
  graph: FlowGraph;
  heat: Record<string, number>;
  stats: SearchStats & { members: number; judged: number; blocks: number };
};
