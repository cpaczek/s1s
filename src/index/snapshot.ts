import { graphOf, type RepoIndex, type TreeNode } from './build.ts';
import type { LexIndex } from './lex.ts';
import { Buffer } from 'node:buffer';
import { gzipSync, gunzipSync } from 'node:zlib';
import type { FileFacts } from './facts.ts';
import type { CodeGraph, GraphEdge, ExternalUse } from '../graph/build.ts';

/** Versioned JSON transport. Contains repository source; publish only approved repositories. */
export type IndexSnapshot = {
  schemaVersion: 1;
  revision?: string;
  repo: string;
  builtAt: string;
  buildMs: number;
  fileCount: number;
  domain?: RepoIndex['domain'];
  root: TreeNode;
  facts: Array<[string, FileFacts]>;
  texts: Array<[string, string]>;
  textEncoding: 'utf8' | 'gzip-base64';
  lex: { paths: string[]; vocabulary: string[]; start: string; postDoc: string; postTf: string; lengths: string; avg: [number, number, number] };
  graph: {
    files: string[];
    out: Array<[string, GraphEdge[]]>;
    in: Array<[string, GraphEdge[]]>;
    external: Array<[string, ExternalUse[]]>;
    unresolved: CodeGraph['unresolved'];
    buildMs: number;
  };
};

/** Copies a frozen content view, including the already resolved graph; never includes credentials. */
export function serializeIndex(index: RepoIndex, options: { revision?: string; repo?: string; compressTexts?: boolean } = {}): IndexSnapshot {
  const graph = graphOf(index);
  const texts: Array<[string, string]> = [];
  for (const node of index.byPath.values()) {
    if (node.kind !== 'file') continue;
    const text = index.text(node.path);
    if (text !== undefined) texts.push([node.path, options.compressTexts ? gzipSync(text).toString('base64') : text]);
  }
  return structuredClone({
    schemaVersion: 1, revision: options.revision, repo: options.repo ?? index.repo,
    builtAt: index.builtAt, buildMs: index.buildMs, fileCount: index.fileCount,
    domain: index.domain, root: index.root, facts: [...index.facts], texts,
    textEncoding: options.compressTexts ? 'gzip-base64' : 'utf8',
    lex: { paths: index.lex.paths, vocabulary: [...index.lex.vocab.keys()], start: pack(index.lex.start), postDoc: pack(index.lex.postDoc), postTf: pack(index.lex.postTf), lengths: pack(index.lex.lengths), avg: index.lex.avg },
    graph: { ...graph, out: [...graph.out], in: [...graph.in], external: [...graph.external] },
  });
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const validPath = (path: string) => !path.startsWith('/') && !path.includes('\\') && !path.includes('\0') && !path.split('/').some(p => p === '..' || p === '.');

/** Hydrates a trusted build artifact, rejecting incompatible or structurally corrupt snapshots. No disk reads. */
export function hydrateIndex(value: unknown): RepoIndex {
  if (!record(value) || value.schemaVersion !== 1) throw new Error('Unsupported index snapshot schemaVersion');
  const s = value as unknown as IndexSnapshot;
  if (typeof s.repo !== 'string' || typeof s.builtAt !== 'string' || !Number.isFinite(s.buildMs) || !Number.isSafeInteger(s.fileCount) || s.fileCount < 0 || !record(s.graph) || !Array.isArray(s.graph.files) || !Array.isArray(s.graph.unresolved)) throw new Error('Invalid index snapshot metadata');
  const byPath = new Map<string, TreeNode>();
  const visit = (node: TreeNode, parent?: TreeNode) => {
    if (!record(node) || typeof node.path !== 'string' || typeof node.name !== 'string' || !validPath(node.path) || !['dir', 'file'].includes(node.kind) || byPath.has(node.path) || !Number.isFinite(node.size) || !Number.isFinite(node.files)) throw new Error('Invalid index snapshot tree');
    if (parent && node.path !== (parent.path ? parent.path + '/' : '') + node.name) throw new Error('Invalid index snapshot tree path');
    byPath.set(node.path, node);
    if (node.kind === 'dir') {
      if (!Array.isArray(node.children)) throw new Error('Invalid index snapshot children');
      for (const child of node.children) visit(child, node);
    }
  };
  visit(s.root);
  if (s.root.path !== '' || s.root.kind !== 'dir' || [...byPath.values()].filter(n => n.kind === 'file').length !== s.fileCount) throw new Error('Invalid index snapshot file count');
  const entries = <T>(rows: Array<[string, T]>, check: (v: T) => boolean): Map<string, T> => {
    if (!Array.isArray(rows)) throw new Error('Invalid index snapshot entries');
    const result = new Map<string, T>();
    for (const row of rows) {
      if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== 'string' || byPath.get(row[0])?.kind !== 'file' || result.has(row[0]) || !check(row[1])) throw new Error('Invalid index snapshot entry');
      result.set(row[0], row[1]);
    }
    return result;
  };
  if (s.textEncoding !== 'utf8' && s.textEncoding !== 'gzip-base64') throw new Error('Invalid index snapshot textEncoding');
  const texts = entries(s.texts, (v) => typeof v === 'string');
  const facts = entries(s.facts, f => record(f) && ['decls', 'imports', 'calls', 'strings', 'headings', 'keys', 'tables'].every(k => Array.isArray(f[k as keyof FileFacts])));
  const edgeList = (v: GraphEdge[]) => Array.isArray(v) && v.every(e => record(e) && byPath.get(e.from)?.kind === 'file' && byPath.get(e.to)?.kind === 'file' && Array.isArray(e.names) && Number.isSafeInteger(e.line));
  const graph: CodeGraph = { ...s.graph, out: entries(s.graph.out, edgeList), in: entries(s.graph.in, edgeList), external: entries(s.graph.external, Array.isArray) };
  const lex = unpackLex(s.lex, byPath);
  const text = (path: string) => {
    const encoded = texts.get(path);
    return encoded === undefined || s.textEncoding === 'utf8' ? encoded : gunzipSync(Buffer.from(encoded, 'base64'), { maxOutputLength: 2 * 1024 * 1024 }).toString('utf8');
  };
  return { repo: s.repo, builtAt: s.builtAt, buildMs: s.buildMs, fileCount: s.fileCount, domain: s.domain, root: s.root, byPath, facts, lex, graph, text };
}

