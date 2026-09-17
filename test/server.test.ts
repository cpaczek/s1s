import { afterEach, describe, expect, it } from "vitest";
import { once } from "node:events";
import type { Client } from "../src/client.ts";
import { get, type Server } from "node:http";
import { startServer } from "../src/server.ts";
import { fakeClient, fakeIndex } from "./fake.ts";

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }))); });
async function serve(client: Client = fakeClient({ verify: { "src/auth.ts": 0.95 } })) {
  const index = fakeIndex(["src/auth.ts", "src/deep.ts"], { "src/auth.ts": "export function authenticate() { return true; }", "src/deep.ts": Array.from({length: 300}, (_, i) => `line ${i + 1}`).join("\n") });
  const server = startServer({ repo: "fixture", port: 0, client, index });
  servers.push(server);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing address");
  return `http://127.0.0.1:${address.port}`;
}

describe("local API", () => {
  it("lists the local repository and serves exact source windows", async () => {
    const base = await serve();
    const repos = await fetch(base + "/api/repos").then((r) => r.json());
    expect((repos as {defaultRepo:string}).defaultRepo).toBe("local");
    const window = await fetch(base + "/api/file?path=src/deep.ts&from=220&to=222").then((r) => r.json());
    expect(window).toMatchObject({ from: 220, to: 222, total: 300, lines: ["line 220", "line 221", "line 222"] });
  });
  it("rejects malformed input before starting SSE or paid work", async () => {
    let calls = 0;
    const base = await serve(async () => { calls++; throw new Error("must not run"); });
    for (const path of ["/api/search?query=", "/api/search?query=a&strategy=invalid", "/api/search?query=a&beam=NaN", "/api/search?query=a&scope=missing", "/api/explain?question=a&depth=-1", "/api/explain?question=a&depth=Infinity", "/api/file?path=../.env", "/api/file?path=src/auth.ts&from=0"]) {
      const res = await fetch(base + path);
      expect(res.status, path).toBe(400);
      expect(res.headers.get("content-type")).toContain("application/json");
    }
    const hostStatus = await new Promise<number | undefined>((resolve, reject) => {
      get(base + "/api/tree", { headers: { Host: "attacker.example" } }, (response) => { response.resume(); resolve(response.statusCode); }).on("error", reject);
    });
    expect(hostStatus).toBe(403);
    expect((await fetch(base + "/api/search?query=auth", {headers:{Origin:"https://attacker.example"}})).status).toBe(403);
    expect((await fetch(base + "/api/search?query=auth", {headers:{"Sec-Fetch-Site":"cross-site"}})).status).toBe(403);
    expect(calls).toBe(0);
    expect((await fetch(base + "/api/tree?repo=unknown")).status).toBe(404);
    expect((await fetch(base + "/api/tree", { method: "POST" })).status).toBe(405);
  });
  it("finishes successful and failed SSE streams without reconnect loops", async () => {
    const base = await serve();
    const res = await fetch(base + "/api/search?query=authenticate");
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("event: done\n");
    expect(text).not.toContain("event: error\n");
    const failing = await serve(async () => { throw new Error("Upstream unavailable"); });
    const error = await fetch(failing + "/api/search?query=authenticate").then((r) => r.text());
    expect(error).toContain('"message":"Upstream unavailable"');
    expect(error).not.toContain("event: done\n");
  });
  it("cancels request work when the stream is disconnected", async () => {
    const index = fakeIndex(["a.ts"]);
    let canceled = false;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const server = startServer({ repo: "fixture", port: 0, index, client: fakeClient({}), clientForSignal: (signal) => async () => {
      started();
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => { canceled = true; reject(signal.reason); }, { once: true }));
    } });
    servers.push(server); await once(server, "listening");
    const address = server.address(); if (!address || typeof address === "string") throw new Error();
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/search?query=auth`, { signal: controller.signal });
    await ready;
    controller.abort();
    await response.body?.cancel().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(canceled).toBe(true);
  });
});
