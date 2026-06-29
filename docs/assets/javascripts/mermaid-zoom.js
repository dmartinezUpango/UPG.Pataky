(function () {
  "use strict";

  const STEP = 1.25;
  const MIN  = 0.25;
  const MAX  = 4;

  function initZoom(wrapper) {
    if (wrapper.dataset.zoomReady) return;
    const svg = wrapper.querySelector("svg");
    if (!svg) return;
    wrapper.dataset.zoomReady = "1";

    const vb = svg.viewBox.baseVal;
    let ox = vb.x, oy = vb.y, ow = vb.width, oh = vb.height;

    // Fallback: read width/height attributes if viewBox is empty
    if (!ow) ow = parseFloat(svg.getAttribute("width"))  || 800;
    if (!oh) oh = parseFloat(svg.getAttribute("height")) || 400;

    console.log("[MZ] initZoom — viewBox:", ox, oy, ow, oh);

    let scale = 1;

    const apply = () => {
      const nw = ow / scale, nh = oh / scale;
      svg.setAttribute(
        "viewBox",
        `${ox + (ow - nw) / 2} ${oy + (oh - nh) / 2} ${nw} ${nh}`
      );
    };

    const bar = document.createElement("div");
    bar.className = "mermaid-zoom-bar";
    bar.innerHTML = `
      <button class="mermaid-zoom-btn" data-action="out"   title="Alejar">−</button>
      <button class="mermaid-zoom-btn" data-action="reset" title="Restablecer">⟳</button>
      <button class="mermaid-zoom-btn" data-action="in"    title="Acercar">+</button>
    `;
    bar.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-action]");
      if (!btn) return;
      if      (btn.dataset.action === "in")    scale = Math.min(MAX, scale * STEP);
      else if (btn.dataset.action === "out")   scale = Math.max(MIN, scale / STEP);
      else                                      scale = 1;
      apply();
    });

    // Insert BEFORE the <pre class="mermaid">, not inside it
    wrapper.parentNode.insertBefore(bar, wrapper);
  }

  function scan() {
    const wrappers = document.querySelectorAll(".mermaid");
    console.log("[MZ] scan — .mermaid elements:", wrappers.length);
    wrappers.forEach((w) => {
      const hasSvg = !!w.querySelector("svg");
      console.log("[MZ]   element:", w.tagName, "has-svg:", hasSvg, "ready:", w.dataset.zoomReady);
      if (hasSvg) initZoom(w);
    });
  }

  // Watch for Mermaid's async SVG injection
  const mo = new MutationObserver(scan);
  mo.observe(document.body, { childList: true, subtree: true });

  // Also scan immediately and on DOMContentLoaded (in case Mermaid ran first)
  scan();
  document.addEventListener("DOMContentLoaded", scan);

  // Reset on instant navigation
  if (typeof document$ !== "undefined") {
    document$.subscribe(() => {
      document.querySelectorAll(".mermaid[data-zoom-ready]").forEach(
        (el) => delete el.dataset.zoomReady
      );
      scan();
    });
  }
})();
