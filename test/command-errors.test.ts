import { describe, expect, it, vi } from "vitest";
const build = vi.hoisted(() => vi.fn());
vi.mock("../src/index/build.ts", () => ({ buildIndex: build }));
import { loadTree } from "../src/commands/common.ts";
describe("indexing errors", () => {
  it("preserves the actual failure instead of diagnosing every error as a missing checkout", () => {
    const cause = new Error("spawnSync git ENOENT");
    build.mockImplementation(() => { throw cause; });
    try { loadTree({ repo: "/fixture" }); throw new Error("Expected failure"); }
    catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("spawnSync git ENOENT");
      expect((error as Error).cause).toBe(cause);
    }
  });
});
