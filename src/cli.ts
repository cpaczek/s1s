import { mapCommand } from "./commands/map.ts";
import { check } from "./commands/check.ts";
import { defineCommand, runMain } from "citty";
import { serve } from "./commands/serve.ts";
import { index } from "./commands/index.ts";
import { find } from "./commands/find.ts";
import { bench } from "./commands/bench.ts";
import { explainCommand } from "./commands/explain.ts";
import { benchFlow } from "./commands/bench-flow.ts";


const main = defineCommand({
  meta: { name: "s1s", description: "System One Search — find, map and explain repository code" },
  subCommands: { check, serve, index, find, map: mapCommand, explain: explainCommand, bench, "bench-flow": benchFlow },
});

runMain(main);
