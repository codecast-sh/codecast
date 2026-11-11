// The foundation's proof board: stickies on a dotted canvas. Drag, add,
// edit and delete go through the live handle (preview + commit for gestures).
// The Boards product (ct-91884) replaces this view in components/live/registry.ts.
import { memo, useEffect, useRef, useState } from "react";
import { newElementKey, type ArtifactElement } from "@codecast/shared/artifacts";
import { useLiveElements } from "../useLiveArtifact";
import type { LiveViewProps } from "../registry";

const W = 200;
const H = 140;
const COLORS: Record<string, string> = { yellow: "var(--sol-yellow)", green: "var(--sol-green)", blue: "var(--sol-blue)", red: "var(--sol-red)", violet: "var(--sol-violet)" };

export default function MinimalBoardView({ doc, live, selection, setSelection, mode, snapshot, toScreen }: LiveViewProps) {
  const liveEls = useLiveElements(doc._id);
  const elements = snapshot ?? liveEls;
  const byKey = useRef(new Map<string, ArtifactElement>());
  byKey.current = new Map(elements.map((e) => [e.key, e]));
  const ref = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState({ x: 0, y: 0 });
  const editable = mode === "edit";

  useEffect(() => {
    toScreen((pos) => {
      if (pos.point) return { x: pos.point.x - scroll.x, y: pos.point.y - scroll.y };
      const el = pos.key ? byKey.current.get(pos.key) : undefined;
      if (el && typeof el.x === "number" && typeof el.y === "number") {
        return { x: el.x - scroll.x, y: el.y - scroll.y, w: Number(el.w ?? W), h: Number(el.h ?? H) };
      }
      return null;
    });
  }, [toScreen, scroll, elements]);

  const point = (e: { clientX: number; clientY: number }) => {
    const r = ref.current!.getBoundingClientRect();
    return { x: Math.round(e.clientX - r.left + scroll.x), y: Math.round(e.clientY - r.top + scroll.y) };
  };

  useEffect(() => {
    if (!editable) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (/^(INPUT|TEXTAREA)$/.test(t.tagName)) return;
      if ((e.key === "Delete" || e.key === "Backspace") && selection.length) {
        live.apply(selection.map((k) => ({ k, del: true })));
        setSelection([]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editable, selection, live, setSelection]);

  return (
    <div
      ref={ref}
      data-live-board
      className="absolute inset-0 overflow-auto"
      style={{ backgroundImage: "radial-gradient(circle, color-mix(in srgb, var(--sol-text-dim) 35%, transparent) 1px, transparent 1px)", backgroundSize: "24px 24px" }}
      onScroll={(e) => setScroll({ x: e.currentTarget.scrollLeft, y: e.currentTarget.scrollTop })}
      onPointerMove={(e) => live.setPresence({ position: { point: point(e) }, selection })}
      onPointerDown={(e) => { if (!(e.target as HTMLElement).closest("[data-live-el]")) setSelection([]); }}
      onDoubleClick={(e) => {
        if (!editable || (e.target as HTMLElement).closest("[data-live-el]")) return;
        const p = point(e);
        const k = newElementKey("el");
        live.apply([{ k, put: { kind: "sticky", x: p.x - W / 2, y: p.y - H / 2, w: W, h: H, text: "", color: "yellow" } }]);
        setSelection([k]);
      }}
    >
      <div className="relative" style={{ width: 4000, height: 3000 }}>
        {elements.filter((e) => e.kind === "sticky").map((el) => (
          <Sticky key={el.key} el={el} selected={selection.includes(el.key)} editable={editable} live={live} onSelect={() => setSelection([el.key])} />
        ))}
      </div>
    </div>
  );
}

const Sticky = memo(function Sticky({ el, selected, editable, live, onSelect }: { el: ArtifactElement; selected: boolean; editable: boolean; live: LiveViewProps["live"]; onSelect: () => void }) {
  const [editing, setEditing] = useState(false);
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const color = COLORS[String(el.color ?? "yellow")] ?? COLORS.yellow;
  return (
    <div
      data-live-el={el.key}
      className={`absolute rounded-md p-3 text-sm shadow-md select-none ${selected ? "ring-2 ring-sol-blue" : ""}`}
      style={{ left: Number(el.x), top: Number(el.y), width: Number(el.w ?? W), height: Number(el.h ?? H), background: `color-mix(in srgb, ${color} 30%, var(--sol-bg))`, color: "var(--sol-text)" }}
      onPointerDown={(e) => {
        e.stopPropagation();
        onSelect();
        if (!editable || editing) return;
        (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
        drag.current = { x: e.clientX, y: e.clientY, ox: Number(el.x), oy: Number(el.y) };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        live.preview([{ k: el.key, set: { x: Math.round(d.ox + e.clientX - d.x), y: Math.round(d.oy + e.clientY - d.y) } }]);
      }}
      onPointerUp={() => { if (drag.current) { drag.current = null; live.commit(); } }}
      onDoubleClick={(e) => { e.stopPropagation(); if (editable) setEditing(true); }}
    >
      {editing ? (
        <textarea
          autoFocus
          data-live-sticky-input
          defaultValue={String(el.text ?? "")}
          onChange={(e) => live.preview([{ k: el.key, set: { text: e.target.value } }])}
          onBlur={() => { live.commit(); setEditing(false); }}
          onKeyDown={(e) => { if (e.key === "Escape") (e.target as HTMLTextAreaElement).blur(); }}
          className="w-full h-full resize-none bg-transparent outline-none"
        />
      ) : (
        <div className="whitespace-pre-wrap break-words h-full overflow-hidden">{String(el.text ?? "")}</div>
      )}
    </div>
  );
});
