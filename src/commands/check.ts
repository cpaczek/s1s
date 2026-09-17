import { defineCommand } from "citty";
import { readFileSync } from "node:fs";
import { assessCoverage } from "../library.ts";
import { integerArg, loadTree, treeArgs } from "./common.ts";

export const check = defineCommand({
  meta: { name: "check", description: "Audit examined files and remaining reference neighbours (no API calls)" },
  args: {
    ...treeArgs,
    scope: { type: "string", default: "", description: "Directory to audit" },
    examined: { type: "string", default: "", description: "Comma-separated repository paths already examined" },
    "examined-json": { type: "string", default: "", description: "JSON file containing an array of examined repository paths" },
    limit: { type: "string", default: "100", description: "Maximum frontier/unresolved samples (0–1000)" },
    json: { type: "boolean", default: false, description: "Print CoverageReport JSON" },
  },
  run({ args }) {
    const paths = args.examined.split(",").map(p => p.trim()).filter(Boolean);
    if (args["examined-json"]) {
      const value: unknown = JSON.parse(readFileSync(args["examined-json"], "utf8"));
      if (!Array.isArray(value) || value.some(p => typeof p !== "string")) throw new Error("examined-json must contain an array of paths");
      paths.push(...value);
    }
    const report = assessCoverage(loadTree(args), { scope: args.scope, examinedPaths: paths, maxFrontier: integerArg(args.limit, "limit", 0, 1000) });
    if (args.json) { console.log(JSON.stringify(report, null, 2)); return; }
    console.log(`${report.files.examined}/${report.files.tracked} tracked files examined; ${report.files.withoutText} without text.`);
    console.log(`${report.frontierTotal} reference neighbours remain; ${report.unresolvedTotal} unresolved imports (including external packages).`);
    for (const path of report.frontier) console.log(`  ${path}`);
    console.log("Semantic completeness is not established. This measures supplied evidence coverage only.");
  },
});
