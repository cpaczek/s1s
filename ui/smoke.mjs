/* UI contract smoke test; fake HTTP/SSE only, no TypeSafe spend.
   PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node ui/smoke.mjs */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, extname } from "node:path";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = fileURLToPath(new URL(".", import.meta.url));
const graph = JSON.parse(await readFile(join(root, "fixtures/flow-tiny.json"), "utf8"));
const paths = [...new Set(graph.nodes.map(n => n.path))];
const tree = { name: "", path: "", kind: "dir", children: [], lines: 0, size: 0, files: 0 };
for (const path of paths) {
  let dir = tree; const parts = path.split("/");
  for (let i = 0; i < parts.length - 1; i++) {
    let child = dir.children.find(n => n.name === parts[i]);
    if (!child) { child = { name: parts[i], path: parts.slice(0, i + 1).join("/"), kind: "dir", children: [], size: 0, lines: 0, files: 0 }; dir.children.push(child); }
    dir = child;
  }
  dir.children.push({ name: parts.at(-1), path, kind: "file", ext: "ts", size: 600, lines: 40, files: 1 });
}
function sum(node) { if (node.children) { node.children.forEach(sum); for (const key of ["size", "lines", "files"]) node[key] = node.children.reduce((s, n) => s + n[key], 0); } }
sum(tree);
const stats = { calls: 3, inputTokens: 5000, outputTokens: 100, apiMs: 300, wallMs: 480, estCostUsd: .00021, model: "fake", members: 8, judged: 8, blocks: 12 };
const repos = ["opencode", "strapi", "outline", "hoppscotch", "ripgrep"].map(id => ({ id, name: id, description: `Public ${id} repository`, url: `https://github.com/example/${id}`, questions: [`How does ${id} authentication work?`, `Where is the ${id} configuration?`] }));
const requests = []; let failNext = false, delay = false;
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost"); requests.push(url);
  const json = (value, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
  if (url.pathname === "/api/repos") return json({ repos, defaultRepo: "opencode" });
  if (url.pathname === "/api/tree") return json({ repo: url.searchParams.get("repo"), root: tree, files: tree.files, buildMs: 8 });
  if (url.pathname === "/api/file") return json({ path: url.searchParams.get("path"), lines: ["// Source preview", "export const example = true;"] });
  if (url.pathname === "/api/search" || url.pathname === "/api/explain") {
    if (failNext) { failNext = false; res.setHeader("Retry-After", "1"); return json({ error: "Demo request limit reached." }, 429); }
    res.writeHead(200, { "Content-Type": "text/event-stream", "X-S1S-Cache": "miss" });
    const emit = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    emit("queue", { message: "Waiting for a demo slot…" });
    if (delay) return;
    if (url.pathname === "/api/explain") {
      emit("explain_hop", { hop: 1, judged: graph.nodes.map(n => ({ ...n, plumbing: 0 })), expanded: paths, next: 0 });
      setTimeout(() => { emit("explain_done", { result: { graph, heat: Object.fromEntries(paths.map(p => [p, .9])), stats } }); res.end(); }, 250);
    } else {
      emit("shortlist", { candidates: paths.map(path => ({ path, noul: .9 })), latencyMs: 1, tokens: 1 });
      emit("done", { result: { query: "example", visited: [], verdict: "found", mode: url.searchParams.get("strategy") === "map" ? "map" : "find", results: [{ path: paths[0], score: .9, verify: .9, pick: .95, via: "lexical" }], heat: { [paths[0]]: .9 }, stats } }); res.end();
    }
    return;
  }
  const relative = ({ "/": "index.html", "/app": "app.html", "/about": "about.html" })[url.pathname] || url.pathname.slice(1);
  try { const body = await readFile(join(root, relative)); res.writeHead(200, { "Content-Type": ({ ".html": "text/html", ".css": "text/css", ".js": "text/javascript" })[extname(relative)] || "text/plain" }); res.end(body); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, colorScheme: "light" });
