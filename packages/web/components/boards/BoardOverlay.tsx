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
  // A turned element keeps its rotate handle; resizing it needs the turn undone first.
  const resizable = handlesOn && !turned;
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
        return (
          <svg className="board-overlay-svg" width={1} height={1}>
            <path d={geo.d} className="board-sel-path" />
          </svg>
        );
      })()}
      {all && !onlyConnectors && (
        <div className="board-sel" style={{ left: all.x, top: all.y, width: all.w, height: all.h, }} />
      )}
      {resizable && all && RESIZE.map((h) => (
        <div key={h} data-handle={h} className={`board-handle board-handle-${h}`} style={pos(h, all)} />
      ))}
      {rotatable && all && <div data-handle="rotate" className="board-handle-rotate" style={{ left: all.x + all.w, top: all.y }} />}
      {linkable && all && (["n", "e", "s", "w"] as Handle[]).map((h) => (
        <div key={`c${h}`} data-handle="connect" className={`board-link-dot board-link-${h}`} style={pos(h, all)} />
      ))}

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
