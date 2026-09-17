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
    const concurrency = integerArg(args.concurrency, "concurrency", 1, 32);
    const client = createClient({ concurrency });
    if (!process.env.TYPESAFE_API_KEY) console.warn("warning: TYPESAFE_API_KEY not set — the treemap works, search will fail");
    const index = loadTree(args);
    const server = startServer({
      repo: index.repo,
      port: integerArg(args.port, "port", 0, 65535),
      client,
      clientForSignal: (signal) => createClient({ signal, concurrency }),
      index,
      reload: () => loadTree(args),
    });
    server.on("error", (error) => { console.error(`Unable to start s1s server: ${error.message}`); process.exitCode = 1; });
  },
});
