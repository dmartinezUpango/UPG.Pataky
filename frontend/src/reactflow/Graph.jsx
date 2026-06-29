import React, { useRef, useEffect, useState, useCallback } from "react";
import { ReactFlow, MiniMap, Controls, Background } from "reactflow";
import "reactflow/dist/style.css";

export default function Graph({ nodes, edges, height }) {
  const containerRef = useRef(null);
  const [rfKey, setRfKey] = useState(0);

  // When the container transitions hidden→visible (tab switch), remount ReactFlow
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

  // onInit fires once ReactFlow has fully initialized.
  // We call fitView with delays to handle any layout-settling after mount.
  // We check c.isConnected before each delayed call to avoid running on
  // a stale instance after the component has been unmounted and replaced.
  const handleInit = useCallback((instance) => {
    const c = containerRef.current;
    instance.fitView();
    setTimeout(() => { if (c?.isConnected) instance.fitView(); }, 150);
    setTimeout(() => { if (c?.isConnected) instance.fitView(); }, 400);
  }, []);

  return (
    <div ref={containerRef} style={{ width: "100%", height: height || 500 }}>
      <ReactFlow
        key={rfKey}
        defaultNodes={nodes}
        defaultEdges={edges}
        fitView
        onInit={handleInit}
        zoomOnScroll
        panOnScroll
        zoomOnPinch
      >
        <MiniMap />
        <Controls />
        <Background />
      </ReactFlow>
    </div>
  );
}