// Explicit little-endian encoding keeps artifacts portable across build/runtime architectures.
function pack(array: Uint32Array | Uint16Array): string {
  const bytes = Buffer.allocUnsafe(array.length * array.BYTES_PER_ELEMENT);
  for (let i = 0; i < array.length; i++) {
    if (array.BYTES_PER_ELEMENT === 2) bytes.writeUInt16LE(array[i], i * 2);
    else bytes.writeUInt32LE(array[i], i * 4);
  }
  return bytes.toString('base64');
}
function unpack(value: string, width: 2): Uint16Array;
function unpack(value: string, width: 4): Uint32Array;
function unpack(value: string, width: 2 | 4): Uint16Array | Uint32Array {
  if (typeof value !== 'string' || value.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(value) || value.slice(0, -2).includes('=') || (value.endsWith('=') ? false : value.includes('='))) throw new Error('Invalid snapshot lexical encoding');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length % width) throw new Error('Invalid snapshot lexical alignment');
  const array = width === 2 ? new Uint16Array(bytes.length / 2) : new Uint32Array(bytes.length / 4);
  for (let i = 0; i < array.length; i++) array[i] = width === 2 ? bytes.readUInt16LE(i * width) : bytes.readUInt32LE(i * width);
  return array;
}
function unpackLex(s: IndexSnapshot['lex'], byPath: Map<string, TreeNode>): LexIndex {
  if (!record(s) || !Array.isArray(s.paths) || !s.paths.every(p => typeof p === 'string' && byPath.get(p)?.kind === 'file') || !Array.isArray(s.vocabulary) || !s.vocabulary.every(v => typeof v === 'string') || new Set(s.paths).size !== s.paths.length || new Set(s.vocabulary).size !== s.vocabulary.length || !Array.isArray(s.avg) || s.avg.length !== 3 || !s.avg.every(v => Number.isFinite(v) && v >= 0)) throw new Error('Invalid snapshot lexical metadata');
  const lex: LexIndex = { paths: [...s.paths], vocab: new Map(s.vocabulary.map((v, i) => [v, i])), start: unpack(s.start, 4), postDoc: unpack(s.postDoc, 4), postTf: unpack(s.postTf, 2), lengths: unpack(s.lengths, 4), avg: [...s.avg] };
  if (lex.start.length !== lex.vocab.size + 1 || lex.start[0] !== 0 || lex.start.at(-1) !== lex.postDoc.length || lex.postTf.length !== lex.postDoc.length * 3 || lex.lengths.length !== lex.paths.length * 3 || lex.start.some((v, i) => i > 0 && v < lex.start[i - 1]) || lex.postDoc.some(id => id >= lex.paths.length)) throw new Error('Invalid snapshot lexical postings');
  return lex;
}
