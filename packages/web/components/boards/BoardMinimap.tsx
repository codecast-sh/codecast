// The overview under the zoom control: every element as a small block in its
// color, the part of the board on screen as a frame, and a press or drag that
// moves the view there. It redraws from the throttled viewport, never per frame.
import { memo, useMemo, useRef } from "react";
import { connectorGeometry, elementBounds, unionBox, type Box } from "@codecast/shared/artifacts/board";
import type { BoardCamera } from "./useBoardCamera";
import type { BoardEl } from "./boardTypes";
import { colorToken, stickyFill } from "./boardColors";

const W = 200;
const H = 132;

function fillFor(el: BoardEl): string {
  if (el.kind === "sticky") return stickyFill(el.color);
  if (el.kind === "frame") return `color-mix(in srgb, ${colorToken(el.color, "gray")} 18%, transparent)`;
  if (el.kind === "shape" || el.kind === "text" || el.kind === "pen") return colorToken(el.color, el.kind === "shape" ? "blue" : "gray");
  return "var(--sol-text-dim)";
}

export const BoardMinimap = memo(function BoardMinimap({ elements, byKey, cam }: { elements: BoardEl[]; byKey: Map<string, BoardEl>; cam: BoardCamera }) {
  const content = useMemo(() => unionBox(elements.flatMap((e) => {
    if (e.kind !== "connector") return [elementBounds(e)];
    const g = connectorGeometry(e, (k) => byKey.get(k));
    return g ? [g.box] : [];
  })), [elements, byKey]);
  const view = cam.viewport.world;
  const all = content && view.w ? unionBox([content, view])! : view;
  const pad = Math.max(all.w, all.h) * 0.04;
  const space: Box = { x: all.x - pad, y: all.y - pad, w: all.w + pad * 2, h: all.h + pad * 2 };
  const k = Math.min(W / Math.max(space.w, 1), H / Math.max(space.h, 1));
  const ox = (W - space.w * k) / 2 - space.x * k, oy = (H - space.h * k) / 2 - space.y * k;
  const drag = useRef(false);

  const goTo = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const wx = (e.clientX - r.left - ox) / k, wy = (e.clientY - r.top - oy) / k;
    const c = cam.cam.current, root = cam.rootRef.current;
    if (!root) return;
    cam.set({ z: c.z, x: root.clientWidth / 2 - wx * c.z, y: root.clientHeight / 2 - wy * c.z });
  };

  return (
    <div
      data-board-ui
      style={{ position: "absolute", top: 52, right: 12, zIndex: 20, padding: 4, background: "var(--sol-card)", border: "1px solid var(--sol-border)", borderRadius: 9, boxShadow: "var(--board-chrome-shadow)" }}
    >
      <svg
        width={W}
        height={H}
        role="img"
        aria-label="Board overview"
        style={{ display: "block", cursor: "pointer", touchAction: "none", borderRadius: 6, background: "var(--sol-bg)" }}
        onPointerDown={(e) => { drag.current = true; e.currentTarget.setPointerCapture(e.pointerId); goTo(e); }}
        onPointerMove={(e) => { if (drag.current) goTo(e); }}
        onPointerUp={() => { drag.current = false; }}
        onPointerCancel={() => { drag.current = false; }}
      >
        <g transform={`translate(${ox} ${oy}) scale(${k})`}>
          {elements.map((el) => {
            if (el.kind === "connector") return null;
            const b = elementBounds(el);
            return <rect key={el.key} x={b.x} y={b.y} width={Math.max(b.w, 2 / k)} height={Math.max(b.h, 2 / k)} rx={el.kind === "sticky" ? 2 / k : 0} fill={fillFor(el)} opacity={el.kind === "frame" ? 1 : 0.85} />;
          })}
          {view.w > 0 && (
            <rect x={view.x} y={view.y} width={view.w} height={view.h} fill="color-mix(in srgb, var(--sol-blue) 8%, transparent)" stroke="var(--sol-blue)" strokeWidth={1.5 / k} rx={3 / k} />
          )}
        </g>
      </svg>
    </div>
  );
});
