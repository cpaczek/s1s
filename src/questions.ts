// ============================================================================
// AUDIT SURFACE — every question TypeSafe is asked, every rubric, every
// threshold. Tune behaviour here; nothing elsewhere should carry question text.
// ============================================================================
import type { ChoiceQuestion, NoulQuestion, Structured } from "./types.ts";
import type { TreeNode } from "./index/build.ts";
import { fillDescriptor } from "./index/signature.ts";

export const T = {
  /** Verify Noul at/above this → "found"; below PARTIAL → "absent" (line-by-line cookbook cutoffs). */
  FOUND: 0.7,
  PARTIAL: 0.35,
  /** Walk: drop a directory's whole branch when "target under here" falls below this. */
  UNDER_HERE_PRUNE: 0.1,
  /** Walk: beam width (hierarchical-classification cookbook: K=3 recovered every greedy miss). */
  BEAM: 3,
  MAX_DEPTH: 12,
  /** Map: result rows returned (the heat map itself is unbounded). */
  MAP_RESULTS: 80,
  /** How many candidate files go into the final verification call (one call, N Nouls + 1 Choice). */
  VERIFY_TOP: 8,
  /** Lines of each candidate's head shown at verification when there is no query to aim the evidence with. */
  HEAD_LINES: 25,
  /** Query-aware evidence: head lines, then windows of ±RADIUS lines around the lines matching the rarest query words. */
  EVIDENCE_HEAD: 8,
  EVIDENCE_WINDOWS: 3,
  EVIDENCE_RADIUS: 2,
  /** Find: the lexical pool is the all-field top LEX_ALL ∪ path-only top LEX_PATH (∪ path+facts top LEX_SIG, off: measured 2026-09-16 — 32/10/0 recalls 20/20 easy, 27/31 hidden at ~40 candidates). */
  LEX_ALL: 32,
  LEX_PATH: 10,
  LEX_SIG: 0,
  /** Find: a tree (or scope) with at most this many units is shortlisted whole — no pool needed. */
  SHORTLIST_ALL_UNDER: 250,
  /** Find: shortlist Nouls per call. */
  SHORTLIST_BATCH: 60,
  /** Find: verify the best SHORTLIST_KEEP by shortlist Noul plus the best LEX_KEEP lexical hits not among them. */
  SHORTLIST_KEEP: 6,
  LEX_KEEP: 2,
  /** Find: when the verdict is not found, walk from the scope root AND from these lexical anchors; its best finishers join the next verify. */
  WALK_KEEP: 3,
  /** Child names previewed inside a directory option (the "subtree as option value" guidance). */
  PREVIEW_CHILDREN: 12,
  EXPORTS_MAX: 8,
  /** Explore: parallel expansions/verifications per step. */
  EXPLORE_WIDTH: 3,
  /** Explore: total TypeSafe calls before giving up. */
  EXPLORE_MAX_CALLS: 60,
  /** Explore: after a leaf verifies ≥ FOUND, keep searching this many more steps before the comparative endgame. */
  EXPLORE_CONFIRM_STEPS: 2,
  /** Explore: a directory is dead when `__none__` takes at least this much of its Choice. */
  NONE_DEAD: 0.5,
  /** Explore: re-decide a parent only when the dead child had been a real pick (edge p ≥ this). */
  WALK_UP_MIN_P: 0.2,
  /** Explore: how many times one parent may be re-decided. */
  WALK_UPS_PER_DIR: 2,
  /** Explore: a branch with this many dead real picks inside it (and nothing partial) is exhausted → its parent is re-decided without it. */
  DEAD_PICKS_TO_EXHAUST: 3,
  /** Explore: every dead real pick multiplies its ancestors' ranking score by this, so the frontier drifts away from a failing branch. */
  DEAD_DECAY: 0.85,
} as const;

export const NONE = "__none__";

/** The nouns the questions use. One vocabulary today (code); a tree of something else would swap these. */
export type Domain = {
  /** Leaf noun. */
  unit: string;
  /** Branch noun. */
  container: string;
  /** What the whole tree is. */
  world: string;
  /** How the leaf noun pluralises in a count field. */
  units: string;
};

export const REPO_DOMAIN: Domain = { unit: "file", container: "directory", world: "source-code repository", units: "files" };

/** $0.042 per 1M INPUT tokens; output tokens are free (per Cameron, 2026-09-16). */
export const USD_PER_M_INPUT_TOKENS = 0.042;

