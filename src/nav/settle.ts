import { isRecoverableProviderError } from "../client.ts";

/** Drain a launched batch before returning or failing. Never hide a fatal sibling error
 * behind a transient one, and never let a request finish while its paid calls still run. */
export async function settleAll<T>(pending: Promise<T>[]): Promise<T[]> {
  const settled = await Promise.allSettled(pending);
  const failed = settled.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed.length) throw (failed.find((r) => !isRecoverableProviderError(r.reason)) ?? failed[0]).reason;
  return settled.map((r) => (r as PromiseFulfilledResult<T>).value);
}
