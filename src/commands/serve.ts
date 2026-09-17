import { defineCommand } from "citty";
import { createClient } from "../client.ts";
import { startServer } from "../server.ts";
import { DEFAULT_PORT, integerArg, loadTree, treeArgs } from "./common.ts";

export const serve = defineCommand({
  meta: { name: "serve", description: "Start the localhost treemap UI + search API" },
  args: {
    ...treeArgs,
    port: { type: "string", description: "Port", default: String(DEFAULT_PORT) },
    concurrency: { type: "string", description: "Max in-flight TypeSafe calls", default: "6" },
  },
  run({ args }) {
    const client = createClient({ concurrency: integerArg(args.concurrency, "concurrency", 1, 32) });
    if (!process.env.TYPESAFE_API_KEY) console.warn("warning: TYPESAFE_API_KEY not set — the treemap works, search will fail");
    const index = loadTree(args);
    startServer({ repo: index.repo, port: integerArg(args.port, "port", 0, 65535), client, clientForSignal: (signal) => createClient({ signal, concurrency: integerArg(args.concurrency, "concurrency", 1, 32) }), index, reload: () => loadTree(args) });
  },
});
