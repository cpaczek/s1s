import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkoutBase, decodePatchPath, isTestPath, parseInstances, patchBasePaths, relevantPaths, verifyBase, type Git } from "../bench/retrieval/swebench.ts";
import { selectStable } from "../bench/retrieval/prepare.ts";

const SHA = "a".repeat(40);
const patch = (path: string, body = "@@ -1 +1 @@\n-old\n+new\n") => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${body}`;

describe("SWE-bench patch oracle boundary", () => {
  it("uses old-side names for modifications, deletions and renames; ignores additions", () => {
    const input = patch("src/a.py") + "diff --git a/src/deleted.py b/src/deleted.py\ndeleted file mode 100644\n--- a/src/deleted.py\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n" + "diff --git a/src/new.py b/src/new.py\nnew file mode 100644\n--- /dev/null\n+++ b/src/new.py\n@@ -0,0 +1 @@\n+new\n" + "diff --git a/src/old.py b/src/renamed.py\nsimilarity index 100%\nrename from src/old.py\nrename to src/renamed.py\n";
    expect(patchBasePaths(input)).toEqual(["src/a.py", "src/deleted.py", "src/old.py"]);
  });
  it("handles spaces, C quotes and UTF-8 octal paths without reading hunk pseudoheaders", () => {
    expect(decodePatchPath('"a/caf\\303\\251.py"')).toBe("a/café.py");
    expect(patchBasePaths(patch("space name.py", "@@ -1 +1 @@\n--- a/not-a-real-header.py\n+++ b/not-a-real-header.py\n"))).toEqual(["space name.py"]);
    expect(patchBasePaths('diff --git "a/quote\\\"name.py" "b/quote\\\"name.py"\n--- "a/quote\\\"name.py"\n+++ "b/quote\\\"name.py"\n@@ -1 +1 @@\n-old\n+new\n')).toEqual(['quote"name.py']);
    expect(patchBasePaths('diff --git "a/\\\"leading.py" "b/\\\"leading.py"\n--- "a/\\\"leading.py"\n+++ "b/\\\"leading.py"\n@@ -1 +1 @@\n-old\n+new\n')).toEqual(['"leading.py']);
  });
  it("fails closed on unsafe and ambiguous path encodings", () => {
    for (const path of ["../outside.py", "/tmp/outside.py", "a/../../outside.py", "a/.git/config", "a\\file.py", '"a/tab\\tname.py"', '"a/nul\\000name.py"', "C:outside.py"]) expect(() => decodePatchPath(path)).toThrow("Unsafe");
    expect(() => patchBasePaths(patch("../outside.py"))).toThrow();
    expect(() => patchBasePaths("diff --git broken\n")).toThrow();
  });
  it("excludes test and absent paths while preserving production test utilities", () => {
    const input = patch("src/main.py") + patch("tests/test_main.py") + patch("src/helper_test.py") + patch("src/missing.py") + patch("src/test_util.py") + patch("django/test/client.py");
    const gold = relevantPaths({ patch: input, test_patch: patch("src/main.py") }, new Set(["src/main.py", "tests/test_main.py", "src/helper_test.py", "src/test_util.py", "django/test/client.py"]));
    expect(gold.relevant).toEqual(["django/test/client.py"]);
    expect(gold.excluded.find((entry) => entry.path === "src/missing.py")?.reason).toContain("base_commit");
    expect(isTestPath("contest.py")).toBe(false);
  });
});

describe("SWE-bench source revision integrity", () => {
  it("rejects current HEAD when it differs from base_commit and rejects dirty source", () => {
    const wrong: Git = (args) => args.includes("rev-parse") ? "b".repeat(40) : "";
    expect(() => verifyBase("/tmp/repo", SHA, wrong)).toThrow("HEAD");
    const dirty: Git = (args) => args.includes("rev-parse") ? SHA : " M src/main.py";
    expect(() => verifyBase("/tmp/repo", SHA, dirty)).toThrow("dirty");
    expect(() => verifyBase("/tmp/repo", SHA, (args) => args.includes("rev-parse") ? SHA : "")).not.toThrow();
  });
  it("fetches and checks out the supplied full base SHA, never a branch or FETCH_HEAD", () => {
    const out = mkdtempSync(join(tmpdir(), "s1s-swe-")); const calls: string[][] = [];
    const runner: Git = (args) => {
      calls.push(args);
      if (args.includes("--is-bare-repository")) return "true";
      if (args.includes("get-url")) return "https://github.com/example/project.git";
      if (args.includes("rev-parse")) return SHA;
      return "";
    };
    try {
      const directory = checkoutBase(out, "example/project", SHA, runner);
      expect(calls.find((args) => args.includes("fetch"))?.slice(-2)).toEqual(["origin", SHA]);
      expect(calls.find((args) => args.includes("worktree"))?.slice(-3)).toEqual(["--detach", directory, SHA]);
      expect(directory).toContain(SHA);
      expect(calls.flat()).not.toContain("FETCH_HEAD");
    } finally { rmSync(out, { recursive: true, force: true }); }
  });
  it("refuses a stale existing checkout rather than overwriting or evaluating its HEAD", () => {
    const out = mkdtempSync(join(tmpdir(), "s1s-swe-")); const calls: string[][] = [];
    mkdirSync(join(out, "git", "example--project.git"), { recursive: true });
    mkdirSync(join(out, "repos", "example--project", SHA), { recursive: true });
    const runner: Git = (args) => {
      calls.push(args);
      if (args.includes("--is-bare-repository")) return "true";
      if (args.includes("get-url")) return "https://github.com/example/project.git";
      return "b".repeat(40);
    };
    try {
      expect(() => checkoutBase(out, "example/project", SHA, runner)).toThrow("HEAD");
      expect(calls.some((args) => args.includes("fetch") || args.includes("worktree"))).toBe(false);
    } finally { rmSync(out, { recursive: true, force: true }); }
  });
});

it("freezes selection from IDs, keeps exact issue text, and rejects duplicate dataset rows", () => {
  const row = { instance_id: "owner__repo-123", repo: "owner/repo", base_commit: SHA, problem_statement: "  Exact issue\ntext.  ", patch: patch("source.py"), test_patch: "", hints_text: "DO NOT USE HINTS" };
  const [loaded] = parseInstances(JSON.stringify([row]));
  expect(loaded.problem_statement).toBe(row.problem_statement);
  const rows = [loaded, { ...loaded, instance_id: "owner__repo-456" }];
  const ids = (input: typeof rows) => selectStable(input, (item) => item.instance_id, 1, "fixed-seed").map((item) => item.instance_id);
  expect(ids(rows)).toEqual(ids(rows.map((item) => ({ ...item, patch: "entirely different oracle" }))));
  expect(() => parseInstances(JSON.stringify([row, row]))).toThrow("duplicate");
  expect(parseInstances(JSON.stringify(row) + "\n").length).toBe(1);
});