const errors = []; const consoleErrors = [];
page.on("pageerror", e => { errors.push(e.message); console.error("pageerror:", e.message); });
page.on("console", e => { if (e.type() === "error") { consoleErrors.push(e.text()); console.error("console:", e.text()); } });
const waitReady = () => page.waitForFunction(() => window.__nav?.state.tree && !window.__nav.state.loading);
try {
  await mkdir(join(root, ".shots"), { recursive: true });
  await page.goto(base); assert.match(await page.title(), /System One Search/);
  await page.screenshot({ path: join(root, ".shots/landing.png"), fullPage: true });
  await page.goto(base + "/about"); assert.equal(await page.locator(".pipeline-step").count(), 4);
  await page.goto(base + "/app"); await waitReady();
  assert.equal(await page.locator("#repoSelect option").count(), 5);
  await page.locator("#q").fill("Where is configuration?"); await page.locator("#q").press("Enter");
  await page.waitForFunction(() => window.__nav.state.lastResult?.verdict === "found");
  assert(requests.some(u => u.pathname === "/api/search" && u.searchParams.get("strategy") === "find"));
  await page.locator("#topPath").click(); await page.waitForFunction(() => document.querySelector("#prevCode").textContent.includes("Source preview"));
  await page.locator("#q").fill("How does authentication work?"); await page.locator("#q").press("Enter");
  await page.waitForFunction(() => window.__nav.state.liveNodes.size > 0);
  await page.waitForFunction(() => window.__nav.state.lastResult?.graph && !window.__nav.state.es);
  assert.equal(await page.locator(".flow-nodes [data-id]").count(), graph.nodes.length);
  assert(await page.locator("#flowHost").evaluate(e => e.classList.contains("walk-collapsed")));
  await page.getByRole("button", { name: "Show walkthrough" }).click();
  assert.equal(await page.getByRole("button", { name: "Hide walkthrough" }).getAttribute("aria-expanded"), "true");
  await page.getByRole("button", { name: "Hide walkthrough" }).click();
  await page.screenshot({ path: join(root, ".shots/flow.png"), fullPage: true });
  await page.locator("#viewMap").click(); assert(await page.locator("#canvasWrap").isVisible());
  await page.locator("#repoSelect").selectOption("strapi"); await waitReady();
  assert.equal(await page.locator("#resultsPanel").isVisible(), false);
  assert.match(await page.locator("#suggestions").textContent(), /strapi/);
  await page.locator('[data-strategy="find"]').click();
  await page.locator("#q").fill("How does auth work?"); await page.locator("#q").press("Enter");
  await page.waitForFunction(() => window.__nav.state.lastResult && !window.__nav.state.es);
  assert.equal(requests.filter(u => u.pathname === "/api/search").at(-1).searchParams.get("repo"), "strapi");
  failNext = true; await page.locator("#runBtn").click(); await page.locator("#retryBtn").waitFor({ state: "visible" });
  assert.match(await page.locator("#err").textContent(), /request limit/);
  await page.locator("#retryBtn").click(); await page.waitForFunction(() => !window.__nav.state.es);
  assert.equal(await page.locator("#err").isVisible(), false);
  delay = true; await page.locator("#runBtn").click(); await page.locator("#cancelBtn").click();
  assert.equal(await page.locator("#runBtn").isDisabled(), false);
  await page.screenshot({ path: join(root, ".shots/app.png"), fullPage: true });
  for (const route of ["/", "/about", "/app"]) {
    await page.setViewportSize({ width: 390, height: 844 }); await page.goto(base + route);
    if (route === "/app") await waitReady();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${route} horizontal overflow`);
    await page.screenshot({ path: join(root, `.shots/mobile-${route.slice(1) || "landing"}.png`), fullPage: true });
  }
  assert.deepEqual(errors, []);
  assert(consoleErrors.every(e => e.includes("429")), "Unexpected console error");
  console.log("UI smoke passed: landing, About, desktop/mobile, find/explain, preview, repository isolation, explicit override, error/retry, cancel; no browser exceptions.");
} finally { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
