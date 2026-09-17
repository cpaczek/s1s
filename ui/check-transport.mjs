/* Deterministic transport checks: `node ui/check-transport.mjs`. No network. */
import assert from "node:assert/strict";
import { openEventStream, strategyFor } from "./transport.js";
const originalFetch = globalThis.fetch;
const encoder = new TextEncoder();
const response = (chunks) => new Response(new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(encoder.encode(chunk)); controller.close(); } }), { headers: { "Content-Type": "text/event-stream", "X-S1S-Cache": "hit" } });
try {
  assert.equal(strategyFor("How does auth work?"), "explain");
  assert.equal(strategyFor("Show me the database connection flow"), "explain");
  assert.equal(strategyFor("Where do requests start?"), "find");
  assert.equal(strategyFor("How does auth work?", "find"), "find");
  assert.equal(strategyFor("authentication", "map"), "map");
  globalThis.fetch = async () => response(["event: queue\r", "\ndata: {\"message\":\"waiting\"}\r\n\r", "\nevent: done\ndata: {\"ok\":true}\n\n"]);
  await new Promise((resolve, reject) => {
    const stream = openEventStream("/fake"); let cache = false, queue = false;
    stream.onerror = reject;
    stream.addEventListener("cache", e => { cache = JSON.parse(e.data).hit; });
    stream.addEventListener("queue", e => { queue = JSON.parse(e.data).message === "waiting"; });
    stream.addEventListener("done", e => { try { assert(cache && queue); assert(JSON.parse(e.data).ok); stream.close(); resolve(); } catch (err) { reject(err); } });
  });
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "Budget reached." }), { status: 429, headers: { "Retry-After": "45" } });
  await new Promise((resolve, reject) => {
    const stream = openEventStream("/fake"); stream.onerror = error => { try { assert.match(error.message, /Budget reached.*45 seconds/); resolve(); } catch (e) { reject(e); } };
  });
  globalThis.fetch = async () => response(["event: queue\ndata: {}\n\n"]);
  await new Promise((resolve, reject) => {
    const stream = openEventStream("/fake"); stream.onerror = error => { try { assert.match(error.message, /before the result/); resolve(); } catch (e) { reject(e); } };
  });
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error("offline"); };
  await new Promise(resolve => { const stream = openEventStream("/fake"); stream.onerror = resolve; });
  assert.equal(requests, 1, "Never automatically replay a paid request");
  console.log("Transport checks passed: routing override, chunked CRLF, cache/queue, HTTP429 details, incomplete stream, no implicit replay.");
} finally { globalThis.fetch = originalFetch; }
