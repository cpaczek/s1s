import type { Answer, Question, SystemOneResponse } from "./types.ts";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MODEL = "speed_latest";
const RESPONSE_BYTES = 2 * 1024 * 1024;

export type Timed = SystemOneResponse & { latencyMs: number };
/** One TypeSafe call: evaluate questions against state. */
export type Client = (state: unknown, questions: Record<string, Question>) => Promise<Timed>;

/** Provider HTTP failure; only exhausted transient statuses permit optional-stage recovery. */
export class TypeSafeHttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`TypeSafe HTTP ${status}`);
    this.name = "TypeSafeHttpError";
    this.status = status;
  }
}

/** A deadline owned by this client, never a caller's request-level cancellation. */
export class TypeSafeTimeoutError extends Error {
  constructor() {
    super("TypeSafe request timed out");
    this.name = "TimeoutError";
  }
}

export function isRecoverableProviderError(error: unknown): boolean {
  return error instanceof TypeSafeTimeoutError || (error instanceof TypeSafeHttpError && (error.status === 429 || error.status >= 500 && error.status <= 599));
}

type Waiter = { resolve: () => void; reject: (reason: unknown) => void; signal?: AbortSignal; cancel?: () => void };
/** Adaptive concurrency limit: a 529 sheds load without losing queued callers. */
export class Limiter {
  readonly initial: number;
  max: number;
  active = 0;
  private waiters: Waiter[] = [];
  constructor(max: number) {
    if (!Number.isInteger(max) || max < 1) throw new Error("concurrency must be a positive integer");
    this.initial = max;
    this.max = max;
  }
  async acquire(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.active < this.max) { this.active++; return; }
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal };
      waiter.cancel = () => {
        const at = this.waiters.indexOf(waiter);
        if (at !== -1) this.waiters.splice(at, 1);
        reject(signal?.reason);
      };
      this.waiters.push(waiter);
      signal?.addEventListener("abort", waiter.cancel, { once: true });
    });
  }
  release(): void { this.active--; this.wake(); }
  shed(): void { this.max = Math.max(1, Math.floor(this.max / 2)); }
  recover(): void { if (this.max < this.initial) { this.max++; this.wake(); } }
  private wake(): void {
    while (this.active < this.max && this.waiters.length) {
      const waiter = this.waiters.shift()!;
      if (waiter.cancel) waiter.signal?.removeEventListener("abort", waiter.cancel);
      if (waiter.signal?.aborted) { waiter.reject(waiter.signal.reason); continue; }
      this.active++;
      waiter.resolve();
    }
  }
}

export type ClientOptions = {
  apiKey?: string;
  concurrency?: number;
  fetchImpl?: typeof fetch;
  maxAttempts?: number;
  signal?: AbortSignal;
  /** Deadline for a logical call, including waiting for a slot and all retries. */
  timeoutMs?: number;
};

export function createClient(opts: ClientOptions = {}): Client & { limiter: Limiter } {
  const apiKey = opts.apiKey ?? process.env.TYPESAFE_API_KEY;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const limiter = new Limiter(opts.concurrency ?? 6);
  const maxAttempts = opts.maxAttempts ?? 6;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) throw new Error("maxAttempts must be an integer from 1 to 10");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error("timeoutMs must be a positive integer");

  const client = (async (state: unknown, questions: Record<string, Question>) => {
    if (!apiKey) throw new Error("TYPESAFE_API_KEY is not set (put it in .env)");
    if (!Object.keys(questions).length) throw new Error("At least one TypeSafe question is required");
    for (const q of Object.values(questions)) {
      if (q.type === "choice" && (Object.keys(q.criteria).length < 2 || Object.keys(q.criteria).length > 255)) throw new Error("Choice requires 2–255 options");
      if (q.type === "score" && q.criteria.length < 2) throw new Error("Score requires at least two levels");
    }
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = AbortSignal.any([deadline, ...(opts.signal ? [opts.signal] : [])]);
    const body = JSON.stringify({ document: state, model: MODEL, questions });
    let lastError: unknown = new Error("TypeSafe request failed");
    const start = performance.now();
    try {
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        await limiter.acquire(signal);
        let delay = 0;
        let received = false;
        try {
          signal.throwIfAborted();
          const res = await fetchImpl(ENDPOINT, {
            method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body, signal,
          });
          received = true;
          if (res.status === 529 || res.status === 429 || res.status >= 500) {
            received = true;
          if (res.status === 529) limiter.shed();
            lastError = new TypeSafeHttpError(res.status);
            await res.body?.cancel();
            delay = res.status === 429 ? 1500 * 1.6 ** attempt : 300 * 2 ** attempt;
          } else {
            if (!res.ok) {
              try { await res.body?.cancel(); } finally { throw new TypeSafeHttpError(res.status); }
            }
            const json = await readResponse(res);
            validateResponse(json, questions);
            signal.throwIfAborted();
            limiter.recover();
            return { ...json, latencyMs: performance.now() - start };
          }
        } catch (error) {
          opts.signal?.throwIfAborted();
          // Only a fetch failure or the actual abort reason can become a deadline.
          // Invalid response parsing/validation and programming failures stay fatal.
          if (!received || error === signal.reason) signal.throwIfAborted();
          if (!(error instanceof TypeError) || received) throw error;
          lastError = error;
          delay = 400 * 2 ** attempt;
        } finally { limiter.release(); }
        if (attempt + 1 < maxAttempts) await sleep(delay, signal);
      }
      throw lastError;
    } catch (error) {
      // A caller's global deadline/abort wins over this call's own deadline. It must
      // cancel the entire search, rather than masquerade as an optional-stage timeout.
      if (opts.signal?.aborted) throw opts.signal.reason;
      if (deadline.aborted && error === deadline.reason) throw new TypeSafeTimeoutError();
      throw error;
    }
  }) as Client & { limiter: Limiter };
  client.limiter = limiter;
  return client;
}

async function readResponse(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("TypeSafe returned an empty response");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > RESPONSE_BYTES) { await reader.cancel(); throw new Error("TypeSafe response exceeds the size limit"); }
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("TypeSafe returned invalid JSON");
    throw error;
  } finally { reader.releaseLock(); }
}

function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
const probability = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
function validAnswer(value: unknown, question: Question): value is Answer {
  if (!object(value) || value.type !== question.type) return false;
  if (question.type === "noul") return probability(value.noul);
  if (!probability(value.confidence) || !object(value.probabilities) || !Object.values(value.probabilities).every(probability)) return false;
  if (question.type === "choice") return typeof value.choice === "string" && Object.hasOwn(question.criteria, value.choice);
  return typeof value.score === "number" && Number.isFinite(value.score) && value.score >= 0 && value.score <= question.criteria.length - 1 && object(value.legend);
}
function validateResponse(value: unknown, questions: Record<string, Question>): asserts value is SystemOneResponse {
  if (!object(value) || typeof value.model !== "string" || !object(value.answers) || !object(value.usage)) throw new Error("TypeSafe returned an invalid response shape");
  for (const field of ["input_tokens", "output_tokens"]) {
    const n = value.usage[field];
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) throw new Error("TypeSafe returned invalid usage");
  }
  for (const [id, q] of Object.entries(questions)) if (!validAnswer(value.answers[id], q)) throw new Error(`TypeSafe returned an invalid ${q.type} answer`);
}
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", cancel); resolve(); }, ms);
    signal.addEventListener("abort", cancel, { once: true });
  });
}
