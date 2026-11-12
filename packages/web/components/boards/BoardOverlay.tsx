// Everything drawn over the elements in world space: the selection box and
// its handles, snap guides, the marquee, a stroke being drawn, a shape being
// dragged out, a connector being pulled, and what other people and agents
// have selected. Sizes divide by the zoom (--z) so handles stay the same on
// screen at any zoom.
import { memo } from "react";
import { connectorGeometry, elementBounds, elementBox, smoothPath, unionBox, type Box } from "@codecast/shared/artifacts/board";
import type { GestureOverlay, Handle } from "./useBoardGestures";
import type { BoardEl } from "./boardTypes";

export type RemoteSelection = { actor: string; name: string; color: string; keys: string[]; agent: boolean };

const RESIZE: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

function pos(h: Handle, b: Box) {
  const x = h.includes("w") ? b.x : h.includes("e") ? b.x + b.w : b.x + b.w / 2;
  const y = h.includes("n") ? b.y : h.includes("s") ? b.y + b.h : b.y + b.h / 2;
  return { left: x, top: y };
}

function boxOf(el: BoardEl, byKey: Map<string, BoardEl>): Box | null {
  if (el.kind === "connector") return connectorGeometry(el, (k) => byKey.get(k))?.box ?? null;
  return elementBounds(el);
}

function SelectionHandles({ box, resizable, rotatable, linkable }: { box: Box; resizable: boolean; rotatable: boolean; linkable: boolean }) {
  const abs = (style: React.CSSProperties): React.CSSProperties => ({ position: "absolute", ...style });
  return (
    <>
      {resizable && RESIZE.map((h) => (
        <div key={h} data-handle={h} className={`board-handle board-handle-${h}`} style={abs(pos(h, box))} />
      ))}
      {rotatable && <div data-handle="rotate" className="board-handle-rotate" style={abs({ left: box.x + box.w, top: box.y })} />}
      {linkable && (["n", "e", "s", "w"] as Handle[]).map((h) => (
        <div key={`c${h}`} data-handle="connect" className={`board-link-dot board-link-${h}`} style={abs(pos(h, box))} />
      ))}
    </>
  );
}

export const BoardOverlay = memo(function BoardOverlay({ selection, byKey, gesture, remote, editing, readOnly, showHandles }: {
  selection: string[];
  byKey: Map<string, BoardEl>;
  gesture: GestureOverlay;
  remote: RemoteSelection[];
  editing: string | null;
  readOnly: boolean;
  showHandles: boolean;
}) {
  const sel = selection.map((k) => byKey.get(k)).filter(Boolean) as BoardEl[];
  const boxes = sel.map((el) => boxOf(el, byKey)).filter(Boolean) as Box[];
  const all = unionBox(boxes);
  const single = sel.length === 1 ? sel[0] : null;
  const onlyConnectors = sel.length > 0 && sel.every((e) => e.kind === "connector");
  const turned = !!single && typeof single.rot === "number" && single.rot % 180 !== 0;
  const handlesOn = !readOnly && showHandles && !!all && !onlyConnectors && !editing;
  const resizable = handlesOn;
  const rotatable = handlesOn && single && ["sticky", "shape", "text", "image", "stamp", "card"].includes(single.kind);
  const linkable = handlesOn && single && single.kind !== "pen" && single.kind !== "frame";
  return (
    <div className="board-overlay" aria-hidden>
      {remote.map((r) => {
        const rb = r.keys.map((k) => byKey.get(k)).filter(Boolean).map((el) => boxOf(el as BoardEl, byKey)).filter(Boolean) as Box[];
        const u = unionBox(rb);
        if (!u) return null;
        return (
          <div key={r.actor} className={`board-remote-sel${r.agent ? " is-agent" : ""}`} style={{ left: u.x, top: u.y, width: u.w, height: u.h, ["--who" as any]: r.color }}>
          </div>
        );
      })}

      {sel.length > 1 && boxes.map((b, i) => (
        <div key={sel[i].key} className="board-sel-item" style={{ left: b.x, top: b.y, width: b.w, height: b.h }} />
      ))}
      {single?.kind === "connector" && (() => {
        const geo = connectorGeometry(single, (k) => byKey.get(k));
        if (!geo) return null;
        // Each end shows whether it holds on to something (filled) or is loose (hollow).
        const attachedA = typeof single.from === "string", attachedB = typeof single.to === "string";
        return (
          <svg className="board-overlay-svg" width={1} height={1}>
            <path d={geo.d} className="board-sel-path" />
            <circle cx={geo.a.x} cy={geo.a.y} className={`board-end${attachedA ? " is-attached" : ""}`} />
            <circle cx={geo.b.x} cy={geo.b.y} className={`board-end${attachedB ? " is-attached" : ""}`} />
          </svg>
        );
      })()}
      {turned && single ? (() => {
        // A turned element: the outline and its handles turn with it, so each handle drags the edge it sits on.
        const b = elementBox(single);
        const local = { x: 0, y: 0, w: b.w, h: b.h };
        return (
          <div style={{ left: b.x, top: b.y, width: b.w, height: b.h, transform: `rotate(${single.rot}deg)` }}>
            <div className="board-sel" style={{ position: "absolute", inset: 0 }} />
            <SelectionHandles box={local} resizable={resizable} rotatable={!!rotatable} linkable={!!linkable} />
          </div>
        );
      })() : (
        <>
          {all && !onlyConnectors && (
            <div className="board-sel" style={{ left: all.x, top: all.y, width: all.w, height: all.h, }} />
          )}
          {all && <SelectionHandles box={all} resizable={resizable} rotatable={!!rotatable} linkable={!!linkable} />}
        </>
      )}

      {gesture.guides.map((g, i) => (
        <div
          key={i}
          className="board-guide"
          style={g.axis === "x" ? { left: g.at, top: g.from, height: g.to - g.from, width: 0 } : { left: g.from, top: g.at, width: g.to - g.from, height: 0 }}
        />
      ))}
      {gesture.marquee && <div className="board-marquee" style={{ left: gesture.marquee.x, top: gesture.marquee.y, width: gesture.marquee.w, height: gesture.marquee.h }} />}
      {gesture.draft && <div className="board-draft" style={{ left: gesture.draft.x, top: gesture.draft.y, width: gesture.draft.w, height: gesture.draft.h }} />}
      {gesture.pen && (
        <svg className="board-overlay-svg" width={1} height={1}>
          <path d={smoothPath(gesture.pen)} className="board-pen-live" />
        </svg>
      )}
      {gesture.link && (
        <>
          {gesture.link.over && byKey.get(gesture.link.over) && (() => {
            const b = elementBox(byKey.get(gesture.link!.over!)!);
            return <div className="board-link-target" style={{ left: b.x, top: b.y, width: b.w, height: b.h }} />;
          })()}
          <svg className="board-overlay-svg" width={1} height={1}>
            <path d={`M${gesture.link.a.x},${gesture.link.a.y} L${gesture.link.b.x},${gesture.link.b.y}`} className="board-link-live" />
          </svg>
        </>
      )}
    </div>
  );
});
