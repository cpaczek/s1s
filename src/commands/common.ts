import { resolve } from "node:path";
import { buildIndex, type RepoIndex } from "../index/build.ts";

export const DEFAULT_REPO = process.cwd();
export const DEFAULT_PORT = 4747;

export const treeArgs = {
  repo: { type: "string" as const, description: "Repository to index (git-tracked files)", default: DEFAULT_REPO },
};

export function loadTree(args: { repo: string }): RepoIndex {
  return buildIndex(resolve(args.repo));
}

export function pct(x: number | undefined): string {
  return x === undefined ? "  –  " : `${Math.round(x * 100)}%`.padStart(4);
}
