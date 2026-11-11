// The foundation's proof dashboard: ordered KPI and text blocks. The Data
// product (ct-91886) replaces this view in components/live/registry.ts.
import { useMemo, useRef } from "react";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import { newElementKey } from "@codecast/shared/artifacts";
import { useLiveElements } from "../useLiveArtifact";
import type { LiveViewProps } from "../registry";

export default function MinimalDashboardView({ doc, live, selection, setSelection, mode, snapshot, toScreen, setToolbar }: LiveViewProps) {
  const liveEls = useLiveElements(doc._id);
  const blocks = useMemo(() => [...(snapshot ?? liveEls)].sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0)), [snapshot, liveEls]);
  const box = useRef<HTMLDivElement>(null);
  const editable = mode === "edit";

  useWatchEffect(() => {
    toScreen((pos) => {
      const key = pos.block ?? pos.key;
      const node = key ? box.current?.querySelector<HTMLElement>(`[data-live-el="${CSS.escape(key)}"]`) : null;
      const root = box.current?.parentElement;
      if (!node || !root) return null;
      const r = node.getBoundingClientRect(), o = root.getBoundingClientRect();
      return { x: r.left - o.left, y: r.top - o.top, w: r.width, h: r.height };
    });
  }, [toScreen, blocks]);

  useWatchEffect(() => {
    if (!editable) { setToolbar(null); return; }
    const next = () => (blocks.length ? Math.max(...blocks.map((b) => Number(b.order ?? 0))) + 1 : 1);
    setToolbar(
      <button
        type="button"
        data-live-add-kpi
        onClick={() => live.apply([{ k: newElementKey("b"), put: { kind: "kpi", order: next(), title: "New metric", value: "0" } }])}
        className="h-7 px-2 rounded-md text-xs text-sol-text-muted hover:text-sol-text hover:bg-sol-bg-alt"
      >
        + KPI
      </button>,
    );
    return () => setToolbar(null);
  }, [editable, blocks, live, setToolbar]);

  return (
    <div ref={box} data-live-dashboard className="absolute inset-0 overflow-auto p-6">
      {blocks.length === 0 && <div className="text-sm text-sol-text-dim">No blocks</div>}
      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}>
        {blocks.map((b) => (
          <div
            key={b.key}
            data-live-el={b.key}
            onMouseDown={() => setSelection([b.key])}
            className={`rounded-lg border p-4 bg-sol-card ${selection.includes(b.key) ? "border-sol-blue" : "border-sol-border/40"} ${b.kind === "text" ? "col-span-full" : ""}`}
          >
            {b.kind === "kpi" ? (
              <>
                <div className="text-meta uppercase tracking-wide text-sol-text-dim">{String(b.title ?? "")}</div>
                <div className="mt-1 text-2xl font-semibold text-sol-text tabular-nums">{String(b.value ?? "")}</div>
                {b.delta ? <div className="text-xs text-sol-green">{String(b.delta)}</div> : null}
              </>
            ) : (
              <div className="text-sm text-sol-text whitespace-pre-wrap">{String(b.text ?? b.title ?? "")}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
