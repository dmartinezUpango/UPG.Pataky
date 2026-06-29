/*
 * Zoom controls for Mermaid diagrams under MkDocs Material.
 *
 * IMPORTANT — two things make this tricky:
 *
 * 1. Material renders each Mermaid diagram by REPLACING the original
 *    `<pre class="mermaid">` with a fresh `<div class="mermaid">` whose SVG
 *    lives inside a CLOSED shadow root (attachShadow({mode:"closed"})).
 *    That shadow root is unreachable from outside, so we cannot touch the
 *    SVG or its viewBox. Instead we apply CSS `transform: scale()` to the
 *    host <div> itself — transforms cascade into shadow DOM content.
 *
 * 2. Many diagrams live inside the "Estático" tab of a content-tabs block.
 *    When that tab is not selected it is display:none, so the host reports
 *    offsetHeight === 0 until the tab is shown. We therefore wire up the UI
 *    immediately but capture the diagram's natural size lazily (via a
 *    ResizeObserver) the first time it actually becomes visible.
 */
(function () {
  "use strict";

  const STEP = 1.25;
  const MIN  = 0.5;
  const MAX  = 4;

  function initZoom(host) {
    if (host.dataset.mzoom) return;
    host.dataset.mzoom = "1";

    // Wrapper structure (built now, even if the host is in a hidden tab):
    //   .mermaid-zoom-bar   (the +/-/reset buttons)
    //   .mzoom-viewport     (overflow:auto — provides scroll/pan)
    //     .mzoom-sizer      (reserves baseW*scale × baseH*scale)
    //       .mermaid (host) (transform: scale(scale), origin 0 0)
    const parent = host.parentNode;
    const viewport = document.createElement("div");
    viewport.className = "mzoom-viewport";
    const sizer = document.createElement("div");
    sizer.className = "mzoom-sizer";

    parent.insertBefore(viewport, host);
    viewport.appendChild(sizer);
    sizer.appendChild(host);

    host.style.transformOrigin = "0 0";

    let base = null;   // natural { w, h }, captured once visible
    let scale = 1;

    // Capture the scale-1 footprint the first time the host has real size.
    const ensureBase = function () {
      if (base || !host.offsetWidth || !host.offsetHeight) return false;
      base = { w: host.offsetWidth, h: host.offsetHeight };
      host.style.width = base.w + "px";   // pin width so transform is the
                                          // only thing that scales it
      apply();
      return true;
    };

    const apply = function () {
      if (!base) return;
      host.style.transform = scale === 1 ? "" : "scale(" + scale + ")";
      sizer.style.width  = base.w * scale + "px";
      sizer.style.height = base.h * scale + "px";
    };

    // Fires when the tab becomes visible (0 → real size).
    const ro = new ResizeObserver(function () { ensureBase(); });
    ro.observe(host);
    ensureBase(); // in case it's already visible

    const bar = document.createElement("div");
    bar.className = "mermaid-zoom-bar";
    bar.innerHTML =
      '<button class="mermaid-zoom-btn" data-action="out"   title="Alejar" aria-label="Alejar">−</button>' +
      '<button class="mermaid-zoom-btn" data-action="reset" title="Restablecer" aria-label="Restablecer">↻</button>' +
      '<button class="mermaid-zoom-btn" data-action="in"    title="Acercar" aria-label="Acercar">+</button>';

    bar.addEventListener("click", function (e) {
      const btn = e.target.closest("[data-action]");
      if (!btn) return;
      ensureBase(); // the tab is visible if the user can click — safe to size
      const action = btn.dataset.action;
      if      (action === "in")  scale = Math.min(MAX, scale * STEP);
      else if (action === "out") scale = Math.max(MIN, scale / STEP);
      else                       scale = 1;
      apply();
    });

    parent.insertBefore(bar, viewport);
  }

  // Material replaces <pre class="mermaid"> with <div class="mermaid"> after
  // rendering, so we target the DIV form specifically.
  function scan() {
    document.querySelectorAll("div.mermaid").forEach(initZoom);
  }

  // Debounced rescan driven by DOM mutations (catches Material's async
  // <pre> → <div> swap).
  let raf = 0;
  const debouncedScan = function () {
    if (raf) return;
    raf = requestAnimationFrame(function () { raf = 0; scan(); });
  };

  const mo = new MutationObserver(debouncedScan);
  mo.observe(document.body, { childList: true, subtree: true });

  scan();
  document.addEventListener("DOMContentLoaded", scan);

  // Re-run after instant navigation: content is swapped and Mermaid
  // re-renders fresh hosts that need wiring up again.
  if (typeof document$ !== "undefined") {
    document$.subscribe(function () {
      scan();
      setTimeout(scan, 300);
      setTimeout(scan, 900);
    });
  }
})();
