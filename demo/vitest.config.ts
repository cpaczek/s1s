import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["demo/*.test.ts", "test/demo-*.test.ts"], environment: "node" } });
