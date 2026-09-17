/* UI contract smoke test; fake HTTP/SSE only, no TypeSafe spend.
   PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node ui/smoke.mjs */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, extname } from "node:path";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = fileURLToPath(new URL(".", import.meta.url));
const graph = JSON.parse(await readFile(process.env.FLOW_FIXTURE || join(root, "fixtures/flow-tiny.json"), "utf8"));
graph.nodes[0].evidence = [{ path: graph.nodes[0].path, line: 420, lines: ["// Deep source evidence"], kind: "comment", score: .9 }];
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
const requests = []; let failNext = false, delay = false, legacyPreview = false, warningNext = false, cacheNext = false;
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost"); requests.push(url);
  const json = (value, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
  if (url.pathname === "/api/repos") return json({ repos, defaultRepo: "opencode" });
  if (url.pathname === "/api/tree") return json({ repo: url.searchParams.get("repo"), root: tree, files: tree.files, buildMs: 8 });
  if (url.pathname === "/api/file") {
    if (legacyPreview) return json({ path: url.searchParams.get("path"), lines: ["// Legacy head preview"] });
    const from = Number(url.searchParams.get("from") || 1), to = Number(url.searchParams.get("to") || 200);
    return json({ path: url.searchParams.get("path"), from, to, total: 1000, lines: Array.from({ length: to - from + 1 }, (_, i) => `// Source preview line ${from + i}`) });
  }
  if (url.pathname === "/api/search" || url.pathname === "/api/explain") {
    if (failNext) { failNext = false; res.setHeader("Retry-After", "1"); return json({ error: "Demo request limit reached." }, 429); }
    const warnings = warningNext ? [{code:"expansion_timeout",stage:"walk",message:"Optional expansion timed out; showing completed source judgments."}] : []; warningNext = false;
    res.writeHead(200, { "Content-Type": "text/event-stream", "X-S1S-Cache": cacheNext ? "hit" : "miss" }); cacheNext = false;
    const emit = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    emit("queue", { message: "Waiting for a demo slot…" });
    if (delay) return;
    if (url.pathname === "/api/explain") {
      emit("explain_hop", { hop: 1, judged: graph.nodes.map(n => ({ ...n, plumbing: 0 })), expanded: paths, next: 0 });
      setTimeout(() => { emit("explain_done", { result: { graph, heat: Object.fromEntries(paths.map(p => [p, .9])), stats } }); res.end(); }, 250);
    } else {
      emit("lexical", { terms: [], paths, top: [], anchors: [], whole: false, ms: 1 });
      emit("verify", { candidates: paths.map(path => ({ path, match: .9, pick: .95 })), latencyMs: 1, tokens: 1 });
      emit("shortlist", { candidates: paths.map(path => ({ path, noul: .9 })), latencyMs: 1, tokens: 1 });
      for (const warning of warnings) emit("warning", { warning });
      setTimeout(() => { emit("done", { result: { query: "example", visited: [], warnings, verdict: warnings.length ? "partial" : "found", mode: url.searchParams.get("strategy") === "map" ? "map" : "find", results: paths.map(path => ({ path, score: .9, verify: .9, pick: .95, via: "lexical" })), heat: { [paths[0]]: .9 }, stats } }); res.end(); }, 350);
    }
    return;
  }
  const relative = ({ "/": "index.html", "/app": "app.html", "/playground": "playground.html", "/about": "about.html" })[url.pathname] || url.pathname.slice(1);
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
  await page.goto(base); await page.waitForFunction(() => !document.querySelector('#question').disabled);
  assert.equal(await page.locator('canvas').count(), 0, 'Simple entry must not load the repository map');
  assert.equal(requests.filter(u => u.pathname === '/api/tree').length, 0, 'Simple entry does not fetch the whole tree');
  assert.equal(await page.locator('#questionSuggestions button').count(), 2);
  assert.equal(await page.locator('#repoDirectory .repo-entry').count(), 5);
  assert.equal(await page.locator('#activity').isVisible(), false);
  delay = true;
  await page.locator('#question').fill('Where is configuration?'); await page.locator('#question').press('Enter');
  await page.waitForFunction(() => document.querySelector('#activityTitle').textContent.includes('Waiting for'));
  assert.equal(await page.locator('.activity-file').count(), 0, 'No invented file activity while queued');
  await page.locator('#stopSearch').click(); delay = false;
  assert.equal(await page.locator('#activityTitle').textContent(), 'Search cancelled');
  await page.locator('#retrySearch').click();
  await page.waitForFunction(() => document.querySelectorAll('.activity-file').length > 0);
  assert.equal(await page.locator('.activity-file').count(), paths.length, 'One mark per actual distinct path');
  assert.equal(await page.locator('#currentPaths li').count(), 3);
  await page.screenshot({path:join(root,'.shots/search-live.png'),fullPage:true});
  await page.waitForFunction(() => !document.querySelector('#searchResults').hidden);
  assert.match(await page.locator('#activityCounts').textContent(), new RegExp(`${paths.length} evidence-checked`));
  assert.equal(await page.locator('.file-result').count(), 5);
  await page.getByRole('button',{name:/Show .* more/}).click();
  assert.equal(await page.locator('.file-result').count(), paths.length);
  await page.locator('.file-result button').first().click();
  await page.waitForFunction(() => document.querySelector('#sourceCode').textContent.includes('Source preview line 1'));
  await page.locator('#nextSource').click();
  await page.waitForFunction(() => document.querySelector('#sourceMeta').textContent.includes('101'));
  await page.keyboard.press('Escape');
  const paidBeforeReplay = requests.filter(u => ['/api/search','/api/explain'].includes(u.pathname)).length;
  await page.locator('#resultPlayground').click(); await waitReady();
  await page.waitForFunction(() => window.__nav.state.lastResult && !window.__nav.state.es);
  assert.equal(requests.filter(u => ['/api/search','/api/explain'].includes(u.pathname)).length, paidBeforeReplay, 'Playground restores the same run with no new inference');
  assert.match(await page.locator('#costLine').textContent(), /Restored completed run/);
  await page.goto(base + '/app'); await page.waitForFunction(() => !document.querySelector('#question').disabled);
  await page.locator('#repository').selectOption('strapi');
  await page.locator('#question').fill('How does authentication work?'); await page.locator('#question').press('Enter');
  await page.waitForFunction(() => document.querySelector('#simpleFlow .flow-svg'));
  assert.equal(requests.filter(u => u.pathname === '/api/explain').at(-1).searchParams.get('repo'), 'strapi');
  await page.locator(`.flow-nodes [data-id="${graph.nodes[0].id}"]`).click();
  await page.waitForFunction(() => document.querySelector('#sourceMeta').textContent.includes('412'));
  await page.keyboard.press('Escape');
  await page.screenshot({path:join(root,'.shots/search-flow.png'),fullPage:true});
  await page.locator('#repository').selectOption('outline');
  assert.equal(await page.locator('#searchResults').isVisible(),false);
  assert.equal(await page.locator('#question').inputValue(),'');
  failNext = true; await page.locator('#question').fill('Where is configuration?'); await page.locator('#question').press('Enter');
  await page.locator('#retrySearch').waitFor({state:'visible'}); assert.match(await page.locator('#searchError').textContent(),/request limit/);
  await page.locator('#retrySearch').click(); await page.waitForFunction(() => !document.querySelector('#searchResults').hidden);
  assert.equal(await page.locator('#searchError').isVisible(),false);
  warningNext = true; cacheNext = true;
  await page.locator('#question').press('Enter');
  await page.waitForFunction(() => document.querySelector('#resultNote').textContent.includes('Optional expansion timed out'));
  assert.match(await page.locator('#resultTitle').textContent(), /Possible places/);
  assert.match(await page.locator('#activityTitle').textContent(), /limitation/);
  assert.match(await page.locator('#runStats').textContent(), /Cached run.*original estimated cost/);
  for (const width of [320,390,768]) {
    await page.setViewportSize({width,height:844}); await page.goto(base + '/app'); await page.waitForFunction(() => !document.querySelector('#question').disabled);
    await page.screenshot({path:join(root,`.shots/search-${width}.png`),fullPage:true});
    const overflow = await page.evaluate(() => [...document.querySelectorAll('body *')].filter(e=>e.getBoundingClientRect().right > innerWidth + 1).map(e=>[e.tagName,e.id,e.className,e.getBoundingClientRect().right]));
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Simple page overflow at ${width}: ${JSON.stringify(overflow)}`);
    for(const selector of ['#repository','#question','#searchButton']) { const box=await page.locator(selector).boundingBox(); assert(box.height>=44, `${selector} touch height`); }
    await page.screenshot({path:join(root,`.shots/search-${width}.png`),fullPage:true});
    await page.locator('#question').fill('How does authentication work?'); await page.locator('#question').press('Enter');
    await page.waitForFunction(() => document.querySelector('#simpleFlow .flow-svg'));
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Simple flow overflow at ${width}`);
    const firstNode = await page.locator(`.flow-nodes [data-id="${graph.nodes[0].id}"]`).boundingBox();
    const flowBounds = await page.locator('.flow-svg').boundingBox();
    assert(firstNode.x >= flowBounds.x, `Initial source title clipped at ${width}`);
    await page.screenshot({path:join(root,`.shots/search-flow-${width}.png`),fullPage:true});
  }
  await page.setViewportSize({width:1440,height:960});
  await page.goto(base); assert.match(await page.title(), /System One Search/);
  await page.screenshot({ path: join(root, ".shots/landing.png"), fullPage: true });
  await page.goto(base + "/about"); assert.equal(await page.locator(".pipeline-step").count(), 4);
  await page.goto(base + "/playground"); await waitReady();
  assert.equal(await page.locator("#repoSelect option").count(), 5);
  await page.locator("#q").fill("Where is configuration?"); await page.locator("#q").press("Enter");
  await page.waitForFunction(() => window.__nav.state.lastResult?.verdict === "found");
  assert(requests.some(u => u.pathname === "/api/search" && u.searchParams.get("strategy") === "find"));
  await page.locator("#topPath").click(); await page.waitForFunction(() => document.querySelector("#prevCode").textContent.includes("Source preview"));
  await page.evaluate(() => {
    window.__motionSeen = [];
    new MutationObserver(records => {
      for (const record of records) for (const node of record.addedNodes) {
        if (node.nodeType === 1 && node.classList.contains("map-flow-transition")) window.__motionSeen.push(node.dataset.sourceId);
      }
    }).observe(document.body, { childList: true });
  });
  await page.locator("#q").fill("How does authentication work?"); await page.locator("#q").press("Enter");
  await page.waitForFunction(() => window.__nav.state.liveNodes.size > 0);
  await page.waitForFunction(() => window.__nav.state.lastResult?.graph && !window.__nav.state.es);
  assert.equal(await page.locator(".flow-nodes [data-id]").count(), graph.nodes.length);
  const movedFiles = await page.evaluate(() => window.__motionSeen);
  assert(movedFiles.length > 0, "Visible source boxes should move into the completed flow");
  assert(movedFiles.every(id => graph.nodes.some(node => node.id === id)), "Motion must only connect real matching file IDs");
  await page.waitForFunction(() => !document.querySelector(".map-flow-transition"));

  assert(await page.locator("#flowHost").evaluate(e => e.classList.contains("walk-collapsed")));
  await page.locator(`.flow-nodes [data-id="${graph.nodes[0].id}"]`).click();
  await page.waitForFunction(() => document.querySelector("#prevCode .cl.hl")?.textContent.includes("line 420"));
  const previewRequest = requests.filter(u => u.pathname === "/api/file").at(-1);
  assert.equal(previewRequest.searchParams.get("from"), "390");
  assert.equal(previewRequest.searchParams.get("to"), "589");
  legacyPreview = true;
  await page.locator(`.flow-nodes [data-id="${graph.nodes[0].id}"]`).click();
  await page.waitForFunction(() => document.querySelector("#prevCode .cl.hl")?.textContent.includes("Deep source evidence"));
  assert.match(await page.locator("#prevCode").textContent(), /outside the returned preview/);
  legacyPreview = false;
  await page.getByRole("button", { name: "Show walkthrough" }).click();
  assert.equal(await page.getByRole("button", { name: "Hide walkthrough" }).getAttribute("aria-expanded"), "true");
  await page.getByRole("button", { name: "Hide walkthrough" }).click();
  await page.screenshot({ path: join(root, ".shots/flow.png"), fullPage: true });

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.evaluate(() => { window.__motionSeen = []; });
  await page.locator("#runBtn").click();
  await page.waitForFunction(() => window.__nav.state.lastResult?.graph && !window.__nav.state.es);
  assert.equal(await page.evaluate(() => window.__motionSeen.length), 0, "Reduced motion must skip the transition");
  await page.emulateMedia({ reducedMotion: "no-preference" });
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
  delay = false;
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, colorScheme: "light" });
  mobile.on("pageerror", e => { errors.push(e.message); console.error("mobile pageerror:", e.message); });
  mobile.on("console", e => { if (e.type() === "error") { consoleErrors.push(e.text()); console.error("mobile console:", e.text()); } });
  const sizes = [[320, 568], [360, 800], [390, 844], [768, 1024], [568, 320], [800, 360], [844, 390], [1024, 768]];
  for (const [width, height] of sizes) {
    await mobile.setViewportSize({ width, height });
    for (const route of ["/", "/about", "/playground"]) {
      await mobile.goto(base + route);
      if (route === "/playground") await mobile.waitForFunction(() => window.__nav?.state.tree && !window.__nav.state.loading);
      assert(await mobile.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${route} overflow at ${width}x${height}`);
      if (width === 320 || width === 768) await mobile.screenshot({ path: join(root, `.shots/mobile-${width}-${route.slice(1) || "landing"}.png`), fullPage: true });
    }
    for (const selector of ["#repoSelect", "#q", "#runBtn", '[data-strategy="explain"]']) {
      const box = await mobile.locator(selector).boundingBox(); assert(box.height >= 44, `${selector} touch height ${box.height} at ${width}`);
    }
    await mobile.locator("#q").fill("How does authentication work?"); await mobile.locator("#runBtn").tap();
    await mobile.waitForFunction(() => window.__nav.state.lastResult?.graph && !window.__nav.state.es);
    assert(await mobile.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `flow overflow at ${width}x${height}`);
    await mobile.locator(".flow-svg").scrollIntoViewIfNeeded();
    if (width < 600) assert(parseInt(await mobile.locator(".flow-zoom-k").textContent()) >= 80, "Phone flow must start readable");
    const beforeZoom = await mobile.locator(".flow-view").getAttribute("transform");
    await mobile.locator('.flow-zoom button[title="Zoom in"]').tap();
    assert.notEqual(await mobile.locator(".flow-view").getAttribute("transform"), beforeZoom);
    const beforePan = await mobile.locator(".flow-view").getAttribute("transform");
    const bounds = await mobile.locator(".flow-svg").boundingBox();
    const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
    const cdp = await mobile.context().newCDPSession(mobile);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x - 45, y: y - 30 }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    assert.notEqual(await mobile.locator(".flow-view").getAttribute("transform"), beforePan, "Touch pan should move graph");
    const beforePinch = await mobile.locator(".flow-zoom-k").textContent();
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: x - 20, y }, { x: x + 20, y }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x - 45, y }, { x: x + 45, y }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    assert.notEqual(await mobile.locator(".flow-zoom-k").textContent(), beforePinch, "Pinch should zoom graph");
    await cdp.detach();
    await mobile.getByRole("button", { name: "Show walkthrough" }).tap();
    assert(await mobile.locator(".flow-walk").isVisible());
    await mobile.getByRole("button", { name: "Hide walkthrough" }).tap();
    // Keyboard selection remains available even when a dense graph node is off screen.
    await mobile.locator('.res.flowres').first().focus(); await mobile.keyboard.press("Enter");
    await mobile.waitForFunction(() => document.querySelector("#prevCode .cl.hl")?.textContent.includes("line 420"));
    assert(await mobile.locator("#prevPanel").isVisible());
    await mobile.locator("#viewMap").tap(); assert(await mobile.locator("#canvasWrap").isVisible());
    await mobile.locator("#map").scrollIntoViewIfNeeded();
    const mapTarget = await mobile.evaluate(() => {
      const r = window.__nav.rects().find(r => r.node.kind === "dir" && r.depth > 0 && r.strip > 4 && r.w > 30);
      if (!r) return null;
      const b = document.querySelector("#map").getBoundingClientRect();
      return { x: b.x + r.x + 12, y: b.y + r.y + r.strip / 2, path: r.node.path };
    });
    if (mapTarget) {
      await mobile.touchscreen.tap(mapTarget.x, mapTarget.y);
      assert.equal(await mobile.evaluate(() => window.__nav.state.zoom), mapTarget.path);
      await mobile.locator("#crumbs button").first().tap();
      assert.equal(await mobile.evaluate(() => window.__nav.state.zoom), "");
    }
    await mobile.locator("#viewFlow").tap();
    await mobile.locator("#visualization").scrollIntoViewIfNeeded();
    await mobile.screenshot({ path: join(root, `.shots/mobile-flow-${width}x${height}.png`), fullPage: true });
    failNext = true; await mobile.locator("#runBtn").tap(); await mobile.locator("#retryBtn").waitFor({ state: "visible" });
    await mobile.locator("#retryBtn").tap(); await mobile.waitForFunction(() => window.__nav.state.lastResult && !window.__nav.state.es);
    delay = true; await mobile.locator("#runBtn").tap(); await mobile.locator("#cancelBtn").tap(); delay = false;
    assert.equal(await mobile.locator("#runBtn").isDisabled(), false);
  }
  await mobile.close();
  assert.deepEqual(errors, []);
  assert(consoleErrors.every(e => e.includes("429")), "Unexpected console error");
  console.log("UI smoke passed: landing, About, desktop/mobile, find/explain, preview, repository isolation, explicit override, error/retry, cancel; no browser exceptions.");
} finally { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
