import { resolve } from "node:path";
import { buildIndex, type RepoIndex } from "../index/build.ts";

export const DEFAULT_REPO = process.cwd();
export const DEFAULT_PORT = 4747;

export const treeArgs = {
  repo: { type: "string" as const, description: "Repository to index (git-tracked files)", default: DEFAULT_REPO },
};

export function loadTree(args: { repo: string }): RepoIndex {
  try {
    return buildIndex(resolve(args.repo));
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : "Unknown indexing error";
    throw new Error(`Cannot index repository ${resolve(args.repo)}: ${detail}`, { cause });
  }
}

export function integerArg(value: string, name: string, min: number, max: number): number {
  const number = Number(value);
  if (!value.trim() || !Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return number;
}

export function pct(x: number | undefined): string {
  return x === undefined ? "  –  " : `${Math.round(x * 100)}%`.padStart(4);
}
