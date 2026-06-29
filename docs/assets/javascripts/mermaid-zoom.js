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

    // Capture original viewBox once Mermaid has set it
    const vb  = svg.viewBox.baseVal;
    const ox  = vb.x, oy = vb.y, ow = vb.width, oh = vb.height;
    if (!ow || !oh) return;

    let scale = 1;

    const apply = () => {
      const nw = ow / scale, nh = oh / scale;
      svg.setAttribute(
        "viewBox",
        `${ox + (ow - nw) / 2} ${oy + (oh - nh) / 2} ${nw} ${nh}`
      );
    };

    // Build toolbar
    const bar = document.createElement("div");
    bar.className = "mermaid-zoom-bar";
    bar.innerHTML = `
      <button class="mermaid-zoom-btn" data-action="out"  title="Alejar">−</button>
      <button class="mermaid-zoom-btn" data-action="reset" title="Restablecer">⟳</button>
      <button class="mermaid-zoom-btn" data-action="in"   title="Acercar">+</button>
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

  function scanPage() {
    document.querySelectorAll(".mermaid").forEach((el) => {
      // Mermaid may not have rendered the SVG yet — observe until it does
      if (el.querySelector("svg")) {
        initZoom(el);
      } else {
        const mo = new MutationObserver(() => {
          if (el.querySelector("svg")) { mo.disconnect(); initZoom(el); }
        });
        mo.observe(el, { childList: true, subtree: true });
      }
    });
  }

  // Initial scan + instant-navigation hook
  if (typeof document$ !== "undefined") {
    document$.subscribe(() => {
      // Reset zoom-ready flags so reinitialisation works after nav
      document.querySelectorAll(".mermaid[data-zoom-ready]").forEach(
        (el) => delete el.dataset.zoomReady
      );
      setTimeout(scanPage, 300);
    });
  }

  document.addEventListener("DOMContentLoaded", () => setTimeout(scanPage, 300));
})();
