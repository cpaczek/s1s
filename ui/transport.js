/* Fetch-based SSE: inspect HTTP failures and never silently replay a paid run. */
export function openEventStream(url) {
  const events = new EventTarget();
  const controller = new AbortController();
  let closed = false;
  let idle;
  const arm = () => {
    clearTimeout(idle);
    idle = setTimeout(() => fail(new Error("The search timed out. You can retry the question.")), 120_000);
  };
  const stream = {
    addEventListener: events.addEventListener.bind(events),
    onerror: null,
    close() { closed = true; clearTimeout(idle); controller.abort(); },
  };
  function fail(error) {
    if (closed) return;
    stream.close();
    stream.onerror?.(error);
  }
  const dispatch = (frame) => {
    let name = "message";
    const data = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) name = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (data.length && !closed) events.dispatchEvent(new MessageEvent(name, { data: data.join("\n") }));
  };
  (async () => {
    try {
      arm();
      const response = await fetch(url, { signal: controller.signal, headers: { Accept: "text/event-stream" } });
      if (!response.ok) {
        const detail = await response.json().catch(() => ({}));
        const wait = response.headers.get("Retry-After");
        throw new Error((detail.error || detail.message || `Search failed (HTTP ${response.status}).`) + (wait ? ` Try again after ${wait} seconds.` : ""));
      }
      if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) throw new Error("The server did not return a search stream.");
      events.dispatchEvent(new MessageEvent("cache", { data: JSON.stringify({ hit: response.headers.get("X-S1S-Cache") === "hit" }) }));
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!closed) {
        const { done, value } = await reader.read();
        if (done) break;
        arm();
        buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, "\n");
        // Cap malformed frames instead of retaining an unbounded server response.
        if (buffer.length > 8_000_000) throw new Error("The search stream exceeded its message limit.");
        let end;
        while (!closed && (end = buffer.indexOf("\n\n")) !== -1) {
          dispatch(buffer.slice(0, end));
          buffer = buffer.slice(end + 2);
        }
      }
      if (!closed) fail(new Error("The connection ended before the result arrived. Retry the question."));
    } catch (error) {
      if (!closed) fail(error instanceof Error ? error : new Error("Could not reach the search server."));
    }
  })();
  return stream;
}

/** Routing is a deterministic convenience, and the explicit mode always wins. */
export function strategyFor(question, selected = "auto") {
  if (selected !== "auto") return selected;
  return /^(?:how\b|explain\b|trace\b)|\b(?:flow|walk\s+me\s+through)\b/i.test(question.trim()) ? "explain" : "find";
}
