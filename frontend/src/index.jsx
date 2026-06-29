import React from "react";
import { createRoot } from "react-dom/client";
import Graph from "./reactflow/Graph";

let _rfRoot = null;
let _rfEl = null;
let _navTimer = null;
let _sub = false;

const _doMount = () => {
  _navTimer = null;
  const dataEl = document.getElementById("reactflow-data");
  const rootEl = document.getElementById("reactflow-root");

  if (!dataEl || !rootEl) {
    if (_rfRoot) {
      try { _rfRoot.unmount(); } catch (_) {}
      _rfRoot = null;
      _rfEl = null;
    }
    return;
  }

  try {
    const data = JSON.parse(dataEl.textContent);
    if (_rfRoot) {
      try { _rfRoot.unmount(); } catch (_) {}
    }
    _rfRoot = createRoot(rootEl);
    _rfEl = rootEl;
    _rfRoot.render(
      <Graph
        nodes={data.nodes || []}
        edges={data.edges || []}
        height={data.height || 500}
      />
    );
  } catch (err) {
    console.error("[ReactFlow] ERROR", err);
  }
};

const _scheduleMount = (delay) => {
  if (_navTimer !== null) clearTimeout(_navTimer);
  _navTimer = setTimeout(_doMount, delay);
};

// --- MkDocs Material instant navigation + initial load ---
// document$ fires immediately on page load AND on every instant navigation.
// This is the single source of truth — no need for DOMContentLoaded when it's active.
const _trySubscribe = () => {
  if (!_sub && typeof document$ !== "undefined") {
    _sub = true;
    document$.subscribe(() => _scheduleMount(200));
  }
};
_trySubscribe();

// --- Fallback when document$ is not available ---
// (only runs if _trySubscribe didn't find document$)
document.addEventListener("DOMContentLoaded", () => {
  _trySubscribe(); // one more try in case MkDocs wasn't ready yet
  if (!_sub) {
    // document$ unavailable — mount once on DOMContentLoaded
    requestAnimationFrame(_doMount);
  }
});

window.addEventListener("load", () => {
  _trySubscribe();
  if (!_sub) {
    // Last resort fallback if still no document$
    _scheduleMount(200);
  }
});

// --- Fallback: intercept history.pushState ---
const _origPushState = history.pushState.bind(history);
history.pushState = function (...args) {
  _origPushState(...args);
  _scheduleMount(400); // debounced — cancelled if document$ fires first
};

// --- Fallback: browser back / forward ---
window.addEventListener("popstate", () => _scheduleMount(400));
