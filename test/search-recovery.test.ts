import { describe, expect, it } from "vitest";
import { TypeSafeHttpError, TypeSafeTimeoutError, type Client } from "../src/client.ts";
import { runSearch, normalizeParams } from "../src/nav/search.ts";
import { askChildren, newTally, walk } from "../src/nav/walk.ts";
import type { NavEvent } from "../src/nav/events.ts";
import { fakeClient, fakeIndex } from "./fake.ts";

const target = "needle.ts";
const index = fakeIndex([target], { [target]: "export function needle() {}" });
const params = normalizeParams({ query: "needle" });
const noop = () => {};
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function failingFallback(error: unknown): Client {
  const fake = fakeClient({ verify: { [target]: 0.61 } });
  return async (state, questions) => {
    if (questions.pick) throw error;
    return fake(state, questions);
  };
}

describe("optional find expansion recovery", () => {
  it("keeps completed evidence and an honest partial verdict when the optional walk times out", async () => {
    const events: NavEvent[] = [];
    const result = await runSearch({ client: failingFallback(new TypeSafeTimeoutError()), index, params, emit: (e) => events.push(e) });
    expect(result.verdict).toBe("partial");
    expect(result.results[0]).toMatchObject({ path: target, verify: 0.61 });
    expect(result.warnings).toEqual([{ code: "expansion_timeout", stage: "walk", message: expect.stringContaining("additional candidates may be missing") }]);
    expect(events.at(-2)).toEqual({ type: "warning", warning: result.warnings![0] });
    expect(events.at(-1)).toEqual({ type: "done", result });
  });

  it("retains the first verified set if optional verification fails after a successful walk", async () => {
    const other = "other.ts";
    const paths = [target, other, ...Array.from({ length: 251 }, (_, i) => `filler${i}.ts`)];
    const large = fakeIndex(paths, { [target]: "function needle() {}" });
    const fake = fakeClient({ verify: { [target]: 0.61 }, choicePrefs: { [other]: 10 }, defaultNoul: 0.1 });
    let verifies = 0;
    const client: Client = async (state, questions) => {
      if (questions.best && ++verifies > 1) throw new TypeSafeHttpError(503);
      return fake(state, questions);
    };
    const result = await runSearch({ client, index: large, params, emit: noop });
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ path: target, verify: 0.61 });
    expect(result.warnings?.[0]).toMatchObject({ code: "expansion_unavailable", stage: "verify" });
    expect(result.verdict).toBe("partial");
  });

  it.each([
    new DOMException("Canceled by caller", "AbortError"),
    new DOMException("Caller deadline", "TimeoutError"),
    new TypeSafeHttpError(401),
    new TypeSafeHttpError(403),
    new Error("TypeSafe returned an invalid response shape"),
    new TypeError("Programming mistake"),
  ])("does not convert cancellation, authentication or unknown failures into degraded success: %s", async (error) => {
    const events: NavEvent[] = [];
    await expect(runSearch({ client: failingFallback(error), index, params, emit: (e) => events.push(e) })).rejects.toBe(error);
    expect(events.some((e) => e.type === "done" || e.type === "warning")).toBe(false);
  });

  it.each(["shortlist", "verify"])("keeps a %s timeout fatal before the initial evidence set is complete", async (stage) => {
    const fake = fakeClient({});
    const error = new TypeSafeTimeoutError();
    const client: Client = async (state, questions) => {
      if (stage === "shortlist" ? !!questions.shortlist_0 : !!questions.best) throw error;
      return fake(state, questions);
    };
    const events: NavEvent[] = [];
    await expect(runSearch({ client, index, params, emit: (e) => events.push(e) })).rejects.toBe(error);
    expect(events.some((e) => e.type === "warning" || e.type === "done")).toBe(false);
  });

  it("keeps walk failure fatal when lexical retrieval produced no evidence at all", async () => {
    const large = fakeIndex(Array.from({ length: 251 }, (_, i) => `file${i}.ts`));
    const error = new TypeSafeTimeoutError();
    await expect(runSearch({ client: failingFallback(error), index: large, params, emit: noop })).rejects.toBe(error);
  });

  it("does not return degraded completion until every parallel walk chunk has settled", async () => {
    const paths = [target, ...Array.from({ length: 259 }, (_, i) => `filler${i}.ts`)];
    const large = fakeIndex(paths, { [target]: "function needle() {}" });
    const fake = fakeClient({ verify: { [target]: 0.61 } });
    const held = deferred<void>();
    const entered = deferred<void>();
    let active = 0;
    let completed = false;
    const client: Client = async (state, questions) => {
      if (!questions.pick) return fake(state, questions);
      active++;
      try {
        if (questions.pick.type === "choice" && Object.hasOwn(questions.pick.criteria, target)) throw new TypeSafeTimeoutError();
        entered.resolve();
        await held.promise;
        return await fake(state, questions);
      } finally { active--; }
    };
    const pending = runSearch({ client, index: large, params, emit: noop }).then((result) => { completed = true; return result; });
    await entered.promise;
    expect(active).toBe(1);
    expect(completed).toBe(false);
    held.resolve();
    const result = await pending;
    expect(active).toBe(0);
    expect(result.warnings?.[0].code).toBe("expansion_timeout");
    // Successful sibling usage remains observable even though its chunk group failed.
    expect(result.stats.calls).toBe(3);
  });

  it("drains concurrent beam expansions and preserves a sibling caller abort", async () => {
    const tree = fakeIndex(["left/a.ts", "right/b.ts"]);
    const held = deferred<never>();
    const entered = deferred<void>();
    const abort = new DOMException("Caller canceled", "AbortError");
    let settled = false;
    const client: Client = async (state) => {
      if ((state as { directory: string }).directory === "(root)") throw new TypeSafeTimeoutError();
      entered.resolve();
      return held.promise;
    };
    const pending = walk({ client, index: tree, query: "q", scope: "", seeds: ["left"], beam: 3, maxDepth: 2, emit: noop, tally: newTally() })
      .catch((error: unknown) => { settled = true; return error; });
    await entered.promise;
    expect(settled).toBe(false);
    held.reject(abort);
    expect(await pending).toBe(abort);
  });

  it("a fatal error from another walk chunk takes precedence over a recoverable timeout", async () => {
    const paths = Array.from({ length: 255 }, (_, i) => `file${i}.ts`);
    const large = fakeIndex(paths);
    const fatal = new TypeSafeHttpError(401);
    const client: Client = async (_state, questions) => {
      if (questions.pick.type === "choice" && Object.hasOwn(questions.pick.criteria, "file0.ts")) throw new TypeSafeTimeoutError();
      throw fatal;
    };
    await expect(askChildren(client, "q", large.root, large.root.children!, newTally())).rejects.toBe(fatal);
  });
});
