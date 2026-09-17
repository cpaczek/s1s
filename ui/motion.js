// @ts-check
/** @typedef {{ id: string, left: number, top: number, width: number, height: number, color: string }} MapBox */
/** @param {{left:number,top:number,width:number,height:number}} box */
function visible(box) {
  return box.width >= 2 && box.height >= 2 && box.left < innerWidth && box.top < innerHeight
    && box.left + box.width > 0 && box.top + box.height > 0;
}

/** Move only matching, visible source-file boxes into their real rendered graph nodes.
 * The interface remains interactive; cancellation/reduced-motion never delays a result.
 * @param {MapBox[]} sources
 * @param {HTMLElement} host
 * @returns {() => void}
 */
export function animateMapToFlow(sources, host) {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches || !Element.prototype.animate) return () => {};
  const byId = new Map(sources.filter(visible).map(box => [box.id, box]));
  /** @type {Animation[]} */
  const animations = [];
  /** @type {HTMLElement[]} */
  const ghosts = [];
  const events = new AbortController();
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    events.abort();
    for (const animation of animations) animation.cancel();
    for (const ghost of ghosts) ghost.remove();
  };
  for (const node of host.querySelectorAll(".flow-node[data-id]")) {
    const id = node.getAttribute("data-id");
    const source = id ? byId.get(id) : undefined;
    const outline = node.querySelector(".flow-box");
    if (!source || !outline || ghosts.length >= 24) continue;
    const target = outline.getBoundingClientRect();
    if (!visible(target)) continue;
    const ghost = document.createElement("div");
    ghost.className = "map-flow-transition";
    ghost.dataset.sourceId = source.id;
    ghost.setAttribute("aria-hidden", "true");
    Object.assign(ghost.style, {
      position: "fixed", pointerEvents: "none", zIndex: "30", left: `${target.left}px`, top: `${target.top}px`,
      width: `${target.width}px`, height: `${target.height}px`, borderRadius: "3px", boxSizing: "border-box",
      background: source.color, border: "1px solid var(--accent)", transformOrigin: "0 0",
    });
    document.body.append(ghost);
    ghosts.push(ghost);
    animations.push(ghost.animate([
      { transform: `translate(${source.left - target.left}px, ${source.top - target.top}px) scale(${source.width / target.width}, ${source.height / target.height})`, opacity: .72 },
      { transform: "translate(0, 0) scale(1, 1)", opacity: 0 },
    ], { duration: 380, easing: "cubic-bezier(.22,.75,.25,1)", fill: "both" }));
    animations.push(node.animate([{ opacity: .35 }, { opacity: 1 }], { duration: 380, easing: "ease-out" }));
  }
  if (!animations.length) { cleanup(); return () => {}; }
  // Viewport changes invalidate fixed screen coordinates; never leave a detached overlay.
  window.addEventListener("resize", cleanup, { signal: events.signal, passive: true });
  window.addEventListener("scroll", cleanup, { signal: events.signal, passive: true, capture: true });
  void Promise.allSettled(animations.map(animation => animation.finished)).then(cleanup);
  return cleanup;
}
