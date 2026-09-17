/** Cost ceilings count UTF-8 request bytes as tokens, plus framing overhead.
 * Reservations are never refunded: failures, eviction and unreported usage remain bounded.
 * This intentionally overestimates normal tokenizer usage. No IP is stored here. */
export const LIMITS = {
  requestTokens: 2_000_000, requestCalls: 48, globalDayTokens: 200_000_000,
  ipDayTokens: 16_000_000, ipMinute: 6, globalMinute: 60,
  concurrency: 1, queue: 8, queueMs: 15_000, leaseMs: 90_000,
  executionMs: 60_000, cacheMs: 86_400_000, cacheBytes: 1_000_000,
  cacheEntries: 100, maxIdentities: 2_000,
} as const;
const DAY = 86_400_000;
type Identity = { dayTokens: number; minute: number; count: number };
export type Lease = { id: string; key: string; ip: string; status: "active" | "queued"; expires: number };
export type ProtectionState = { day: number; tokens: number; minute: number; count: number; identities: Record<string, Identity>; leases: Lease[] };
export type Admission = { status: "active" | "queued"; id: string } | { status: "cached"; body: string } | { status: "rejected"; message: string; retryAfter: number };
export function initialState(now: number): ProtectionState {
  return { day: Math.floor(now / DAY), tokens: 0, minute: Math.floor(now / 60_000), count: 0, identities: {}, leases: [] };
}
export function prune(state: ProtectionState, now: number): void {
  if (state.day !== Math.floor(now / DAY)) {
    state.day = Math.floor(now / DAY); state.tokens = 0; state.identities = {};
  }
  if (state.minute !== Math.floor(now / 60_000)) { state.minute = Math.floor(now / 60_000); state.count = 0; }
  state.leases = state.leases.filter((lease) => lease.expires > now);
  let active = state.leases.filter((lease) => lease.status === "active").length;
  for (const lease of state.leases) {
    if (lease.status === "queued" && active < LIMITS.concurrency) { lease.status = "active"; lease.expires = now + LIMITS.leaseMs; active++; }
  }
}
export function admit(state: ProtectionState, ip: string, key: string, id: string, now: number, cached?: string): Admission {
  prune(state, now);
  const reject = (message: string, retryAfter = 60): Admission => ({ status: "rejected", message, retryAfter });
  if (!state.identities[ip] && Object.keys(state.identities).length >= LIMITS.maxIdentities) return reject("The demo is busy. Please try again later.");
  const identity = state.identities[ip] ??= { dayTokens: 0, minute: state.minute, count: 0 };
  if (identity.minute !== state.minute) { identity.minute = state.minute; identity.count = 0; }
  if (identity.count >= LIMITS.ipMinute || state.count >= LIMITS.globalMinute) return reject("Too many questions. Please wait a minute.");
  identity.count++; state.count++;
  if (cached !== undefined) return { status: "cached", body: cached };
  if (state.leases.some((lease) => lease.key === key)) return reject("This question is already running. Try again shortly for the cached answer.", 3);
  if (state.tokens + LIMITS.requestTokens > LIMITS.globalDayTokens || identity.dayTokens + LIMITS.requestTokens > LIMITS.ipDayTokens) {
    return reject("The daily demo budget has been reached. Cached questions are still available.", Math.ceil((DAY - now % DAY) / 1000));
  }
  if (state.leases.length >= LIMITS.concurrency + LIMITS.queue) return reject("The demo queue is full. Please try again shortly.", 15);
  if (state.leases.some((lease) => lease.ip === ip)) return reject("Please finish your current question first.", 3);
  const status = state.leases.filter((lease) => lease.status === "active").length < LIMITS.concurrency ? "active" : "queued";
  state.tokens += LIMITS.requestTokens; identity.dayTokens += LIMITS.requestTokens;
  state.leases.push({ id, ip, key, status, expires: now + (status === "active" ? LIMITS.leaseMs : LIMITS.queueMs) });
  return { status, id };
}
export function release(state: ProtectionState, id: string, now: number): Lease | undefined {
  const lease = state.leases.find((entry) => entry.id === id);
  state.leases = state.leases.filter((entry) => entry.id !== id);
  prune(state, now);
  return lease;
}

/** This wrapper sits at the fetch boundary, so retries consume the same budget. */
export function boundedFetch(fetchImpl: typeof fetch, signal: AbortSignal, caps: { calls: number; tokens: number } = { calls: LIMITS.requestCalls, tokens: LIMITS.requestTokens }) {
  let calls = 0; let tokens = 0;
  const wrapped: typeof fetch = async (input, init) => {
    signal.throwIfAborted();
    if (typeof init?.body !== "string") throw new Error("The demo only permits serialized judgment requests.");
    const ceiling = new TextEncoder().encode(init.body).byteLength + 1024;
    if (calls + 1 > caps.calls || tokens + ceiling > caps.tokens) throw new Error("This question reached the demo's per-question budget. Try a narrower question.");
    calls++; tokens += ceiling;
    return fetchImpl(input, { ...init, signal });
  };
  return { fetch: wrapped, usage: () => ({ calls, tokenCeiling: tokens }) };
}

export function normalizedQuestion(value: string): string { return value.trim().replace(/\s+/gu, " "); }
export function safePath(value: string): boolean { return value.length <= 1024 && !value.startsWith("/") && !value.includes("\\") && !value.includes("\0") && !value.split("/").some((p) => p === "." || p === ".."); }
export function assertParams(params: URLSearchParams, allowed: readonly string[]): void {
  for (const key of params.keys()) if (!allowed.includes(key) || params.getAll(key).length !== 1) throw new Error(`Unsupported or repeated parameter: ${key}`);
}
