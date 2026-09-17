import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { grep } from "../bench/retrieval/baselines.ts";
import { assertReusableImplementations, reusableCorpus, tasksFingerprint, type ReuseEvidence } from "../bench/retrieval/provenance.ts";
import { fakeIndex } from "./fake.ts";

const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture(texts: Record<string, string>, visible: string[]) {
  const directory = mkdtempSync(join(tmpdir(), "s1s-grep-parity-")); temporary.push(directory);
  for (const [path, text] of Object.entries(texts)) writeFileSync(join(directory, path), text);
  const index = fakeIndex(Object.keys(texts), Object.fromEntries(visible.map(path => [path, texts[path]])));
  index.repo = directory;
  return index;
}
describe("grep source visibility", () => {
  it("does not read disk-only source unavailable to the other retrievers", () => {
    const index = fixture({ "handler.py": "needle\n", "manual.rst": "needle\nneedle\nneedle\n" }, ["handler.py"]);
    expect(grep(index, "needle", 10)).toEqual(["handler.py"]);
  });
  it("never falls back to scanning cwd when no indexed bodies exist", () => {
    expect(grep(fixture({ "private.rst": "needle\n" }, []), "needle", 10)).toEqual([]);
  });
  it("searches all available text, including an explicit NUL, and counts a line only once", () => {
    const index = fixture({ "first.py": "needle needle\0\n", "second.py": "needle\nneedle\n" }, ["first.py", "second.py"]);
    expect(grep(index, "needle", 10)).toEqual(["second.py", "first.py"]);
  });
});
describe("result reuse evidence", () => {
  const tasks = [{ id: "q", query: "locate the handler", relevant: ["handler.py"] }];
  const previous: ReuseEvidence = { fingerprintSchema: 1, methodFingerprints: { grep: "current", s1s: "paid-original" }, preparations: [{ corpus: "tiny", contentHash: "source", tasksHash: tasksFingerprint(tasks) }] };
  it("requires measured implementation fingerprints and fails closed for legacy rows", () => {
    expect(() => assertReusableImplementations(previous, { grep: "current" }, ["grep"])).not.toThrow();
    expect(() => assertReusableImplementations({ preparations: previous.preparations }, { grep: "current" }, ["grep"])).toThrow("lack");
    expect(() => assertReusableImplementations(previous, { grep: "new-algorithm" }, ["grep"])).toThrow("different");
    expect(() => assertReusableImplementations(previous, { bm25: "known" }, ["bm25"])).toThrow("absent");
  });
  it("rejects source, query and gold changes independently", () => {
    expect(reusableCorpus(previous, "tiny", "source", tasksFingerprint(tasks))).toBe(true);
    expect(reusableCorpus(previous, "tiny", "new-source", tasksFingerprint(tasks))).toBe(false);
    expect(reusableCorpus(previous, "tiny", "source", tasksFingerprint([{ ...tasks[0], query: "different question" }]))).toBe(false);
    expect(reusableCorpus(previous, "tiny", "source", tasksFingerprint([{ ...tasks[0], relevant: ["corrected.py"] }]))).toBe(false);
    expect(reusableCorpus({ ...previous, preparations: [{ corpus: "tiny", contentHash: "source" }] }, "tiny", "source", tasksFingerprint(tasks))).toBe(false);
  });
});
