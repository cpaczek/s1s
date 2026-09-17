import { openEventStream, strategyFor } from "./transport.js";
import { renderFlow } from "./flow.js";
import { saveRun } from "./run-record.js";

const $ = (id) => document.getElementById(id);
const state = {
  repos: [],
  repo: "",
  stream: null,
  generation: 0,
  events: [],
  eventBytes: 0,
  stepCount: 0,
  recordable: true,
  cached: false,
  files: new Map(),
  verified: new Set(),
  edges: 0,
  flow: null,
  preview: null,
  previewVersion: 0,
  sourceAbort: null,
};
const eventNames = [
  "queue",
  "cache",
  "start",
  "lexical",
  "terms",
  "shortlist",
  "expand",
  "beam",
  "prune",
  "backtrack",
  "escalate",
  "batch",
  "verify",
  "explain_seeds",
  "explain_hop",
  "explain_evidence",
  "explain_edges",
  "done",
  "explain_done",
  "warning",
  "error",
];
const text = (id, value) => {
  $(id).textContent = value;
};
const element = (tag, className, content) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
};
const repo = () => state.repos.find((r) => r.id === state.repo);
function playgroundLink(query = "", completed = false) {
  const url = new URL("/playground", location.origin);
  url.searchParams.set("repo", state.repo);
  if (query) url.searchParams.set("q", query);
  if (completed && state.recordable) url.searchParams.set("replay", "1");
  for (const id of ["playgroundLink", "resultPlayground"])
    $(id).href = url.pathname + url.search;
}
function closeStream() {
  state.stream?.close();
  state.stream = null;
  $("stopSearch").hidden = true;
  $("searchButton").disabled = !state.repos.length;
}
function clearResult() {
  state.flow?.destroy();
  state.flow = null;
  $("simpleFlow").replaceChildren();
  $("simpleFlow").hidden = true;
  $("fileResults").replaceChildren();
  $("searchResults").hidden = true;
  $("activity").hidden = true;
  $("searchError").hidden = true;
  $("retrySearch").hidden = true;
  state.sourceAbort?.abort();
  state.previewVersion++;
  if ($("sourceDialog").open) $("sourceDialog").close();
}
function chooseRepo(id) {
  closeStream();
  state.generation++;
  clearResult();
  delete document.body.dataset.search;
  state.repo = id;
  $("repository").value = id;
  text("repositoryDescription", repo()?.description || "");
  const source = $("repositorySource");
  source.hidden = !/^https:\/\//.test(repo()?.url || "");
  if (!source.hidden) source.href = repo().url;
  $("question").value = "";
  $("questionSuggestions").replaceChildren();
  for (const question of (repo()?.questions || []).slice(0, 2)) {
    const button = element("button", "", question);
    button.type = "button";
    button.addEventListener("click", () => {
      $("question").value = question;
      startSearch();
    });
    $("questionSuggestions").append(button);
  }
  playgroundLink();
  const url = new URL(location.href);
  url.searchParams.set("repo", id);
  url.searchParams.delete("q");
  history.replaceState(null, "", url);
}
async function boot() {
  try {
    $("retrySearch").hidden = true;
    $("searchError").hidden = true;
    const response = await fetch("/api/repos", {
      signal: AbortSignal.timeout(15_000),
    });
    const data = await response.json();
    if (!response.ok)
      throw new Error(data.error || "Could not load the repository catalog.");
    if (!Array.isArray(data.repos) || !data.repos.length)
      throw new Error("No repositories are available.");
    state.repos = data.repos;
    $("repository").replaceChildren();
    $("repoDirectory").replaceChildren();
    for (const item of data.repos) {
      const option = element("option", "", item.name);
      option.value = item.id;
      $("repository").append(option);
      const entry = element("article", "repo-entry");
      const button = element("button", "", item.name);
      button.type = "button";
      button.addEventListener("click", () => {
        chooseRepo(item.id);
        $("question").focus();
        $("searchForm").scrollIntoView({ block: "center" });
      });
      entry.append(button, element("p", "", item.description));
      $("repoDirectory").append(entry);
    }
    $("repository").disabled = false;
    $("question").disabled = false;
    $("searchButton").disabled = false;
    const params = new URLSearchParams(location.search),
      requested = params.get("repo"),
      query = params.get("q");
    chooseRepo(
      state.repos.some((r) => r.id === requested)
        ? requested
        : state.repos.some((r) => r.id === data.defaultRepo)
          ? data.defaultRepo
          : state.repos[0].id,
    );
    if (query) {
      $("question").value = query.slice(0, 500);
      playgroundLink(query);
    }
  } catch (error) {
    fail(error.message);
  }
}
function fail(message) {
  closeStream();
  text("searchError", message);
  $("searchError").hidden = false;
  $("retrySearch").hidden = false;
  if (!$("activity").hidden) {
    text("activityTitle", "Search stopped");
    text(
      "activityDetail",
      "No completed answer was received. You can retry explicitly.",
    );
    $("activity").dataset.state = "failed";
  }
}
function stage(title, detail) {
  text("activityTitle", title);
  text("activityDetail", detail);
}
function recordFiles(paths, stageName) {
  if (paths.length)
    $("currentPaths").replaceChildren(
      ...paths.slice(-3).map((path) => element("li", "", path)),
    );
  for (const path of paths) {
    if (!path) continue;
    const existing = state.files.get(path);
    if (!existing) {
      // Bound the visual, not the truthful distinct-file count.
      const cell =
        state.files.size < 240 ? element("span", "activity-file") : null;
      if (cell) {
        cell.title = path;
        cell.dataset.path = path;
        cell.dataset.stage = stageName;
        $("fileActivity").append(cell);
      }
      state.files.set(path, cell);
    } else {
      existing.dataset.stage = stageName;
      // Animate only a file in this server event; avoid forced layout reads.
      if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
        for (const animation of existing.getAnimations()) animation.cancel();
        existing.animate(
          [
            { opacity: 0.3, transform: "translateY(5px)" },
            { opacity: 1, transform: "translateY(0)" },
          ],
          { duration: 450, easing: "ease-out" },
        );
      }
    }
    if (stageName === "verified") state.verified.add(path);
  }
  text(
    "activityCounts",
    `${state.files.size} files reported · ${state.verified.size} source-verified · ${state.edges} references kept${state.files.size > 240 ? " · first 240 files shown" : ""}`,
  );
}
function logStep(message) {
  state.stepCount++;
  const li = element("li", "", message);
  $("eventLog").append(li);
  if ($("eventLog").children.length > 150)
    $("eventLog").firstElementChild.remove();
  text(
    "eventCount",
    `(${state.stepCount}${state.stepCount > 150 ? "; latest 150 shown" : ""})`,
  );
}
function startSearch() {
  const query = $("question").value.trim();
  if (!query || !state.repos.length) return;
  closeStream();
  const generation = ++state.generation;
  clearResult();
  document.body.dataset.search = "running";
  state.events = [];
  state.eventBytes = 0;
  state.stepCount = 0;
  state.recordable = true;
  state.cached = false;
  state.files.clear();
  state.verified.clear();
  state.edges = 0;
  $("fileActivity").replaceChildren();
  $("currentPaths").replaceChildren();
  $("eventLog").replaceChildren();
  text("eventCount", "");
  text("activityCounts", "");
  $("activity").hidden = false;
  $("activity").dataset.state = "running";
  text("activityLabel", "Live search");
  stage("Connecting to the repository", "Waiting for the first server event.");
  $("searchButton").disabled = true;
  $("stopSearch").hidden = false;
  playgroundLink(query);
  const strategy = strategyFor(query);
  const url = new URL(
    strategy === "explain" ? "/api/explain" : "/api/search",
    location.origin,
  );
  url.searchParams.set("repo", state.repo);
  url.searchParams.set(strategy === "explain" ? "question" : "query", query);
  if (strategy === "explain") url.searchParams.set("depth", "3");
  else url.searchParams.set("strategy", "find");
  const stream = openEventStream(url);
  state.stream = stream;
  for (const name of eventNames)
    stream.addEventListener(name, (event) => {
      if (state.generation !== generation || state.stream !== stream) return;
      try {
        const data = JSON.parse(event.data);
        state.eventBytes += event.data.length;
        if (state.eventBytes < 1_800_000) state.events.push({ name, data });
        else state.recordable = false;
        handleEvent(name, data, query);
      } catch {
        fail("The server returned an unreadable search event. Please retry.");
      }
    });
  stream.onerror = (error) => {
    if (state.generation === generation && state.stream === stream)
      fail(error.message);
  };
}
function handleEvent(name, data, query) {
  let detail = "";
  switch (name) {
    case "cache":
      state.cached = data.hit;
      if (data.hit) {
        text("activityLabel", "Cached search");
        stage(
          "Restoring a previous answer",
          "These events are from the cached run, not new model calls.",
        );
      }
      return;
    case "queue":
      detail = data.message || "Waiting for an available demo slot.";
      stage("Waiting for the search service", detail);
      break;
    case "start":
      detail = "Search started.";
      stage("Searching source files", detail);
      break;
    case "lexical":
      recordFiles(data.paths, "retrieved");
      detail = `${data.paths.length} files in the lexical candidate pool.`;
      stage("Candidates retrieved", detail);
      break;
    case "shortlist":
      recordFiles(
        data.candidates.map((c) => c.path),
        "shortlisted",
      );
      detail = `${data.candidates.length} candidate judgments received.`;
      stage("Relevance judgments received", detail);
      break;
    case "verify":
      recordFiles(
        data.candidates.map((c) => c.path),
        "verified",
      );
      detail = `${data.candidates.length} files checked against source evidence.`;
      stage("Source evidence checked", detail);
      break;
    case "batch":
      recordFiles(Object.keys(data.heat), "shortlisted");
      detail = `Membership batch ${data.batch + 1} of ${data.batches}: ${data.units} units judged.`;
      stage("Finding the subject’s files", detail);
      break;
    case "explain_seeds":
      recordFiles(data.seeds, "traced");
      detail = `${data.seeds.length} starting files selected; ${data.truncated} lexical matches were not judged because of the membership prefilter limit.`;
      stage("Following source references", detail);
      break;
    case "explain_hop":
      recordFiles(
        data.judged.map((n) => n.path),
        "traced",
      );
      detail = `Hop ${data.hop}: ${data.judged.length} files judged; ${data.next} neighbors queued.`;
      stage("Following source references", detail);
      break;
    case "explain_evidence":
      recordFiles(
        data.top.map((n) => n.path),
        "traced",
      );
      detail = `${data.kept} of ${data.judged} evidence blocks kept in this batch.`;
      stage("Selecting source evidence", detail);
      break;
    case "explain_edges":
      state.edges += data.kept;
      recordFiles([], "traced");
      detail = `${data.kept} of ${data.judged} source references kept in this batch.`;
      stage("Checking the connections", detail);
      break;
    case "expand":
      recordFiles(
        data.options.filter((o) => o.kind === "file").map((o) => o.path),
        "retrieved",
      );
      detail = `Examined ${data.path || "/"} at step ${data.step}.`;
      stage("Exploring another directory", detail);
      break;
    case "escalate":
      detail = `First pass was ${data.reason}; expanding from the scope root and ${data.seeds.length} additional search anchors.`;
      stage("Broadening the search", detail);
      break;
    case "terms":
      detail = `${data.accepted.length} repository terms accepted.`;
      break;
    case "beam":
      detail = `${data.candidates.length} paths remain in the search frontier.`;
      break;
    case "prune":
      detail = `Pruned ${data.path}: ${data.reason}.`;
      break;
    case "backtrack":
      detail = `Backtracked from ${data.from} to ${data.to || "/"}.`;
      break;
    case "warning":
      detail = data.warning.message;
      stage("Search continuing with a limitation", detail);
      break;
    case "error":
      fail(data.message || "The search could not finish.");
      return;
    case "done":
    case "explain_done":
      finish(data.result, query);
      return;
  }
  if (detail) logStep(detail);
}
function finish(result, query) {
  closeStream();
  document.body.dataset.search = "complete";
  $("activity").dataset.state = "complete";
  stage("Search complete", "");
  if (state.recordable)
    saveRun({ repo: state.repo, query, events: state.events });
  else saveRun({ repo: "", query: "", events: [] });
  playgroundLink(query, true);
  $("searchResults").hidden = false;
  const stats = result.stats;
  const cost = Number(stats.estCostUsd);
  text(
    "runStats",
    `${(stats.wallMs / 1000).toFixed(1)}s · ${stats.calls} model calls\n${state.cached ? "Cached run · original estimated cost" : "Estimated model cost"} $${cost < 0.001 ? cost.toFixed(5) : cost.toFixed(4)}`,
  );
  text(
    "activityLabel",
    state.cached ? "Cached search · original events" : "Completed search",
  );
  if (result.graph) {
    const graph = result.graph;
    text("resultKind", "Source flow");
    text(
      "resultTitle",
      graph.verdict === "absent"
        ? "No supported flow found"
        : graph.verdict === "partial"
          ? "A partial view of the flow"
          : "Follow the source",
    );
    text(
      "resultNote",
      `${graph.nodes.filter((n) => n.kind !== "package").length} units · ${graph.edges.length} references. This is a bounded static view, not a runtime trace.${graph.dropped?.nodes || graph.dropped?.edges ? ` Omitted by limits: ${graph.dropped.nodes} nodes, ${graph.dropped.edges} edges.` : ""}`,
    );
    if (graph.nodes.length) {
      $("simpleFlow").hidden = false;
      state.flow = renderFlow($("simpleFlow"), graph, {
        walkthroughCollapsed: true,
        onSelect: (id) => {
          const node = graph.nodes.find((n) => n.id === id);
          if (node && node.kind !== "package" && node.kind !== "group")
            preview(node.path, node.evidence?.[0]?.line || 1);
        },
        onOpen: (path, line) => preview(path, line),
      });
    }
  } else {
    text("resultKind", "Source files");
    text(
      "resultTitle",
      result.verdict === "absent"
        ? "No confident match found"
        : result.verdict === "partial"
          ? "Possible places to start"
          : "Start here",
    );
    text(
      "resultNote",
      result.verdict === "found"
        ? "Ranked by relevance. Open a file to inspect the actual source."
        : "These candidates need your review. The search has not established a confident answer.",
    );
    const rows = result.results || [];
    let shown = 0;
    const more = element("button", "text-button");
    more.type = "button";
    const appendRows = () => {
      for (const [i, row] of rows.slice(shown, shown + 5).entries()) {
        const article = element("article", "file-result");
        article.append(
          element(
            "span",
            "result-number",
            String(shown + i + 1).padStart(2, "0"),
          ),
        );
        const button = element("button");
        button.type = "button";
        button.append(
          element("span", "file-name", row.path.split("/").at(-1)),
          element("span", "file-location", row.path),
        );
        button.addEventListener("click", () => preview(row.path));
        article.append(
          button,
          element(
            "span",
            "file-confidence",
            `${Math.round((row.verify ?? row.score) * 100)}% ${row.verify === undefined ? "rank score" : "match judgment"}`,
          ),
        );
        $("fileResults").append(article);
      }
      shown = Math.min(rows.length, shown + 5);
      more.remove();
      if (shown < rows.length) {
        more.textContent = `Show ${Math.min(5, rows.length - shown)} more (${rows.length - shown} remaining)`;
        $("fileResults").append(more);
      }
    };
    more.addEventListener("click", appendRows);
    appendRows();
    if (!rows.length)
      text(
        "resultNote",
        "Try naming a feature, function or behavior. A broader subject may need a more specific question.",
      );
  }
  if (result.warnings?.length) {
    text(
      "resultNote",
      $("resultNote").textContent +
        " " +
        result.warnings.map((w) => w.message).join(" "),
    );
    stage("Completed with a limitation", "");
  }
  $("resultTitle").focus({ preventScroll: true });
}
async function preview(path, line = 1) {
  const version = ++state.previewVersion,
    id = state.repo;
  state.sourceAbort?.abort();
  const controller = new AbortController();
  state.sourceAbort = controller;
  const from = Math.max(1, line - 8),
    to = from + 99;
  state.preview = { path, from, to, total: 0 };
  text("sourceTitle", path);
  text("sourceCode", "Loading source…");
  text("sourceMeta", "");
  $("previousSource").disabled = true;
  $("nextSource").disabled = true;
  $("sourceExternal").hidden = true;
  if (!$("sourceDialog").open) $("sourceDialog").showModal();
  try {
    const url = new URL("/api/file", location.origin);
    for (const [key, value] of Object.entries({ repo: id, path, from, to }))
      url.searchParams.set(key, String(value));
    const response = await fetch(url, {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
    });
    const data = await response.json();
    if (version !== state.previewVersion || state.repo !== id) return;
    if (!response.ok)
      throw new Error(data.error || "Could not load this source file.");
    if (!Array.isArray(data.lines))
      throw new Error("The source response is invalid.");
    // Older servers may return only the head: never label that as a deep window.
    const actualFrom = data.from ?? 1;
    state.preview = {
      path,
      from: actualFrom,
      to: actualFrom + data.lines.length - 1,
      total: data.total || data.lines.length,
    };
    text(
      "sourceMeta",
      `Lines ${actualFrom}–${state.preview.to}${data.total ? ` of ${data.total}` : ""}${data.from === undefined && from > 1 ? " · server returned the file head" : ""}`,
    );
    text(
      "sourceCode",
      data.lines
        .map((line, i) => `${String(actualFrom + i).padStart(4)}  ${line}`)
        .join("\n"),
    );
    $("previousSource").disabled = actualFrom <= 1;
    $("nextSource").disabled = !data.total || state.preview.to >= data.total;
    if (/^https:\/\/github\.com\//.test(repo()?.url || "") && repo().revision) {
      $("sourceExternal").href =
        `${repo().url}/blob/${encodeURIComponent(repo().revision)}/${path.split("/").map(encodeURIComponent).join("/")}#L${line}`;
      $("sourceExternal").hidden = false;
    }
  } catch (error) {
    if (version === state.previewVersion && !controller.signal.aborted)
      text("sourceCode", error.message);
  }
}
$("searchForm").addEventListener("submit", (event) => {
  event.preventDefault();
  startSearch();
});
$("repository").addEventListener("change", () =>
  chooseRepo($("repository").value),
);
$("question").addEventListener("input", () =>
  playgroundLink($("question").value.trim()),
);
$("stopSearch").addEventListener("click", () => {
  closeStream();
  state.generation++;
  $("activity").dataset.state = "cancelled";
  stage("Search cancelled", "No completed answer was received.");
  $("retrySearch").hidden = false;
});
$("retrySearch").addEventListener("click", () =>
  state.repos.length ? startSearch() : boot(),
);
$("closeSource").addEventListener("click", () => $("sourceDialog").close());
$("sourceDialog").addEventListener("close", () => {
  state.sourceAbort?.abort();
  state.previewVersion++;
});
$("previousSource").addEventListener("click", () =>
  preview(state.preview.path, Math.max(1, state.preview.from - 100) + 8),
);
$("nextSource").addEventListener("click", () =>
  preview(state.preview.path, state.preview.to + 9),
);
window.addEventListener("pagehide", () => {
  closeStream();
  state.sourceAbort?.abort();
});
boot();
