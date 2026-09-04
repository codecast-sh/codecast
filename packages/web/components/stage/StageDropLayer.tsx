"use client";
// The stage as a drop target, and the grid preview while something hovers.
//
// Wraps a tab's whole stage (plain or split). While a pane-shaped drag is
// over it, the pointer position resolves to a zone — the center of a pane
// ("open here") or one of its edges ("split") — and the preview draws the
// geometry the drop WOULD produce: every current cell at its predicted rect,
// plus the newcomer filled in. Cells are keyed by leaf id and transition
// their percent rects, so moving between zones morphs the whole grid rather
// than flashing highlights. The prediction runs the real split op on the
// real tree (predictDrop), so what you see is what you get.

import { useCallback, useMemo, useRef, useState } from "react";
import type { AppTab } from "../../store/inboxStore";
import {
  findLeaf,
  predictDrop,
  removeLeaf,
  resolveDropZone,
  stageGeometry,
  type DropZone,
  type StageGeometry,
  type StageNode,
} from "../../store/stageSplit";
import {
  activePaneDrag,
  dragCarriesPane,
  performStageDrop,
  readPaneDrop,
  tabStageLayout,
} from "../../lib/stage";
import { pathLabel } from "../../lib/pathLabel";

import { useWatchEffect } from "../../hooks/useWatchEffect";
type Hover = {
  key: string;
  zone: DropZone;
  geometry: StageGeometry;
  /** Null while hovering a dragged pane's own center: the veil stays up (no
   *  blink as the pointer crosses it) but nothing is highlighted — the drop
   *  would be a no-op. */
  newLeafId: string | null;
  title: string | null;
};

/** A plain tab is one pane for drop purposes; its id never reaches the store
 *  (stageInsertLeaf seeds the real first leaf itself). */
const SELF = "__self";

export function StageDropLayer({
  tab,
  enabled,
  children,
}: {
  tab: AppTab;
  enabled: boolean;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const depth = useRef(0);
  const [hover, setHover] = useState<Hover | null>(null);

  const root: StageNode = useMemo(
    () => tabStageLayout(tab) ?? { type: "leaf", id: SELF, path: tab.path },
    [tab.layout, tab.path], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const geo = useMemo(() => stageGeometry(root), [root]);

  const clear = useCallback(() => {
    depth.current = 0;
    setHover(null);
  }, []);

  // A drag that ends anywhere (dropped elsewhere, cancelled with Esc) leaves
  // no dragleave behind for us; the window-level end is the reliable signal.
  // Registered for the whole time the layer is live, not only while a hover
  // is showing — a drag cancelled while the hover was suppressed (its own
  // pane's area) must still reset the depth counter, or the NEXT drag's veil
  // wedges on.
  useWatchEffect(() => {
    if (!enabled) return;
    window.addEventListener("dragend", clear);
    window.addEventListener("drop", clear);
    return () => {
      window.removeEventListener("dragend", clear);
      window.removeEventListener("drop", clear);
    };
  }, [enabled, clear]);

  const onDragEnter = useCallback(
    (e: React.DragEvent) => {
      if (!enabled || !dragCarriesPane(e.dataTransfer)) return;
      e.preventDefault();
      depth.current++;
    },
    [enabled],
  );

  const onDragLeave = useCallback(() => {
    if (depth.current > 0) depth.current--;
    if (depth.current === 0) setHover(null);
  }, []);

  const onDragOver = useCallback(
    (e: React.DragEvent) => {
      if (!enabled || !dragCarriesPane(e.dataTransfer)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const el = ref.current;
      if (!el) return;
      const box = el.getBoundingClientRect();
      let zone = resolveDropZone(geo, { width: box.width, height: box.height }, e.clientX - box.left, e.clientY - box.top);
      if (!zone) { setHover(null); return; }
      const payload = activePaneDrag();
      const path = payload?.path ?? "/__incoming";
      // A MOVE of one of this stage's own panes predicts against the tree
      // WITHOUT the moving pane: the preview then shows exactly the layout
      // the drop produces (never the pane in both places), and the pane cap
      // doesn't count the slot the move frees up.
      const movingLeafId =
        payload?.from?.kind === "leaf" && findLeaf(root, payload.from.leafId) ? payload.from.leafId : null;
      // Any zone on the moving pane itself — its center OR its edges — is a
      // no-op: a pane can't drop into itself. The veil holds steady (no
      // target, no blink) so the gesture reads as "not here", not "nothing".
      if (movingLeafId && "leafId" in zone && zone.leafId === movingLeafId) {
        const key = `self:${movingLeafId}`;
        const selfZone = zone; // const-capture: the closure would widen the `let` back to nullable
        setHover((prev) =>
          prev && prev.key === key
            ? prev
            : { key, zone: selfZone, geometry: geo, newLeafId: null, title: null },
        );
        return;
      }
      const predictionRoot = movingLeafId ? (removeLeaf(root, movingLeafId) ?? root) : root;
      let predicted = predictDrop(predictionRoot, zone, path);
      // At the pane cap an edge can't split; degrade to "open here" so the
      // gesture still means something instead of going dead.
      if (!predicted && zone.kind === "edge") {
        zone = { kind: "center", leafId: zone.leafId };
        predicted = predictDrop(predictionRoot, zone, path);
      }
      if (!predicted) { setHover(null); return; }
      const key = JSON.stringify(zone);
      const title = payload?.title ?? (payload ? pathLabel(payload.path) : null);
      setHover((prev) =>
        prev && prev.key === key
          ? prev
          : { key, zone, geometry: predicted.geometry, newLeafId: predicted.newLeafId, title },
      );
    },
    [enabled, geo, root],
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      if (!enabled) return;
      const dt = e.dataTransfer;
      if (!dt || !dragCarriesPane(dt)) return;
      e.preventDefault();
      e.stopPropagation();
      const h = hover;
      clear();
      const payload = readPaneDrop(dt);
      if (!payload || !h || h.newLeafId === null) return;
      performStageDrop(h.zone, payload);
    },
    [enabled, hover, clear],
  );

  return (
    <div
      ref={ref}
      className="relative h-full"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {children}
      {hover && (
        <div className="stage-drop-veil absolute inset-0 z-40 pointer-events-none" aria-hidden>
          {hover.geometry.leaves.map((l) => {
            const isNew = l.id === hover.newLeafId;
            return (
              <div
                key={l.id}
                className={`stage-drop-cell${isNew ? " stage-drop-cell--target" : ""}`}
                style={{ left: `${l.rect.left}%`, top: `${l.rect.top}%`, width: `${l.rect.width}%`, height: `${l.rect.height}%` }}
              >
                {isNew && (
                  <div className="stage-drop-chip">
                    <span className="stage-drop-chip__verb">{hover.zone.kind === "center" ? "Open here" : "Split"}</span>
                    {hover.title && <span className="stage-drop-chip__title">{hover.title}</span>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
