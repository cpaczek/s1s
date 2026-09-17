import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { assessCoverage, buildIndex, explain, find, graphOf, hydrateIndex, map, serializeIndex } from '../src/library.ts';
import { evidenceFor, readText, headLines } from '../src/index/build.ts';
import { pool, parseQuery } from '../src/index/lex.ts';
import { fakeClient, fakeIndex } from './fake.ts';

const texts = { 'src/login.ts': 'import { issueToken } from "./token";\n/** Log in a member. */\nexport function login() { return issueToken(); }', 'src/token.ts': '/** Issue an access token. */\nexport function issueToken() { return "access_token"; }', 'README.md': '# Authentication\nMember login flow.' };
const indexOf = () => fakeIndex(Object.keys(texts), texts);

describe('public injected-client API', () => {
  it('finds and maps files using the supplied client and streams events', async () => {
    const index = indexOf();
    const client = fakeClient({ defaultNoul: 0.9, verify: { 'src/token.ts': 0.99, 'src/login.ts': 0.5 } });
    const events: string[] = [];
    const result = await find(index, client, 'issue token', { onEvent: e => events.push(e.type) });
    expect(result.results[0].path).toBe('src/token.ts');
    expect(result.verdict).toBe('found');
    expect(events[0]).toBe('start');
    expect(events.at(-1)).toBe('done');
    expect((await map(index, client, 'login')).mode).toBe('map');
    expect(client.calls).toBeGreaterThan(0);
  });
  it('explains with real reference edges through the injected client', async () => {
    const client = fakeClient({ defaultNoul: 0.9, byPath: { plumbing: { 'src/login.ts': 0, 'src/token.ts': 0 } } });
    const events: string[] = [];
    const result = await explain(indexOf(), client, 'how does login work', { onEvent: e => events.push(e.type) });
    expect(result.graph.nodes.some(n => n.path === 'src/login.ts')).toBe(true);
    expect(events.at(-1)).toBe('explain_done');
    expect(result.stats.calls).toBeGreaterThan(0);
  });
  it('rejects missing scopes, empty questions and invalid depths before any call', () => {
    const client = fakeClient({});
    expect(() => find(indexOf(), client, 'login', { scope: 'missing' })).toThrow('Unknown repository directory');
    expect(() => map(indexOf(), client, ' ')).toThrow('empty');
    expect(() => explain(indexOf(), client, 'login', { depth: NaN })).toThrow('depth');
    expect(client.calls).toBe(0);
  });
});

describe('portable frozen snapshots', () => {
  it('roundtrips facts, full tree, source evidence, lexical retrieval and references', async () => {
    const index = indexOf();
    const snapshot = serializeIndex(index, { revision: 'abc123', repo: 'example/public' });
    const loaded = hydrateIndex(JSON.parse(JSON.stringify(snapshot)));
    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.revision).toBe('abc123');
    expect(loaded.repo).toBe('example/public');
    expect(loaded.root).toEqual(index.root);
    expect([...loaded.facts]).toEqual([...index.facts]);
    expect(loaded.text('src/login.ts')).toBe(texts['src/login.ts']);
    expect(loaded.text('../.env')).toBeUndefined();
    expect(graphOf(loaded)).toEqual(graphOf(index));
    expect(evidenceFor(loaded, 'src/token.ts', 2)).toEqual(texts['src/token.ts'].split('\n'));
    const client = fakeClient({ defaultNoul: 0.9 });
    expect((await find(loaded, client, 'issue token')).verdict).toBe('found');
  });
  it('reads disk only during the build; a removed repository still supports hydrated evidence', () => {
    const repo = mkdtempSync(join(tmpdir(), 's1s-snapshot-'));
    try {
      execFileSync('git', ['init', '-q', repo]);
      mkdirSync(join(repo, 'src'));
      for (const [path, text] of Object.entries(texts)) writeFileSync(join(repo, path), text);
      writeFileSync(join(repo, 'locale.json'), JSON.stringify(Object.fromEntries(Array.from({ length: 80 }, (_, i) => ['key' + i, 'login token']))));
      symlinkSync('/etc/passwd', join(repo, 'outside.txt'));
      execFileSync('git', ['-C', repo, 'add', '.']);
      const original = buildIndex(repo);
      expect(original.byPath.has('outside.txt')).toBe(false);
      expect(readText(repo, 'outside.txt')).toBeUndefined();
      expect(readText(repo, '../outside.txt')).toBeUndefined();
      expect(headLines(repo, '/etc/passwd', 2)).toEqual([]);
      rmSync(repo, { recursive: true, force: true });
      const loaded = hydrateIndex(serializeIndex(original));
      expect(loaded.text('src/token.ts')).toContain('issueToken');
      expect(graphOf(loaded).out.get('src/login.ts')?.[0].to).toBe('src/token.ts');
      const query = parseQuery(original.lex, 'login token');
      expect(pool(loaded.lex, query)).toEqual(pool(original.lex, query));
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });
  it('hydrates compressed source lazily with identical lexical results', () => {
    const index = indexOf();
    const loaded = hydrateIndex(JSON.parse(JSON.stringify(serializeIndex(index, { compressTexts: true }))));
    expect(loaded.text('src/login.ts')).toBe(texts['src/login.ts']);
    expect(pool(loaded.lex, parseQuery(loaded.lex, 'login token'))).toEqual(pool(index.lex, parseQuery(index.lex, 'login token')));
  });
  it('rejects corrupt binary posting arrays', () => {
    const snapshot = serializeIndex(indexOf());
    snapshot.lex.postDoc = 'AAAA';
    expect(() => hydrateIndex(snapshot)).toThrow('alignment');
  });
  it('rejects unknown snapshot versions and corrupt tree paths', () => {
    expect(() => hydrateIndex({ schemaVersion: 2 })).toThrow('schemaVersion');
    const snapshot = serializeIndex(indexOf());
    snapshot.root.children![0].path = '../escape';
    expect(() => hydrateIndex(snapshot)).toThrow('tree');
  });
  it('rejects text for paths outside the tree and does not alias caller-owned maps', () => {
    const snapshot = serializeIndex(indexOf());
    const loaded = hydrateIndex(snapshot);
    snapshot.texts[0][1] = 'changed after hydration';
    expect(loaded.text(snapshot.texts[0][0])).not.toBe('changed after hydration');
    snapshot.texts.push(['../secret', 'sensitive']);
    expect(() => hydrateIndex(snapshot)).toThrow('entry');
  });
});

describe('bounded coverage audit', () => {
  it('reports examined files, reference frontier and gaps without asserting understanding', () => {
    const report = assessCoverage(indexOf(), { scope: 'src', examinedPaths: ['src/login.ts', 'missing', 'src/login.ts'], maxFrontier: 1 });
    expect(report.semanticCompleteness).toBe('not-established');
    expect(report.files).toEqual({ tracked: 2, textual: 2, examined: 1, unexamined: 1, withoutText: 0 });
    expect(report.frontier).toEqual(['src/token.ts']);
    expect(report.frontierTotal).toBe(1);
    expect(report.ignoredPaths).toEqual(['missing']);
  });
  it('still does not establish completeness when every file has been examined', () => {
    const report = assessCoverage(indexOf(), { examinedPaths: Object.keys(texts), maxFrontier: 0 });
    expect(report.files.unexamined).toBe(0);
    expect(report.semanticCompleteness).toBe('not-established');
    expect(report.frontier).toEqual([]);
    expect(() => assessCoverage(indexOf(), { maxFrontier: Infinity })).toThrow('maxFrontier');
  });
});
