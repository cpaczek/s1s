import { defineCommand } from "citty";
import type { TreeNode } from "../index/build.ts";
import { loadTree, treeArgs } from "./common.ts";

export const index = defineCommand({
  meta: { name: "index", description: "Build the repo index and print a summary (or --json the tree)" },
  args: {
    ...treeArgs,
    json: { type: "boolean", description: "Print the full tree as JSON", default: false },
    depth: { type: "string", description: "Summary depth", default: "2" },
  },
  run({ args }) {
    const idx = loadTree(args);
    if (args.json) {
      process.stdout.write(JSON.stringify(idx.root));
      return;
    }
    console.log(`${idx.fileCount} files, ${idx.byPath.size - idx.fileCount} dirs, built in ${Math.round(idx.buildMs)}ms`);
    const maxDepth = Number(args.depth);
    const show = (n: TreeNode, d: number) => {
      if (d > maxDepth) return;
      const pad = "  ".repeat(d);
      if (n.kind === "dir") {
        if (n.path) console.log(`${pad}${n.name}/  ${n.files} files, ${(n.size / 1024).toFixed(0)} KB`);
        for (const c of n.children ?? []) show(c, n.path ? d + 1 : d);
      }
    };
    show(idx.root, 0);
  },
});
