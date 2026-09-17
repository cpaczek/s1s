import { describe, expect, it } from "vitest";
import { admit, answerIdentity, assertParams, boundedFetch, initialState, LIMITS, normalizedQuestion, prune, release, safePath } from "../demo/protection.ts";

describe("demo admission accounting", () => {
  it("reserves a global paid budget before running and bounds the FIFO queue", () => {
    const state = initialState(0);
    expect(admit(state, "ip0", "q0", "0", 0).status).toBe("active");
    for (let i = 1; i <= LIMITS.queue; i++) expect(admit(state, `ip${i}`, `q${i}`, `${i}`, 0).status).toBe("queued");
    expect(admit(state, "excess", "excess", "excess", 0).status).toBe("rejected");
    expect(state.tokens).toBe(LIMITS.requestTokens * (LIMITS.queue + LIMITS.concurrency));
    release(state, "0", 1000);
    expect(state.leases.filter((lease) => lease.status === "active").map((lease) => lease.id)).toEqual(["1"]);
  });
  it("retains reservations and leases through a simulated eviction/restart", () => {
    const state = initialState(0);
    admit(state, "ip", "q", "lease", 0);
    const restarted = JSON.parse(JSON.stringify(state));
    expect(admit(restarted, "other", "same", "next", 1).status).toBe("queued");
    expect(restarted.tokens).toBe(2 * LIMITS.requestTokens);
    release(restarted, "lease", 2);
    expect(restarted.tokens).toBe(2 * LIMITS.requestTokens); // crashes and failures never refund unknown spend
  });
  it("prevents concurrent duplicate questions and more than one lease per IP", () => {
    const state = initialState(0);
    admit(state, "ip", "q", "lease", 0);
    expect(admit(state, "other", "q", "duplicate", 0).status).toBe("rejected");
    expect(admit(state, "ip", "other", "another", 0).status).toBe("rejected");
    expect(state.tokens).toBe(LIMITS.requestTokens);
  });
  it("limits cache hits per IP but does not charge their paid budget", () => {
    const state = initialState(0);
    for (let i = 0; i < LIMITS.ipMinute; i++) expect(admit(state, "ip", "q", "id", 0, "answer")).toEqual({ status: "cached", body: "answer" });
    expect(admit(state, "ip", "q", "id", 0, "answer").status).toBe("rejected");
    expect(state.tokens).toBe(0);
    expect(admit(state, "ip", "q", "id", 60_000, "answer").status).toBe("cached");
  });
  it("enforces per-IP and global daily reservations across minute windows", () => {
    const state = initialState(0);
    for (let i = 0; i < LIMITS.ipDayTokens / LIMITS.requestTokens; i++) {
      expect(admit(state, "ip", `q${i}`, "id", i * 60_000).status).toBe("active");
      release(state, "id", i * 60_000);
    }
    expect(admit(state, "ip", "next", "id", 600_000).status).toBe("rejected");
    expect(admit(state, "ip", "old", "id", 600_000, "cached").status).toBe("cached");
    state.tokens = LIMITS.globalDayTokens;
    expect(admit(state, "fresh-ip", "new", "id", 600_000).status).toBe("rejected");
    expect(admit(state, "fresh-ip", "new", "id", 86_400_000).status).toBe("active");
  });
  it("expires abandoned queues and only releases active leases after their longer deadline", () => {
    const state = initialState(0);
    admit(state, "a", "a", "a", 0); admit(state, "b", "b", "b", 0);
    prune(state, LIMITS.queueMs + 1);
    expect(state.leases.map((lease) => lease.id)).toEqual(["a"]);
    prune(state, LIMITS.leaseMs + 1);
    expect(state.leases).toEqual([]);
    expect(state.tokens).toBe(2 * LIMITS.requestTokens);
  });
  it("does not drop live leases at midnight and bounds retained identities", () => {
    const state = initialState(86_399_000);
    admit(state, "old", "q", "id", 86_399_000);
    prune(state, 86_400_001);
    expect(state.leases[0].id).toBe("id");
    expect(state.identities).toEqual({});
    for (let i = 0; i < LIMITS.maxIdentities; i++) state.identities[`ip${i}`] = { dayTokens: 0, minute: state.minute, count: 0 };
    expect(admit(state, "another", "q", "new", 86_400_001).status).toBe("rejected");
  });
});

