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
    const ox = vb.x, oy = vb.y, ow = vb.width, oh = vb.height;
    if (!ow || !oh) return;

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

    wrapper.style.position = "relative";
    wrapper.insertBefore(bar, wrapper.firstChild);
  }

  // Global observer: fires whenever anything is added to the DOM.
  // Catches Mermaid's async SVG injection regardless of timing.
  const mo = new MutationObserver(() => {
    document.querySelectorAll(".mermaid svg").forEach((svg) => {
      const wrapper = svg.closest(".mermaid");
      if (wrapper) initZoom(wrapper);
    });
  });
  mo.observe(document.body, { childList: true, subtree: true });

  // Re-scan after instant navigation (MkDocs Material)
  if (typeof document$ !== "undefined") {
    document$.subscribe(() => {
      document.querySelectorAll(".mermaid[data-zoom-ready]").forEach(
        (el) => delete el.dataset.zoomReady
      );
    });
  }
})();
