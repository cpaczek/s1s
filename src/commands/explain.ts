import { runExplain } from "../flow/run.ts";
export { runExplain } from "../flow/run.ts";
import { defineCommand } from "citty";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createClient } from "../client.ts";
import type { NavEvent } from "../nav/events.ts";
import type { FlowGraph } from "../flow/types.ts";
import { F } from "../questions.ts";
import { integerArg, loadTree, pct, treeArgs } from "./common.ts";
import { printEvent } from "./find.ts";


export const explainCommand = defineCommand({
  meta: { name: "explain", description: 'Explain how something works: "how does authentication work" → a flow chart + walkthrough, every word extracted from the tree' },
  args: {
    question: { type: "positional", description: "What you want explained", required: true },
    ...treeArgs,
    scope: { type: "string", description: "Directory to look under", default: "" },
    depth: { type: "string", description: "How many references away from the seeds to look", default: String(F.DEPTH) },
    tests: { type: "boolean", description: "Include test files", default: false },
    out: { type: "string", description: "Write the chart here: .json = the FlowGraph, .html = a self-contained page (chart + walkthrough, offline)", default: "" },
    json: { type: "boolean", description: "Print the ExplainResult JSON only", default: false },
  },
  async run({ args }) {
    const index = loadTree(args);
    const client = createClient();
    const params = { question: args.question, scope: args.scope.replace(/^\/+|\/+$/g, ""), depth: integerArg(args.depth, "depth", 0, 6), tests: args.tests };
    const result = await runExplain({ client, index, params, emit: (e) => (args.json ? undefined : printExplainEvent(e)) });
    if (args.out) writeFileSync(args.out, args.out.endsWith(".html") ? flowPage(result.graph) : JSON.stringify(result.graph, null, 2));
    if (args.json) {
      process.stdout.write(JSON.stringify(result, null, 2));
      return;
    }
    const g = result.graph;
    console.log(`\nverdict: ${g.verdict.toUpperCase()} — ${g.nodes.length} units, ${g.edges.length} references, ${g.clusters.length} clusters${g.dropped.nodes || g.dropped.edges ? ` (left out: ${g.dropped.nodes} units, ${g.dropped.edges} references${g.dropped.hubs.length ? `, hubs ${g.dropped.hubs.map((h) => h.split("/").pop()).join(", ")}` : ""})` : ""}`);
    for (const c of g.clusters) {
      console.log(`\n  ${c.title}/`);
      for (const id of c.nodes) {
        const n = g.nodes.find((x) => x.id === id)!;
        console.log(`    ${pct(n.part)} ${n.role.padEnd(11)} ${n.title}${n.seed ? " ●" : ""}${n.terminal ? " ▣" : ""}${n.summary ? `\n         “${n.summary}”` : ""}`);
      }
    }
    console.log("\n  references:");
    for (const e of g.edges) console.log(`    ${pct(e.carries)} ${short(e.from)} → ${short(e.to)}${e.names.length ? `  {${e.names.slice(0, 3).join(", ")}${e.names.length > 3 ? ", …" : ""}}` : ""}${e.kind !== "import" ? `  (${e.kind})` : ""}${e.back ? "  ↺" : ""}`);
    const s = result.stats;
    console.log(`\n${s.calls} calls · ${s.inputTokens.toLocaleString()} in tokens · ${s.members} members → ${s.judged} judged · ${s.blocks} explaining blocks · wall ${s.wallMs}ms · ≈$${s.estCostUsd.toFixed(4)}${args.out ? ` · wrote ${args.out}` : ""}`);
  },
});

const short = (p: string) => p.split("/").slice(-2).join("/");

const UI_DIR = fileURLToPath(new URL("../../ui/", import.meta.url));

/**
 * One file that draws the chart anywhere: the UI's tokens, the flow renderer and its stylesheet
 * inlined, the FlowGraph embedded as JSON, laid out by the browser at load time (no server, no
 * network). Needs ui/flow.js + ui/flow.css (the renderer); says so otherwise.
 */
export function flowPage(graph: FlowGraph): string {
  const read = (name: string) => (existsSync(UI_DIR + name) ? readFileSync(UI_DIR + name, "utf8") : undefined);
  const js = read("flow.js");
  const css = read("flow.css");
  if (!js || !css) throw new Error("ui/flow.js and ui/flow.css are needed for an .html export (write .json instead)");
  const tokens = read("style.css") ?? "";
  const json = JSON.stringify(graph).replace(/<\/script/gi, "<\\/script");
  const title = graph.topic.replace(/[<>&]/g, (ch) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[ch]!);
  return `<!doctype html>
<html lang="en" data-theme="auto">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title} — flow</title>
<style>${tokens}</style>
<style>${css}</style>
<style>html,body{margin:0;height:100%;background:var(--plane)}#flow{height:100vh}</style>
</head>
<body>
<div id="flow"></div>
<script id="flow-graph" type="application/json">${json}</script>
<script type="module">
${js.replace(/^export\s+/gm, "")}
const graph = JSON.parse(document.getElementById("flow-graph").textContent);
renderFlow(document.getElementById("flow"), graph, {});
</script>
</body>
</html>
`;
}

export function printExplainEvent(e: NavEvent): void {
  switch (e.type) {
    case "explain_seeds":
      console.log(`  ◎ ${e.members.length} members${e.truncated ? ` (+${e.truncated} lexical matches not judged)` : ""}; seeds: ${e.seeds.map(short).join(", ")}`);
      break;
    case "explain_hop":
      console.log(`  ↔ hop ${e.hop}: judged ${e.judged.length} (${e.judged.filter((j) => j.part >= F.MEMBER).length} in), expanding ${e.expanded.length} → ${e.next} next  (${e.latencyMs.toFixed(0)}ms)`);
      for (const j of e.judged.filter((j) => j.part >= F.MEMBER).sort((a, b) => b.part - a.part).slice(0, 6)) console.log(`      ${pct(j.part)} ${j.role.padEnd(11)} ${short(j.path)}${j.plumbing >= F.PLUMBING ? " (plumbing)" : ""}`);
      break;
    case "explain_evidence":
      console.log(`  ¶ evidence: ${e.kept}/${e.judged} blocks explain it (${e.latencyMs.toFixed(0)}ms)${e.top[0] ? ` — e.g. ${short(e.top[0].path)}:${e.top[0].line} “${e.top[0].text.slice(0, 80)}”` : ""}`);
      break;
    case "explain_edges":
      console.log(`  ⇢ references: ${e.kept}/${e.judged} carry it (${e.latencyMs.toFixed(0)}ms)`);
      break;
    case "explain_done":
      break;
    default:
      printEvent(e);
  }
}
