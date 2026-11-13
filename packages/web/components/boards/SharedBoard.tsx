// A board opened from its share link: the saved layer, read only, framed on its
// content at the page's width. No toolbar, cursors, comments or selection.
import "./board.css";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Minus, Plus, Scan } from "lucide-react";
import { elbowObstacles } from "@codecast/shared/artifacts/board";
import type { LiveSharedViewProps } from "../live/registry";
import { BoardElementView, ConnectorView } from "./BoardElements";
import { drawOrder, fitBox } from "./boardFrame";
import type { BoardEl } from "./boardTypes";

const NOOP = () => {};
const MARGIN = 32;
const MIN_Z = 0.25;
const MAX_Z = 2;
const STEPS = [0.25, 0.33, 0.5, 0.67, 0.8, 1, 1.25, 1.5, 2];

export default function SharedBoard({ elements }: LiveSharedViewProps) {
  // The workshop state (kind "session") is never drawn.
  const els = useMemo(() => (elements as BoardEl[]).filter((e) => e.kind !== "session"), [elements]);
  const byKey = useMemo(() => new Map(els.map((e) => [e.key, e])), [els]);
  const ordered = useMemo(() => drawOrder(els), [els]);
  const box = useMemo(() => fitBox(els, byKey), [els, byKey]);
  const obstacles = useMemo(() => elbowObstacles(els), [els]);
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // It opens fitted to the page's width; the reader zooms in to read a note
  // and the board scrolls sideways past the page.
  const [zoom, setZoom] = useState<number | null>(null);
  const fitZ = box && width ? Math.max(MIN_Z, Math.min(1, (width - MARGIN * 2) / Math.max(box.w, 1))) : 0;
  const z = zoom ?? fitZ;
  const step = (dir: 1 | -1) => {
    const next = dir > 0 ? STEPS.find((v) => v > z + 0.01) : [...STEPS].reverse().find((v) => v < z - 0.01);
    setZoom(Math.min(MAX_Z, Math.max(MIN_Z, next ?? z)));
  };
  const innerW = box ? Math.max(width, Math.ceil(box.w * z + MARGIN * 2)) : width;
  const height = box ? Math.ceil(box.h * z + MARGIN * 2) : 0;
  const x = box ? innerW / 2 - (box.x + box.w / 2) * z : 0;
  const y = box ? MARGIN - box.y * z : 0;

  return (
    <div ref={ref} className="w-full" data-shared-board>
      {!box ? (
        <div className="py-24 text-center text-sm text-sol-text-dim">Empty board</div>
      ) : width > 0 ? (
        <div className="relative">
        <div className="board-zoom" style={{ boxShadow: "0 1px 2px rgb(0 0 0 / 0.08)" }}>
          <button type="button" className="board-bar-btn" aria-label="Zoom out" onClick={() => step(-1)}><Minus size={14} strokeWidth={1.75} /></button>
          <button type="button" className="board-zoom-pct" aria-label="Zoom to 100%" onClick={() => setZoom(1)}>{Math.round(z * 100)}%</button>
          <button type="button" className="board-bar-btn" aria-label="Zoom in" onClick={() => step(1)}><Plus size={14} strokeWidth={1.75} /></button>
          <button type="button" className="board-bar-btn" aria-label="Fit" onClick={() => setZoom(null)}><Scan size={14} strokeWidth={1.75} /></button>
        </div>
        <div className="overflow-x-auto rounded-xl border border-sol-border/50">
          <div className="board-root is-readonly" style={{ height, width: innerW, touchAction: "auto" }}>
            <div className="board-grid" aria-hidden style={{ backgroundSize: `${24 * z * (z < 0.5 ? 2 : 1)}px ${24 * z * (z < 0.5 ? 2 : 1)}px`, backgroundPosition: `${x}px ${y}px` }} />
            <div className="board-world" style={{ transform: `translate3d(${x}px, ${y}px, 0) scale(${z})` }}>
              {ordered.map((el) =>
                el.kind === "connector" ? (
                  <ConnectorView
                    key={el.key}
                    el={el}
                    from={typeof el.from === "string" ? byKey.get(el.from) : undefined}
                    to={typeof el.to === "string" ? byKey.get(el.to) : undefined}
                    obstacles={el.curve === "elbow" ? obstacles : undefined}
                    editing={false}
                    onEditInput={NOOP}
                    onEditDone={NOOP}
                  />
                ) : (
                  <BoardElementView key={el.key} el={el} editing={false} onEditInput={NOOP} onEditDone={NOOP} />
                ),
              )}
            </div>
          </div>
        </div>
        </div>
      ) : null}
    </div>
  );
}
