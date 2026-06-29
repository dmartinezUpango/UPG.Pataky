import React, { useRef, useEffect, useState, useCallback, useMemo } from "react";
import {
  ReactFlow,
  Controls,
  Background,
  MarkerType,
  Position,
} from "reactflow";
import dagre from "@dagrejs/dagre";
import "reactflow/dist/style.css";

const NODE_H = 44;

// Rough width estimate from the label so dagre reserves enough room and
// nodes/edges don't overlap (mirrors how Mermaid sizes its boxes).
const estimateWidth = (label) =>
  Math.max(150, Math.min(340, String(label || "").length * 8 + 36));

// Run dagre to assign non-overlapping positions, ignoring any manual
// coordinates that came in the JSON. Direction defaults to left→right (LR)
// to match the Mermaid `flowchart LR` view.
function layout(nodes, edges, dir) {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: dir, nodesep: 45, ranksep: 90, marginx: 16, marginy: 16 });

  nodes.forEach((n) => {
    g.setNode(n.id, { width: estimateWidth(n.data?.label), height: NODE_H });
  });
  edges.forEach((e) => g.setEdge(e.source, e.target));

  dagre.layout(g);

  const horizontal = dir === "LR" || dir === "RL";
  return nodes.map((n) => {
    const gn = g.node(n.id);
    const clickable = !!n.data?.url;
    const label = clickable ? `${n.data.label}  ↗` : n.data?.label;
    return {
      ...n,
      data: { ...n.data, label },
      className: [n.className, clickable ? "rf-clickable" : ""]
        .filter(Boolean)
        .join(" "),
      sourcePosition: horizontal ? Position.Right : Position.Bottom,
      targetPosition: horizontal ? Position.Left : Position.Top,
      position: { x: gn.x - gn.width / 2, y: gn.y - gn.height / 2 },
      style: { ...n.style, width: gn.width },
    };
  });
}

// Give every edge an arrowhead so the flow direction reads clearly.
const decorateEdges = (edges) =>
  edges.map((e) => ({
    markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18 },
    ...e,
  }));

export default function Graph({ nodes, edges, height, direction }) {
  const containerRef = useRef(null);
  const [rfKey, setRfKey] = useState(0);

  const dir = direction || "LR";
  const laidOutNodes = useMemo(() => layout(nodes, edges, dir), [nodes, edges, dir]);
  const decoratedEdges = useMemo(() => decorateEdges(edges), [edges]);

  // When the container transitions hidden→visible (tab switch), remount
  // ReactFlow so fitView measures against the real, visible size.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let wasHidden = container.offsetWidth === 0;
    const observer = new ResizeObserver(() => {
      const isVisible = container.offsetWidth > 0;
      if (wasHidden && isVisible) setRfKey((k) => k + 1);
      wasHidden = !isVisible;
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const handleInit = useCallback((instance) => {
    const c = containerRef.current;
    instance.fitView();
    setTimeout(() => { if (c?.isConnected) instance.fitView(); }, 150);
    setTimeout(() => { if (c?.isConnected) instance.fitView(); }, 400);
  }, []);

  // Navigate to a node's documentation section when it carries a url.
  // The url is relative to the current page (e.g. "../wf-pedidos-metodos/#…"),
  // resolved against location so it works under any GitHub Pages base path.
  const handleNodeClick = useCallback((_evt, node) => {
    const url = node?.data?.url;
    if (!url) return;
    window.location.href = new URL(url, window.location.href).href;
  }, []);

  return (
    <div ref={containerRef} style={{ width: "100%", height: height || 500 }}>
      <ReactFlow
        key={rfKey}
        defaultNodes={laidOutNodes}
        defaultEdges={decoratedEdges}
        fitView
        onInit={handleInit}
        onNodeClick={handleNodeClick}
        zoomOnScroll
        panOnScroll
        zoomOnPinch
        nodesDraggable={false}
        nodesConnectable={false}
      >
        <Controls />
        <Background />
      </ReactFlow>
    </div>
  );
}
