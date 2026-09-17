/* Keep one completed run in this tab for an explicit, network-free playground
   handoff. Failure or storage limits leave the ordinary query-prefill link intact. */
const KEY = "s1s.completed-run.v1";
const LIMIT = 2_000_000;
export function saveRun(record) {
  try {
    sessionStorage.removeItem(KEY);
    const text = JSON.stringify({ ...record, savedAt: Date.now() });
    if (text.length <= LIMIT) sessionStorage.setItem(KEY, text);
  } catch {
    /* Storage can be disabled; search itself still works. */
  }
}
export function readRun(repo, query) {
  try {
    const text = sessionStorage.getItem(KEY);
    if (!text || text.length > LIMIT) return null;
    const run = JSON.parse(text);
    if (
      run.repo !== repo ||
      run.query !== query ||
      !Number.isFinite(run.savedAt) ||
      run.savedAt > Date.now() ||
      Date.now() - run.savedAt > 3_600_000 ||
      !Array.isArray(run.events)
    )
      return null;
    if (!["done", "explain_done"].includes(run.events.at(-1)?.name))
      return null;
    return run;
  } catch {
    return null;
  }
}
export function replayRun(record) {
  const target = new EventTarget();
  let closed = false;
  const stream = {
    addEventListener: target.addEventListener.bind(target),
    onerror: null,
    close() {
      closed = true;
    },
  };
  queueMicrotask(() => {
    for (const { name, data } of record.events) {
      if (closed) break;
      target.dispatchEvent(
        new MessageEvent(name, { data: JSON.stringify(data) }),
      );
    }
  });
  return stream;
}
