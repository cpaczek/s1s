/** Cache replay is a delivery mode, not the original search verdict. */
export type Verdict = "found" | "partial" | "absent" | "unknown";
function isVerdict(value: unknown): value is Exclude<Verdict, "unknown"> {
  return value === "found" || value === "partial" || value === "absent";
}
export function cachedVerdict(body: string): Verdict {
  // The bounded cache only holds completed streams. Scan from the final frame so
  // repository comments or earlier progress data cannot become the result status.
  const frames = body.trimEnd().split("\n\n");
  for (let i = frames.length - 1; i >= 0; i--) {
    const frame = frames[i];
    if (!/^event: (done|explain_done)\n/.test(frame)) continue;
    const text = frame.split("\n").filter(line => line.startsWith("data: ")).map(line => line.slice(6)).join("\n");
    try {
      const event: unknown = JSON.parse(text);
      if (!event || typeof event !== "object" || !("result" in event)) return "unknown";
      const result = event.result;
      if (!result || typeof result !== "object") return "unknown";
      const verdict = "verdict" in result ? result.verdict
        : "graph" in result && result.graph && typeof result.graph === "object" && "verdict" in result.graph ? result.graph.verdict : undefined;
      return isVerdict(verdict) ? verdict : "unknown";
    } catch { return "unknown"; }
  }
  return "unknown";
}