describe("demo per-attempt spend ceiling", () => {
  it("charges retries and network failures before contacting the provider", async () => {
    let calls = 0;
    const transport: typeof fetch = async () => { calls++; throw new TypeError("network failed"); };
    const budget = boundedFetch(transport, new AbortController().signal, { calls: 2, tokens: 10_000 });
    await expect(budget.fetch("https://example.test", { body: "{}" })).rejects.toThrow("network failed");
    await expect(budget.fetch("https://example.test", { body: "{}" })).rejects.toThrow("network failed");
    await expect(budget.fetch("https://example.test", { body: "{}" })).rejects.toThrow("budget");
    expect(calls).toBe(2);
    expect(budget.usage()).toEqual({ calls: 2, tokenCeiling: 2052 });
  });
  it("atomically reserves before concurrent fetches and counts Unicode bytes", async () => {
    let calls = 0;
    const transport: typeof fetch = async () => { calls++; return new Response("{}"); };
    const budget = boundedFetch(transport, new AbortController().signal, { calls: 10, tokens: 1030 });
    const results = await Promise.allSettled([budget.fetch("https://example.test", { body: "😀" }), budget.fetch("https://example.test", { body: "😀" })]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(calls).toBe(1);
    expect(budget.usage().tokenCeiling).toBe(1028);
  });
  it("never sends an aborted call", async () => {
    let calls = 0;
    const transport: typeof fetch = async () => { calls++; return new Response("{}"); };
    const abort = new AbortController(); abort.abort();
    const budget = boundedFetch(transport, abort.signal);
    await expect(budget.fetch("https://example.test", { body: "{}" })).rejects.toThrow();
    expect(calls).toBe(0);
  });
});

it("rejects path traversal, hidden options and repeated parameters", () => {
  for (const path of ["../secrets", "/etc/passwd", "src/../secrets", "src\\secret", "bad\0path"]) expect(safePath(path)).toBe(false);
  expect(safePath("src/index.ts")).toBe(true);
  expect(() => assertParams(new URLSearchParams("repo=x&rebuild=1"), ["repo"])).toThrow("parameter");
  expect(() => assertParams(new URLSearchParams("repo=x&repo=y"), ["repo"])).toThrow("parameter");
  expect(normalizedQuestion(" How  does\nAUTH work? ")).toBe("How does AUTH work?");
});

it("preserves the caller's shorter provider deadline", async () => {
  const outer = new AbortController(); const inner = new AbortController();
  let delivered: AbortSignal | undefined;
  const transport: typeof fetch = async (_input, init) => { delivered = init?.signal ?? undefined; return new Response("{}"); };
  const budget = boundedFetch(transport, outer.signal);
  await budget.fetch("https://example.test", { body: "{}", signal: inner.signal });
  inner.abort(new Error("call deadline"));
  expect(delivered?.aborted).toBe(true);
  expect(delivered?.reason.message).toBe("call deadline");
  expect(outer.signal.aborted).toBe(false);
});


it("invalidates cached answers when engine evidence or repository revision changes", () => {
  const base = { engineRevision: "engine-a", repo: "example", revision: "commit-a", question: "auth", scope: "", mode: "find", options: { beam: 3 } };
  expect(answerIdentity(base)).toBe(answerIdentity({ ...base }));
  expect(answerIdentity(base)).not.toBe(answerIdentity({ ...base, engineRevision: "engine-b" }));
  expect(answerIdentity(base)).not.toBe(answerIdentity({ ...base, revision: "commit-b" }));
});