// ---- Walk: one Choice over a directory's children + one absence Noul ----------

export function walkState(query: Structured, dirPath: string, entries: string[], themes: string[] = []): Structured {
  const s: { [k: string]: Structured } = {
    query,
    directory: dirPath === "" ? "(root)" : dirPath + "/",
    entries,
  };
  if (themes.length) s.themes_of_names_beneath = themes;
  return s;
}

/**
 * What TypeSafe is shown about one node. A unit with a content signature spends `budgetTokens` on
 * it in tiers (about + exports, then imports / headings / keys / tables, then rarest calls and
 * strings — see signature.ts); without one (a binary, an unreadable file) it is name-level facts only.
 */
export function describeOption(node: TreeNode, domain: Domain = REPO_DOMAIN, budgetTokens?: number): Structured {
  if (node.kind === "dir") {
    const kids = node.children ?? [];
    const contains = kids.slice(0, T.PREVIEW_CHILDREN).map((c) => (c.kind === "dir" ? c.name + "/" : c.name));
    const more = kids.length - contains.length;
    const d: { [k: string]: Structured } = { kind: domain.container, [domain.units]: node.files, contains };
    if (more > 0) d.and_more = more;
    if (node.themes?.length) d.themes = node.themes;
    if (node.hint) d.about = node.hint;
    return d;
  }
  const d: { [k: string]: Structured } = { kind: domain.unit };
  if (node.ext) d.ext = node.ext;
  if (node.lines !== undefined) d.lines = node.lines;
  if (node.signature) return fillDescriptor(d, node.signature, budgetTokens) as Structured;
  if (node.exports?.length) d.exports = node.exports.slice(0, T.EXPORTS_MAX);
  if (node.hint) d.about = node.hint;
  return d;
}

export function walkQuestions(options: Record<string, Structured>, domain: Domain = REPO_DOMAIN): { pick: ChoiceQuestion; under_here: NoulQuestion } {
  const { unit, container, world } = domain;
  return {
    pick: {
      type: "choice",
      instructions: {
        question: `Which entry is, or leads to, the ${unit} that \`query\` refers to?`,
        context: `The options are the direct children of \`directory\` in a ${world}. A ${container} is the right pick when the target lives somewhere beneath it; a ${unit} is the right pick when it is the target itself.`,
      },
      criteria: { ...options, [NONE]: { what: `The target is not under any of these entries` } },
    },
    under_here: {
      type: "noul",
      instructions: `Is the ${unit} that \`query\` refers to located somewhere under \`directory\`?`,
      criteria: {
        true: `A ${unit} matching \`query\` exists beneath this ${container}, at any depth`,
        false: `Nothing under this ${container} matches; the target lives elsewhere in the ${world}`,
      },
    },
  };
}

// ---- Topic: a subject spread over many units. Lives in STATE, never in a question. ----

/** `includes` = words the tree itself uses for the subject (accepted by the vocabulary question); `excludes` = near-neighbours that do not count. */
export type Topic = { name: string; includes: string[]; excludes: string[]; /** The request as typed, when `name` is the subject distilled from it. */ question?: string };

export function topicFromQuery(query: string): Topic {
  return { name: query, includes: [], excludes: [] };
}

/** Words that shape a question without naming its subject: "how does X work" → X. */
const QUESTION_WORDS = new Set(
  "how does do did is are was were what where which when why who explain describe show tell me the a an our your this that these those it its we you they i in of for to on at by from with about get gets got handled handle handles done work works working worked function functions functioning happen happens happened implemented implement implements implementation flow flows process processes codebase code system app application repo repository project here actually exactly really currently".split(" "),
);

