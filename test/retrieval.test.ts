import { describe, expect, it } from "vitest";
import { metrics, plainBM25, words } from "../bench/retrieval/baselines.ts";
import { safeRelative, selectStable } from "../bench/retrieval/prepare.ts";
import { fakeIndex } from "./fake.ts";
describe("retrieval benchmark",()=>{
 it("counts errors as zero, deduplicates predictions and distinguishes hit from recall",()=>{
  expect(metrics([],['a'])).toMatchObject({hit1:0,recall5:0,mrr10:0});
  expect(metrics(['wrong','a','a'],['a','b'])).toMatchObject({hit1:0,hit5:1,recall5:.5,mrr10:.5});
  expect(metrics(['a','b'],['a','b']).ndcg10).toBe(1);
 });
 it("selects independently of input order using a fixed seed",()=>{
  const a=selectStable(['a','b','c'],x=>x,2,'seed');
  expect(selectStable(['c','a','b'],x=>x,2,'seed')).toEqual(a);
 });
 it("rejects untrusted dataset paths before writing",()=>{
  for(const path of ['../secret','/etc/passwd','.git/config','a/../../bad','a\\b','a/./b']) expect(safeRelative(path)).toBe(false);
  expect(safeRelative('src/main.rs')).toBe(true);
 });
 it("ranks plain source evidence and never needs labels",()=>{
  const index=fakeIndex(['a.ts','b.ts'],{'a.ts':'database connection pooling database','b.ts':'render user interface'});
  expect(plainBM25(index)('database connection',10)[0]).toBe('a.ts');
  expect(words('The function returns database connections')).toEqual(['database','connections']);
 });
});
