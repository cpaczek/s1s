import { defineCommand } from "citty";
import { createClient } from "../client.ts";
import { STRATEGIES, type NavEvent, type Strategy } from "../nav/events.ts";
import { normalizeParams, runSearch } from "../nav/search.ts";
import { integerArg, loadTree, pct, treeArgs } from "./common.ts";
import { T } from "../questions.ts";

export const find = defineCommand({
  meta: { name: "find", description: "Find a file from a plain-language description" },
  args: {
    query: { type: "positional", description: "What you are looking for", required: true },
    ...treeArgs,
    strategy: { type: "string", description: "find (default: lexical pool → shortlist → verify, walks only if needed) | walk | map (subject heat map)", default: "find" },
    scope: { type: "string", description: "Directory to search under", default: "" },
    beam: { type: "string", description: "Beam width (walk)", default: "3" },
    json: { type: "boolean", description: "Print the SearchResult JSON only", default: false },
  },
  async run({ args }) {
    if (!STRATEGIES.includes(args.strategy as Strategy)) throw new Error("strategy must be find, walk or map");
    const index = loadTree(args);
    const client = createClient();
    const params = normalizeParams({
      query: args.query,
      strategy: args.strategy as Strategy,
      scope: args.scope,
      beam: integerArg(args.beam, "beam", 1, 10),
    });
    const quiet = args.json;
    const emit = (e: NavEvent) => {
      if (quiet) return;
      printEvent(e);
    };
    const result = await runSearch({ client, index, params, emit });
    if (quiet) {
      process.stdout.write(JSON.stringify(result, null, 2));
      return;
    }
    console.log("");
    console.log(`verdict: ${result.verdict.toUpperCase()}${result.separation ? `  (separation ×${result.separation.toFixed(2)})` : ""}`);
    if (result.mode === "map") {
      const t = result.topic!;
      console.log(`MAP of "${t.name}"${t.includes.length ? ` — includes: ${t.includes.join("; ")}` : ""}${t.excludes.length ? ` — excludes: ${t.excludes.join("; ")}` : ""}`);
      console.log(`${result.results.length} ${(result.results.length === 1 ? "place" : "places")} ≥ ${T.PARTIAL} (${result.results.filter((r) => (r.noul ?? 0) >= T.FOUND).length} ≥ ${T.FOUND})${result.truncated ? `, ${result.truncated} lexical matches beyond the prefilter were not judged` : ""}:`);
      for (const r of result.results.slice(0, 40)) console.log(`  ${pct(r.noul)}  ${r.path}`);
      if (result.results.length > 40) console.log(`  … ${result.results.length - 40} more`);
    }
    if (result.mode !== "map") {
      for (const r of result.results.slice(0, 12)) {
        console.log(`  ${pct(r.verify)} verify  ${pct(r.pick)} pick  ${r.via.padEnd(7)}  ${r.path}`);
      }
    }
    const s = result.stats;
    console.log(
      `\n${s.calls} calls · ${s.inputTokens.toLocaleString()} in / ${s.outputTokens.toLocaleString()} out tokens · api Σ${s.apiMs}ms · wall ${s.wallMs}ms · ~$${s.estCostUsd.toFixed(5)} · ${s.model}`,
    );
  },
});

export function printEvent(e: NavEvent): void {
  switch (e.type) {
    case "start":
      console.log(`start ${e.params.strategy} "${e.params.query}" under ${e.params.scope || "/"}`);
      break;
    case "expand": {
      const top = e.options.slice(0, 4).map((o) => `${o.name}${o.kind === "dir" ? "/" : ""} ${pct(o.p).trim()}`).join(", ");
      console.log(`  walk ${e.path || "/"}  under-here ${pct(e.underHere).trim()}  conf ${pct(e.confidence).trim()}  ${e.latencyMs.toFixed(0)}ms  → ${top}`);
      break;
    }
    case "beam":
      console.log(`    beam[${e.step}]: ${e.candidates.map((c) => `${c.path}${c.kind === "dir" ? "/" : ""} ${c.score.toFixed(2)}`).join(" | ")}`);
      break;
    case "prune":
      console.log(`    prune ${e.path} (${e.reason}, ${e.score.toFixed(2)})`);
      break;
    case "backtrack":
      console.log(`    backtrack: ${e.from} → ${e.to}`);
      break;
    case "lexical": {
      const words = e.terms.map((t) => `${t.label}${t.df ? "" : "∅"}`).join(" ");
      console.log(`  lexical [${words}] → ${e.whole ? `whole scope (${e.paths.length})` : `pool of ${e.paths.length}`} in ${e.ms.toFixed(1)}ms  top: ${e.top.slice(0, 3).map((t) => t.path).join(", ")}`);
      break;
    }
    case "terms":
      console.log(`  ~ vocabulary: ${e.accepted.length}/${e.offered} of the tree's words belong (${e.latencyMs.toFixed(0)}ms)${e.added.length ? ` → +${e.added.join(" +")}` : ""}`);
      break;
    case "shortlist":
      console.log(`  shortlist ${e.candidates.length} (${e.latencyMs.toFixed(0)}ms) top: ${e.candidates.slice(0, 3).map((c) => `${c.path} ${pct(c.noul).trim()}`).join(", ")}`);
      break;
    case "escalate":
      console.log(`  escalate ${e.reason} after verify → walking from / and [${e.seeds.join(", ")}]`);
      break;
    case "batch":
      console.log(`  batch ${e.batch + 1}/${e.batches} (${e.units} units, ${e.latencyMs.toFixed(0)}ms) top: ${e.top.slice(0, 3).map((t) => `${t.path} ${pct(t.noul).trim()}`).join(", ")}`);
      break;
    case "verify":
      console.log(`  verify ${e.candidates.length} candidates (${e.latencyMs.toFixed(0)}ms)`);
      break;
    case "error":
      console.error(`  error ${e.message}`);
      break;
    case "done":
      break;
  }
}
