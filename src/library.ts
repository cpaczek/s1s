/** System One Search: injected judgment client, repository-derived evidence. */
import type { Client } from './client.ts';
import { filesUnder, graphOf, type RepoIndex } from './index/build.ts';
import { normalizeParams, runSearch } from './nav/search.ts';
import { runExplain } from './flow/run.ts';
import { F } from './questions.ts';
import type { NavEvent, SearchResult, ExplainResult } from './nav/events.ts';

export { buildIndex, graphOf } from './index/build.ts';
export { createClient } from './client.ts';
export { serializeIndex, hydrateIndex } from './index/snapshot.ts';
export type { IndexSnapshot } from './index/snapshot.ts';
export type { Client, ClientOptions, Timed } from './client.ts';
export type { RepoIndex, TreeNode } from './index/build.ts';
export type { FileFacts, ImportFact, Decl } from './index/facts.ts';
export type { NavEvent, SearchResult, ExplainResult } from './nav/events.ts';
export type { FlowGraph, FlowNode, FlowEdge, FlowEvidence } from './flow/types.ts';
export type { CodeGraph, GraphEdge } from './graph/build.ts';

export type SearchOptions = { scope?: string; onEvent?: (event: NavEvent) => void };
const noop = () => {};
function scopeOf(index: RepoIndex, scope = ''): string {
  const value = scope.replace(/^\/+|\/+$/g, '');
  if (index.byPath.get(value)?.kind !== 'dir') throw new Error(`Unknown repository directory: ${scope}`);
  return value;
}
function nonempty(text: string): string {
  if (typeof text !== 'string' || !text.trim()) throw new Error('Question must not be empty');
  return text.trim();
}

export function find(index: RepoIndex, client: Client, query: string, options: SearchOptions = {}): Promise<SearchResult> {
  return runSearch({ index, client, params: normalizeParams({ query: nonempty(query), strategy: 'find', scope: scopeOf(index, options.scope) }), emit: options.onEvent ?? noop });
}
export function map(index: RepoIndex, client: Client, subject: string, options: SearchOptions = {}): Promise<SearchResult> {
  return runSearch({ index, client, params: normalizeParams({ query: nonempty(subject), strategy: 'map', scope: scopeOf(index, options.scope) }), emit: options.onEvent ?? noop });
}
export function explain(index: RepoIndex, client: Client, question: string, options: SearchOptions & { depth?: number; tests?: boolean } = {}): Promise<ExplainResult> {
  const depth = options.depth ?? F.DEPTH;
  if (!Number.isFinite(depth) || depth < 0 || depth > 6) throw new Error('depth must be between 0 and 6');
  return runExplain({ index, client, params: { question: nonempty(question), scope: scopeOf(index, options.scope), depth: Math.floor(depth), tests: options.tests ?? false }, emit: options.onEvent ?? noop });
}

export type CoverageReport = {
  /** This is bounded evidence coverage, never a proof of semantic completeness. */
  semanticCompleteness: 'not-established';
  scope: string;
  files: { tracked: number; textual: number; examined: number; unexamined: number; withoutText: number };
  frontier: string[];
  frontierTotal: number;
  unresolved: Array<{ from: string; spec: string }>;
  unresolvedTotal: number;
  sampleLimit: number;
  ignoredPaths: string[];
};

/** Zero-call audit for a coding harness: what it examined and which reference neighbours remain. */
export function assessCoverage(index: RepoIndex, options: { scope?: string; examinedPaths?: Iterable<string>; maxFrontier?: number } = {}): CoverageReport {
  const scope = scopeOf(index, options.scope);
  const requestedLimit = options.maxFrontier ?? 100;
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 0 || requestedLimit > 1000) throw new Error('maxFrontier must be an integer between 0 and 1000');
  const files = filesUnder(index.byPath.get(scope)!);
  const eligible = new Set(files.map(n => n.path));
  const examined = new Set<string>();
  const ignored = new Set<string>();
  for (const path of options.examinedPaths ?? []) (eligible.has(path) ? examined : ignored).add(path);
  const graph = graphOf(index);
  const frontier = new Set<string>();
  for (const path of examined) {
    for (const edge of [...(graph.out.get(path) ?? []), ...(graph.in.get(path) ?? [])]) {
      const other = edge.from === path ? edge.to : edge.from;
      if (eligible.has(other) && !examined.has(other)) frontier.add(other);
    }
  }
  const unresolved = graph.unresolved.filter(edge => eligible.has(edge.from)).sort((a, b) => a.from.localeCompare(b.from) || a.spec.localeCompare(b.spec));
  const textual = files.filter(n => index.text(n.path) !== undefined).length;
  return { semanticCompleteness: 'not-established', scope, files: { tracked: files.length, textual, examined: examined.size, unexamined: files.length - examined.size, withoutText: files.length - textual }, frontier: [...frontier].sort().slice(0, requestedLimit), frontierTotal: frontier.size, unresolved: unresolved.slice(0, requestedLimit), unresolvedTotal: unresolved.length, sampleLimit: requestedLimit, ignoredPaths: [...ignored].sort().slice(0, requestedLimit) };
}
