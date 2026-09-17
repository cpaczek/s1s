import { defineCommand, runMain } from "citty";
import { serve } from "./commands/serve.ts";
import { index } from "./commands/index.ts";
import { find } from "./commands/find.ts";
import { bench } from "./commands/bench.ts";
import { explainCommand } from "./commands/explain.ts";
import { benchFlow } from "./commands/bench-flow.ts";

const main = defineCommand({
  meta: { name: "typesafe-nav", description: "Navigate and explain a tree of files or data with TypeSafe judgments" },
  subCommands: { serve, index, find, explain: explainCommand, bench, "bench-flow": benchFlow },
});

runMain(main);
