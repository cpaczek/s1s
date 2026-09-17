import type { Client, Timed } from "../src/client.ts";
import type { Answer, ChoiceQuestion, Question } from "../src/types.ts";
import type { RepoIndex, TreeNode } from "../src/index/build.ts";
import { extractFacts, factsText, type FileFacts } from "../src/index/facts.ts";
import { buildLex } from "../src/index/lex.ts";

/**
 * Scripted client: `choicePrefs` maps an option name to a raw weight for any
 * Choice; Nouls come from `nouls` keyed by a substring of the instructions;
 * everything else gets a flat default. No network.
 */
export function fakeClient(script: {
  choicePrefs?: Record<string, number>;
  nouls?: Record<string, number>;
  defaultNoul?: number;
  /** Verify Nouls keyed by candidate PATH (read from state.candidates[i].path). */
  verify?: Record<string, number>;
  /**
   * Nouls for any battery over `state.candidates`: question-id prefix → candidate PATH → noul
   * (`shortlist_3` looks up byPath.shortlist[state.candidates[3].path]). `verify` is byPath.match.
   */
  byPath?: Record<string, Record<string, number>>;
  /** Vocabulary Nouls keyed by the WORD (read from state.vocabulary[i]). */
  terms?: Record<string, number>;
}): Client & { calls: number; states: unknown[] } {
  const byPath: Record<string, Record<string, number>> = { ...(script.verify ? { match: script.verify } : {}), ...script.byPath };
  const c = (async (state: unknown, questions: Record<string, Question>): Promise<Timed> => {
    c.calls++;
    c.states.push(state);
    const answers: Record<string, Answer> = {};
    const candidates = (state as { candidates?: Array<{ path: string }> })?.candidates;
    const vocabulary = (state as { vocabulary?: string[] })?.vocabulary;
    for (const [id, q] of Object.entries(questions)) {
      const m = id.match(/^([a-z]+)_(\d+)$/);
      if (m && q.type === "noul" && candidates && byPath[m[1]]) {
        const path = candidates[Number(m[2])]?.path;
        answers[id] = { type: "noul", noul: byPath[m[1]][path] ?? script.defaultNoul ?? 0.05 };
        continue;
      }
      if (m && m[1] === "term" && vocabulary && script.terms) {
        answers[id] = { type: "noul", noul: script.terms[vocabulary[Number(m[2])]] ?? script.defaultNoul ?? 0.05 };
        continue;
      }
      if (q.type === "choice") {
        const keys = Object.keys((q as ChoiceQuestion).criteria);
        const w = keys.map((k) => script.choicePrefs?.[k] ?? 0.01);
        const sum = w.reduce((a, b) => a + b, 0);
        const probabilities = Object.fromEntries(keys.map((k, i) => [k, w[i] / sum]));
        const best = keys.reduce((a, b) => (probabilities[a] >= probabilities[b] ? a : b));
        answers[id] = { type: "choice", choice: best, probabilities, confidence: probabilities[best] };
      } else if (q.type === "noul") {
        const text = JSON.stringify(q.instructions);
        const hit = Object.entries(script.nouls ?? {}).find(([k]) => text.includes(k));
        answers[id] = { type: "noul", noul: hit ? hit[1] : (script.defaultNoul ?? 0.05) };
      } else {
        answers[id] = { type: "score", score: 0, legend: {}, probabilities: {}, confidence: 0 };
      }
    }
    return { model: "fake", answers, usage: { input_tokens: 100, output_tokens: 10 }, latencyMs: 1 };
  }) as Client & { calls: number; states: unknown[] };
  c.calls = 0;
  c.states = [];
  return c;
}

/** Build a tiny in-memory RepoIndex from a list of paths (sizes = path length); `texts` gives some of them a body, which is read for facts (imports, comments …) like a real file. */
export function fakeIndex(paths: string[], texts: Record<string, string> = {}): RepoIndex {
  const root: TreeNode = { name: "", path: "", kind: "dir", size: 0, files: 0, children: [] };
  const byPath = new Map<string, TreeNode>([["", root]]);
  for (const rel of paths) {
    const parts = rel.split("/");
    let dir = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts.slice(0, i + 1).join("/");
      let next = byPath.get(p);
      if (!next) {
        next = { name: parts[i], path: p, kind: "dir", size: 0, files: 0, children: [] };
        byPath.set(p, next);
        dir.children!.push(next);
      }
      dir = next;
    }
    const name = parts[parts.length - 1];
    const node: TreeNode = { name, path: rel, kind: "file", size: rel.length, files: 1, ext: name.split(".").pop() };
    byPath.set(rel, node);
    dir.children!.push(node);
  }
  const fin = (n: TreeNode) => {
    if (n.kind !== "dir") return;
    n.size = 0; n.files = 0;
    for (const c of n.children!) { fin(c); n.size += c.size; n.files += c.files; }
  };
  fin(root);
  const facts = new Map<string, FileFacts>();
  for (const [path, text] of Object.entries(texts)) facts.set(path, extractFacts(text, path.split(".").pop() ?? ""));
  const lex = buildLex(paths.map((path) => ({ path, sig: facts.has(path) ? factsText(facts.get(path)!) : "", body: texts[path] ?? "" })));
  return { repo: "/nonexistent", builtAt: "", buildMs: 0, fileCount: paths.length, root, byPath, lex, facts, text: (path) => texts[path] };
}
