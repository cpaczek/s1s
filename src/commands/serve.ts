import { defineCommand } from "citty";
import { createClient } from "../client.ts";
import { startServer } from "../server.ts";
import { DEFAULT_PORT, loadTree, treeArgs } from "./common.ts";

export const serve = defineCommand({
  meta: { name: "serve", description: "Start the localhost treemap UI + search API" },
  args: {
    ...treeArgs,
    port: { type: "string", description: "Port", default: String(DEFAULT_PORT) },
    concurrency: { type: "string", description: "Max in-flight TypeSafe calls", default: "6" },
  },
  run({ args }) {
    const client = createClient({ concurrency: Number(args.concurrency) });
    if (!process.env.TYPESAFE_API_KEY) console.warn("warning: TYPESAFE_API_KEY not set — the treemap works, search will fail");
    const index = loadTree(args);
    startServer({ repo: index.repo, port: Number(args.port), client, index, reload: () => loadTree(args) });
  },
});
