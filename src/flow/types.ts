// The FlowGraph — the contract between `explain` (server/CLI) and the flow renderer (ui/flow.js).
// Everything a reader sees is EXTRACTED from the tree: titles are real identifiers, summaries are the
// authors' own comments, edges are real references. TypeSafe only judges (membership, role, relevance);
// code computes the structure and the order. Nothing here is ever generated text.

/** Roles, in flow order: the index of a role is its stage rank (entrypoints first, stores and third parties last). */
export const FLOW_ROLE_ORDER = ["ui", "client", "entrypoint", "guard", "handler", "service", "config", "persistence", "external", "test"] as const;
export type FlowRole = (typeof FLOW_ROLE_ORDER)[number];

/** A block of real source text that TypeSafe judged to explain or implement the topic. */
export type FlowEvidence = {
  path: string;
  /** 1-based line of the first entry of `lines`. */
  line: number;
  /** Verbatim source lines (width-trimmed). */
  lines: string[];
  /** comment = prose the authors wrote about it; code = the lines that do it. */
  kind: "comment" | "code";
  /** TypeSafe's Noul that this block belongs to the topic. */
  score: number;
};

export type FlowNode = {
  /** `path`, `path#symbol`, `pkg:<name>` (third-party package) or `group:<n>` (collapsed siblings). */
  id: string;
  kind: "file" | "symbol" | "package" | "group";
  path: string;
  symbol?: string;
  /** group only: the node ids folded into it. */
  members?: string[];
  /** What the box is called: the symbol, else the file name (a disambiguating parent folder is added by code when two titles collide). */
  title: string;
  /** One sentence in the authors' own words: the best explaining comment, first sentence, clipped. Absent when the code has none. */
  summary?: string;
  role: FlowRole;
  roleConfidence: number;
  /** Membership Noul: how surely this is a step of the topic. Drives visual weight. */
  part: number;
  /** Cluster id (a workspace package / top-level area). */
  cluster: string;
  /** Found by search rather than reached through a reference. */
  seed: boolean;
  /** A hub or plumbing node: drawn as a leaf, never expanded through. */
  terminal: boolean;
  evidence: FlowEvidence[];
};

export type FlowEdge = {
  from: string;
  to: string;
  /** import/reexport are static references; mention = a comment names the other file; via = joined through hidden hops. */
  kind: "import" | "reexport" | "mention" | "via";
  /** What is handed over — real identifiers (`baseAuthOptions`, `jwt`). May be empty. */
  names: string[];
  /** "path:line" of the reference. */
  at: string;
  /** Edge-relevance Noul: does this reference carry topic work? Drives opacity. */
  carries: number;
  /** via only: the hidden hops, in order. */
  via?: string[];
  /** Points against the flow order (part of a cycle): drawn last, de-emphasised. */
  back?: boolean;
};

export type FlowCluster = { id: string; title: string; nodes: string[] };

export type FlowGraph = {
  /** The request as typed. */
  topic: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
  clusters: FlowCluster[];
  /** Reading order: node ids as a walkthrough should meet them (role rank, then reference depth, then path). */
  order: string[];
  /** What was left out, so a capped chart never reads as complete. */
  dropped: { nodes: number; edges: number; hubs: string[] };
  verdict: "found" | "partial" | "absent";
};
