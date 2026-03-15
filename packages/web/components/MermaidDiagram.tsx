"use client";
import { useEffect, useRef, useState } from "react";
import mermaid from "mermaid";

let initialized = false;

function ensureInit() {
  if (initialized) return;
  initialized = true;
  mermaid.initialize({
    startOnLoad: false,
    theme: "dark",
    themeVariables: {
      darkMode: true,
      background: "#0f1117",
      primaryColor: "#1e2535",
      primaryTextColor: "#c9d1d9",
      primaryBorderColor: "#30363d",
      lineColor: "#8b949e",
      secondaryColor: "#161b22",
      tertiaryColor: "#21262d",
    },
    fontFamily: "inherit",
  });
}

let idCounter = 0;

export function MermaidDiagram({ code }: { code: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const id = useRef(`mermaid-${++idCounter}`);

  useEffect(() => {
    ensureInit();
    let cancelled = false;
    setError(null);

    mermaid.render(id.current, code).then(({ svg }) => {
      if (cancelled || !ref.current) return;
      ref.current.innerHTML = svg;
      const svgEl = ref.current.querySelector("svg");
      if (svgEl) {
        svgEl.style.maxWidth = "100%";
        svgEl.style.height = "auto";
      }
    }).catch((err) => {
      if (cancelled) return;
      setError(err?.message ?? "Failed to render diagram");
    });

    return () => { cancelled = true; };
  }, [code]);

  if (error) {
    return (
      <div className="my-3 rounded border border-red-900/50 bg-red-950/20 px-3 py-2 text-xs text-red-400">
        Diagram error: {error}
      </div>
    );
  }

  return (
    <div
      ref={ref}
      className="my-3 flex justify-center overflow-x-auto rounded border border-sol-border/40 bg-sol-bg-alt p-4"
    />
  );
}
