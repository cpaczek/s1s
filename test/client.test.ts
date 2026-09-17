import { describe, expect, it } from "vitest";
import { Limiter, createClient } from "../src/client.ts";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("Limiter", () => {
  it("never runs more than max at once", async () => {
    const l = new Limiter(2);
    let peak = 0;
    await Promise.all(
      Array.from({ length: 8 }, async () => {
        await l.acquire();
        peak = Math.max(peak, l.active);
        await tick();
        l.release();
      }),
    );
    expect(peak).toBe(2);
    expect(l.active).toBe(0);
  });

  it("a shed never drops a waiter: everything queued still runs", async () => {
    const l = new Limiter(4);
    for (let i = 0; i < 4; i++) await l.acquire();
    let ran = 0;
    const queued = Array.from({ length: 5 }, () => l.acquire().then(() => void ran++));
    l.shed(); // max 4 → 2 while 4 are active and 5 wait
    l.release(); // active 3 ≥ max 2: nobody may start, and nobody may be lost
    await tick();
    expect(ran).toBe(0);
    l.release();
    l.release(); // active 1 < max 2 → exactly one waiter starts
    await tick();
    expect(ran).toBe(1);
    // Drain: each finished call frees the slot for the next waiter.
    l.release();
    for (let i = 0; i < 5; i++) {
      await tick();
      if (l.active > 0) l.release();
    }
    await Promise.all(queued);
    expect(ran).toBe(5);
  });

  it("recover widens the window one slot at a time and wakes a waiter", async () => {
    const l = new Limiter(2);
    l.shed();
    await l.acquire();
    let ran = false;
    const p = l.acquire().then(() => void (ran = true));
    await tick();
    expect(ran).toBe(false);
    l.recover();
    await p;
    expect(ran).toBe(true);
    expect(l.max).toBe(2);
  });
});

describe("createClient", () => {
  it("survives a 529 storm: every call settles after the window is shed", async () => {
    let n = 0;
    const fetchImpl = (async () => {
      n++;
      // The first three responses are 529s; everything after succeeds.
      if (n <= 3) return new Response("overloaded", { status: 529 });
      return new Response(JSON.stringify({ model: "fake", answers: {}, usage: { input_tokens: 1, output_tokens: 0 } }), { status: 200 });
    }) as typeof fetch;
    const client = createClient({ apiKey: "k", concurrency: 4, fetchImpl });
    const results = await Promise.all(Array.from({ length: 12 }, () => client({}, { q: { type: "noul", instructions: "?" } })));
    expect(results).toHaveLength(12);
    expect(client.limiter.active).toBe(0);
  }, 20_000);
});