/** The subject a question is about — the words left once the question's scaffolding is removed (the question itself is kept for the state). */
export function topicFromQuestion(question: string): Topic {
  const words = question.replace(/[?!.]+$/g, "").split(/\s+/).filter((w) => w && !QUESTION_WORDS.has(w.toLowerCase().replace(/[^a-z0-9'-]/g, "")));
  const name = words.join(" ").trim();
  return name && name !== question.trim() ? { name, includes: [], excludes: [], question: question.trim() } : topicFromQuery(question.trim());
}

// ---- Candidates: the ONE state shape for every battery over units --------------
// The question text never carries data: it points at `candidates[i]`, and the unit's
// path and content-derived descriptor sit in the state.

export function candidatesState(subject: { [k: string]: Structured }, candidates: Structured[]): Structured {
  return { ...subject, candidates };
}

/** Find: one Noul per lexical candidate, judged on its descriptor (path, imports, exports, about …). */
export function shortlistQuestion(i: number, domain: Domain = REPO_DOMAIN): NoulQuestion {
  const { unit } = domain;
  return {
    type: "noul",
    instructions: `Is \`candidates[${i}]\` the ${unit} that \`query\` asks for?`,
    criteria: {
      true: `What \`query\` asks about is decided, implemented or configured in this ${unit}; its path, imports, exports or description show that`,
      false: `This ${unit} is unrelated, only uses the outcome, or merely shares a word with \`query\``,
    },
  };
}

/** Map / explain: is this unit one of the places the subject lives? (`topic` and `topic_includes` are in the state.) */
export function memberQuestion(i: number, domain: Domain = REPO_DOMAIN): NoulQuestion {
  const { unit } = domain;
  return {
    type: "noul",
    instructions: `Is \`candidates[${i}]\` one of the places where \`topic\` is implemented, configured, or directly used?`,
    criteria: {
      true: `This ${unit} is part of \`topic\`: it implements, configures, wires, or directly exercises it (see \`topic_includes\`)`,
      false: `This ${unit} is unrelated to \`topic\`, or only touches it in passing`,
    },
  };
}

// ---- Vocabulary: which of the tree's OWN words belong to the subject? ---------
// Closes the gap between how a person asks ("authentication", "flashcards") and what the
// tree calls it ("oauth", "session", "fsrs") without a generative step: code proposes words
// that really occur in the tree, TypeSafe judges each one, accepted words join the lexical query.

export function termsState(subject: string, vocabulary: string[]): Structured {
  return { subject, vocabulary };
}

export function termQuestion(i: number): NoulQuestion {
  return {
    type: "noul",
    instructions: `Is \`vocabulary[${i}]\` a word for the thing that \`subject\` asks about?`,
    criteria: {
      true: `A name, synonym, abbreviation or component of that thing, or a technology built for it`,
      false: `A general programming or project word, or a word about a different thing`,
    },
  };
}

// ---- Explain: a subject → the flow of units that make it happen ---------------
// Code proposes (graph neighbours, comment and code blocks, real references); TypeSafe judges
// (is it a step, is it plumbing, which role, does this block explain it, does this edge carry it);
// code composes the chart. Nothing a reader sees is generated: titles are identifiers, summaries
// are the authors' comments, edges are references.

export const F = {
  /** Vocabulary words offered per explain / find expansion, and the Noul a word needs to join the query. */
  TERMS_OFFERED: 160,
  TERM_MIN: 0.6,
  /** Lexical weight of an accepted word relative to a word the person typed. */
  TERM_WEIGHT: 0.5,
  /** Units the lexical prefilter hands to the membership battery, and the battery's size per call. */
  MEMBER_PREFILTER: 320,
  MEMBER_BATCH: 80,
  /** Drawn when membership ≥ MEMBER; a starting point (and expanded through) when ≥ EXPAND. */
  MEMBER: 0.5,
  EXPAND: 0.7,
  SEED_MAX: 20,
  SEEDS_PER_CLUSTER: 6,
  /** Never expanded through: a hub — more importers than the tree's own HUB_PERCENTILE of fan-in (never below HUB_FAN_IN_MIN) — or judged plumbing (TypeSafe). */
  HUB_PERCENTILE: 0.98,
  HUB_FAN_IN_MIN: 10,
  PLUMBING: 0.6,
  /** A hub still appears as a leaf when this many drawn units reference it and it stores data or is third-party. */
  HUB_KEEP_REFS: 3,
  DEPTH: 3,
  /** Neighbours judged per unit per direction, and candidates per call (each costs 2 Nouls + a 10-option Choice). */
  FAN_OUT_CAP: 40,
  CANDIDATES_PER_CALL: 40,
  MAX_CALLS: 40,
  /** Blocks (comments, code windows) judged per unit, per call, and kept as evidence. */
  BLOCKS_PER_UNIT: 16,
  BLOCKS_PER_CALL: 96,
  BLOCK_LINES: 9,
  /** A block is evidence at/above this; the per-unit Choice's winner is the summary when its Noul reaches SUMMARY_MIN. */
  BLOCK_MIN: 0.7,
  SUMMARY_MIN: 0.5,
  EVIDENCE_PER_UNIT: 3,
  /** An edge is drawn when the reference carries the subject — or when it is a unit's last edge. */
  EDGE_MIN: 0.35,
  EDGES_PER_CALL: 100,
  NODE_CAP: 36,
  EDGE_CAP: 64,
  SUMMARY_CHARS: 150,
  LINE_WIDTH: 140,
  /** Below this the role is reported but never used to turn an arrow around. */
  ROLE_MIN_CONFIDENCE: 0.4,
} as const;

/** Role rubric. The keys are the Choice options AND the FlowGraph vocabulary (`FLOW_ROLE_ORDER` fixes their stage order). */
export const FLOW_ROLES = {
  ui: "A page, screen or visual component a person interacts with",
  client: "App-side code that calls a backend: an API or SDK client instance, a data-fetching hook",
  entrypoint: "Where a process or a request begins: a server bootstrap that mounts routes, a CLI main, a route table, a job or webhook registration",
  guard: "A check that runs before the real work and can refuse or redirect: middleware, a proxy, a permission or token verifier, a procedure wrapper",
  handler: "Receives one request or event and answers it: a route, controller, RPC procedure, webhook or tool handler",
  service: "Domain logic that handlers or hooks call: rules, policies, computations, side effects",
  config: "Constants, options, environment values, URLs or feature flags that parameterise the other parts",
  persistence: "Reads or writes stored data: a database client, query module, repository, schema, migration or cache",
  external: "A third-party package or remote system the code hands work to",
  test: "A test, fixture, mock, script or example that exercises the code without running in production",
} as const;

export function topicState(topic: Topic): { [k: string]: Structured } {
  const s: { [k: string]: Structured } = { topic: topic.name };
  if (topic.question) s.question = topic.question;
  if (topic.includes.length) s.topic_includes = topic.includes;
  if (topic.excludes.length) s.topic_excludes = topic.excludes;
  return s;
}

/** What TypeSafe is shown about a unit the expansion reached. */
export type FlowCandidate = {
  path: string;
  descriptor: Structured;
  /** The ONE real reference through which the search reached it: who, in which direction, and the source line. */
  reached?: { from: string; relation: "imports" | "imported_by"; at: string; line: string; names: string[] };
};

export function flowState(topic: Topic, candidates: FlowCandidate[], accepted: string[]): Structured {
  const s = topicState(topic);
  if (accepted.length) s.already_in_flow = accepted;
  s.candidates = candidates.map((c) => {
    const d: { [k: string]: Structured } = { path: c.path, ...(c.descriptor as { [k: string]: Structured }) };
    if (c.reached) d.reached = c.reached;
    return d;
  });
  return s;
}

/** Per candidate, one round trip: is it a step (`part`), is it plumbing, which role. */
export function flowQuestions(n: number): Record<string, NoulQuestion | ChoiceQuestion> {
  const qs: Record<string, NoulQuestion | ChoiceQuestion> = {};
  for (let i = 0; i < n; i++) {
    qs[`part_${i}`] = {
      type: "noul",
      instructions: `Is \`candidates[${i}]\` one of the steps by which \`topic\` happens when the software runs?`,
      criteria: {
        true: `It performs, configures, guards or stores something \`topic\` needs; its path, imports, exports, description or \`reached\` line shows that`,
        false: `It only consumes the outcome of \`topic\` for another feature, or is unrelated`,
      },
    };
    qs[`plumbing_${i}`] = {
      type: "noul",
      instructions: `Is \`candidates[${i}]\` general-purpose plumbing that unrelated features rely on just as much?`,
      criteria: {
        true: `A shared utility: logger, database client, environment loader, UI-kit component, type barrel, framework glue`,
        false: `Written for one subject; most of what it does is specific to it`,
      },
    };
    qs[`role_${i}`] = { type: "choice", instructions: `Which role does \`candidates[${i}]\` play in the software?`, criteria: FLOW_ROLES };
  }
  return qs;
}

/** A comment or a few code lines from a unit in the flow — the line-by-line search for what explains the subject. */
export type FlowBlock = { path: string; line: number; kind: "comment" | "code"; text: string[] };

export function blockState(topic: Topic, blocks: FlowBlock[]): Structured {
  return { ...topicState(topic), blocks: blocks.map((b) => ({ path: b.path, line: b.line, kind: b.kind, text: b.text })) };
}

export function blockQuestion(i: number, kind: FlowBlock["kind"]): NoulQuestion {
  return kind === "comment"
    ? {
        type: "noul",
        instructions: `Does the comment in \`blocks[${i}]\` explain how \`topic\` works?`,
        criteria: {
          true: `It says what happens, why, or in which order, for \`topic\` or one of its parts`,
          false: `It is about something else, or explains nothing (a todo, a pragma, a licence, a divider, commented-out code)`,
        },
      }
    : {
        type: "noul",
        instructions: `Do the lines in \`blocks[${i}]\` carry out a step of \`topic\`?`,
        criteria: {
          true: `They perform, configure, check or store something \`topic\` needs`,
          false: `They do something else, or only import, log or pass values along`,
        },
      };
}

/**
 * Per unit, one Choice over its comment blocks: which one says best what the unit does for the
 * subject? A Choice ranks (the Nouls alone cannot tell the header comment from a detail), the
 * winner's Noul says whether it is worth showing at all. Options point at `blocks[i]`.
 */
export function bestBlockQuestion(blockIndexes: number[]): ChoiceQuestion {
  const criteria: Record<string, Structured> = {};
  for (const i of blockIndexes) criteria[`b${i}`] = { see: `blocks[${i}]` };
  criteria[NONE] = { what: `None of them says what this unit does for \`topic\`` };
  return {
    type: "choice",
    instructions: `Which of these comments, all from one unit, best says what that unit does for \`topic\`?`,
    criteria,
  };
}

/** A real reference between two drawn units, with the lines that show how `to` is used. */
export type FlowEdgeEvidence = { from: string; to: string; names: string[]; at: string; lines: string[] };

export function edgeState(topic: Topic, edges: FlowEdgeEvidence[]): Structured {
  return { ...topicState(topic), edges: edges.map((e) => ({ from: e.from, to: e.to, names: e.names, at: e.at, lines: e.lines })) };
}

export function edgeQuestion(j: number): NoulQuestion {
  return {
    type: "noul",
    instructions: `Does the reference in \`edges[${j}]\` hand \`topic\` work from its \`from\` to its \`to\`?`,
    criteria: {
      true: `The shown \`lines\` use \`to\` for something \`topic\` needs: they mount it, call it, wrap it, read its result or pass it on`,
      false: `The shown \`lines\` use \`to\` for something else, such as logging, styling, analytics or types`,
    },
  };
}

// ---- Verify: N candidate Nouls + one Choice, single call ----------------------

export type Candidate = {
  path: string;
  ext?: string;
  lines?: number;
  exports?: string[];
  hint?: string;
  /** Evidence lines: the file's head, or windows aimed at the query. */
  head: string[];
};

export function verifyState(query: Structured, candidates: Candidate[]): Structured {
  return {
    query,
    candidates: candidates.map((c) => {
      const d: { [k: string]: Structured } = { path: c.path };
      if (c.ext) d.ext = c.ext;
      if (c.lines !== undefined) d.lines = c.lines;
      if (c.exports?.length) d.exports = c.exports;
      if (c.hint) d.about = c.hint;
      d.head = c.head;
      return d;
    }),
  };
}

export function verifyQuestions(candidates: Candidate[], domain: Domain = REPO_DOMAIN): Record<string, NoulQuestion | ChoiceQuestion> {
  const { unit } = domain;
  const qs: Record<string, NoulQuestion | ChoiceQuestion> = {};
  candidates.forEach((c, i) => {
    qs[`match_${i}`] = {
      type: "noul",
      instructions: `Is \`candidates[${i}]\` the ${unit} that \`query\` refers to?`,
      criteria: {
        true: `This ${unit} is what \`query\` refers to; its path and its head/about text confirm it`,
        false: `This ${unit} is not the target; at most it is related by topic`,
      },
    };
  });
  const criteria: Record<string, Structured> = {};
  candidates.forEach((c, i) => {
    criteria[c.path] = { see: `candidates[${i}]` };
  });
  criteria[NONE] = { what: `None of the candidates is the ${unit} referred to` };
  qs.best = {
    type: "choice",
    instructions: `Which candidate is the ${unit} that \`query\` refers to?`,
    criteria,
  };
  return qs;
}
