import { useMemo } from "react";
import { connectorGeometry, elementBounds, labelSpot, textWidth, unionBox, type elbowObstacles } from "@codecast/shared/artifacts/board";
import type { BoardEl } from "./boardTypes";
import { plainText } from "./boardMarks";
import type { useBoardCamera } from "./useBoardCamera";

// Where the selection bar and the text format bar sit (screen space, over the
// selection), and what a screen reader hears when the selection moves.
export function useBoardSelectionChrome({ selectedEls, byKey, obstacles, editing, readOnly, viewport }: {
  selectedEls: BoardEl[];
  byKey: Map<string, BoardEl>;
  obstacles: ReturnType<typeof elbowObstacles>;
  editing: string | null;
  readOnly: boolean;
  viewport: ReturnType<typeof useBoardCamera>["viewport"];
}) {
  const vcam = viewport.cam;
  // ── Selection bar placement (screen space, above the selection) ───────────
  const selBox = useMemo(() => {
    // A connector's bar clears the elements it joins, so it never sits on them.
    const boxes = selectedEls.flatMap((e) => {
      if (e.kind !== "connector") return [elementBounds(e)];
      const ends = [e.from, e.to].map((k) => (typeof k === "string" ? byKey.get(k) : undefined)).filter(Boolean).map((x) => elementBounds(x!));
      // Routed as the canvas draws it (an elbow goes around obstacles), with its label's chip.
      const g = connectorGeometry(e, (k) => byKey.get(k), e.curve === "elbow" ? obstacles : undefined);
      const label = typeof e.label === "string" ? e.label : "";
      const at = g && label ? labelSpot(g, label) : null;
      const lw = textWidth(label, 15) + 16;
      return [...ends, ...(g ? [g.box] : []), ...(at ? [{ x: at.x - lw / 2, y: at.y - 12, w: lw, h: 24 }] : [])];
    });
    return unionBox(boxes);
  }, [selectedEls, byKey, obstacles]);
  const barAt = useMemo(() => {
    if (!selBox || !viewport.w) return null;
    const top = selBox.y * vcam.z + vcam.y, bottom = (selBox.y + selBox.h) * vcam.z + vcam.y;
    const x = (selBox.x + selBox.w / 2) * vcam.z + vcam.x;
    const below = top < 90;
    // 34px clears the rotate handle that sits above the selection's top-right corner.
    return { x, y: below ? Math.min(bottom + 34, viewport.h - 120) : top - 34, below };
  }, [selBox, vcam, viewport.w, viewport.h]);

  // Where the format bar sits while text is being edited: above the element, like the selection bar.
  const editAt = useMemo(() => {
    const el = editing ? byKey.get(editing) : undefined;
    if (!el || readOnly || el.kind === "frame" || el.kind === "connector" || !viewport.w) return null;
    const b = elementBounds(el);
    const top = b.y * vcam.z + vcam.y;
    return { x: (b.x + b.w / 2) * vcam.z + vcam.x, y: Math.max(48, top - 12) };
  }, [editing, byKey, vcam, readOnly, viewport.w]);
  // What a screen reader hears when the selection moves.
  const announce = useMemo(() => {
    if (selectedEls.length !== 1) return selectedEls.length ? `${selectedEls.length} selected` : "";
    const e = selectedEls[0];
    const words = plainText(String(e.text ?? e.title ?? e.label ?? e.ref ?? e.emoji ?? "")).replace(/\s+/g, " ").slice(0, 120);
    return `${e.kind}${e.shape ? ` ${e.shape}` : ""}${words ? `: ${words}` : ""}`;
  }, [selectedEls]);
  return { barAt, editAt, announce };
}
