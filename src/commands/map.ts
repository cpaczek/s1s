import { defineCommand } from "citty";
import { createClient } from "../client.ts";
import { map } from "../library.ts";
import { loadTree, pct, treeArgs } from "./common.ts";
import { printEvent } from "./find.ts";
export const mapCommand = defineCommand({
  meta: { name: "map", description: "Map a subject across repository files" },
  args: { ...treeArgs, subject: { type: "positional", required: true, description: "Subject to map" }, scope: { type: "string", default: "", description: "Directory scope" }, json: { type: "boolean", default: false, description: "Print SearchResult JSON" } },
  async run({args}) {
    const result = await map(loadTree(args),createClient(),args.subject,{scope:args.scope,onEvent:args.json?undefined:printEvent});
    if (args.json) { console.log(JSON.stringify(result,null,2));return; }
    for(const row of result.results) console.log(`${pct(row.noul)}  ${row.path}`);
    console.log(`${result.verdict}: ${result.stats.calls} calls, ${result.stats.wallMs}ms, ≈$${result.stats.estCostUsd.toFixed(5)}`);
  },
});
