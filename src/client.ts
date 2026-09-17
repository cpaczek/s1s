import type { Question, SystemOneResponse } from "./types.ts";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MODEL = "speed_latest";

export type Timed = SystemOneResponse & { latencyMs: number };

/** One TypeSafe call: evaluate `questions` against `state`. */
export type Client = (state: unknown, questions: Record<string, Question>) => Promise<Timed>;

/**
 * Concurrency limiter that SHEDS on HTTP 529 ("model overloaded").
 * 529 is a size ceiling on in-flight judgments, not a rate limit: backing off in
 * time while keeping every worker alive never drains it, so we halve the window.
 */
export class Limiter {
  readonly initial: number;
  max: number;
  active = 0;
  private waiters: Array<() => void> = [];

  constructor(max: number) {
    this.initial = max;
    this.max = max;
  }

  async acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  release(): void {
    this.active--;
    this.wake();
  }

  shed(): void {
    this.max = Math.max(1, Math.floor(this.max / 2));
  }

  recover(): void {
    if (this.max < this.initial) {
      this.max++;
      this.wake();
    }
  }

  /**
   * Hand free slots to waiters. A waiter leaves the queue only when it gets its slot, and
   * the slot is taken here: after a shed `active` can sit above `max`, and a waiter that
   * was dequeued without a slot would never resolve (the process then exits 0 mid-search).
   */
  private wake(): void {
    while (this.active < this.max && this.waiters.length) {
      this.active++;
      this.waiters.shift()!();
    }
  }
}

export type ClientOptions = {
  apiKey?: string;
  concurrency?: number;
  fetchImpl?: typeof fetch;
  maxAttempts?: number;
  signal?: AbortSignal;
};

export function createClient(opts: ClientOptions = {}): Client & { limiter: Limiter } {
  const apiKey = opts.apiKey ?? process.env.TYPESAFE_API_KEY;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const limiter = new Limiter(opts.concurrency ?? 6);
  const maxAttempts = opts.maxAttempts ?? 6;

  const client = (async (state: unknown, questions: Record<string, Question>) => {
    if (!apiKey) throw new Error("TYPESAFE_API_KEY is not set (put it in .env)");
    const body = JSON.stringify({ document: state, model: MODEL, questions });
    let lastErr: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await limiter.acquire();
      const start = performance.now();
      try {
        const res = await fetchImpl(ENDPOINT, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body,
          signal: opts.signal,
        });
        if (res.status === 529) {
          limiter.shed();
          lastErr = new Error(`HTTP 529: ${await res.text()}`);
          await sleep(300 * 2 ** attempt);
          continue;
        }
        if (res.status === 429 || res.status >= 500) {
          lastErr = new Error(`HTTP ${res.status}: ${await res.text()}`);
          await sleep(res.status === 429 ? 1500 * 1.6 ** attempt : 400 * 2 ** attempt);
          continue;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
        const json = (await res.json()) as SystemOneResponse;
        limiter.recover();
        return { ...json, latencyMs: performance.now() - start };
      } catch (err) {
        if (opts.signal?.aborted) throw err;
        if (err instanceof TypeError) {
          lastErr = err; // network-level failure — retry
          await sleep(400 * 2 ** attempt);
          continue;
        }
        throw err;
      } finally {
        limiter.release();
      }
    }
    throw lastErr;
  }) as Client & { limiter: Limiter };
  client.limiter = limiter;
  return client;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
