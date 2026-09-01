// The hovered face's words, held for a surface with ONE text slot.
//
// The strip and the floating overlay both draw faces with no room under them
// for a label, so each face DESCRIBES itself as a pointer or focus arrives
// (WallFaceButton's onDescribe) and the surface shows those words in its one
// slot. The dwell is the whole point: both surfaces are CROSSED constantly on
// the way to whatever is behind them, and without it the slot flickers
// through three names on every pass. Focus and a refusal are deliberate, so
// they land immediately, as does an update to the face already shown.
import { useCallback, useRef, useState } from "react";
import { useMountEffect } from "../../hooks/useMountEffect";
import type { FaceDescription } from "./PeopleWall";

/** How long a pointer rests on a face before its name takes over the slot. */
export const HOVER_DWELL_MS = 150;

export function useDescribeSlot(): {
  desc: FaceDescription | null;
  onDescribe: (d: FaceDescription | null, ifShowing?: string) => void;
} {
  const [desc, setDesc] = useState<FaceDescription | null>(null);
  const dwell = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shown = useRef<string | null>(null);
  const onDescribe = useCallback((d: FaceDescription | null, ifShowing?: string) => {
    if (d === null) {
      // A scoped clear (a refusal expiring on a face the pointer already
      // left) only empties the slot if the slot still shows that face.
      if (ifShowing !== undefined && shown.current !== ifShowing) return;
      if (dwell.current) clearTimeout(dwell.current);
      shown.current = null;
      setDesc(null);
      return;
    }
    if (dwell.current) clearTimeout(dwell.current);
    // Already showing this face (a refusal update, or focus after hover), or
    // a refusal — deliberate gestures land with no second dwell: the press
    // that earned a refusal has usually left the face before 150ms pass.
    if (d.refused || shown.current === d.id) {
      shown.current = d.id;
      setDesc(d);
      return;
    }
    dwell.current = setTimeout(() => {
      shown.current = d.id;
      setDesc(d);
    }, HOVER_DWELL_MS);
  }, []);
  useMountEffect(() => {
    // A pointer that leaves the window over a drag gap never delivers its
    // pointerleave; the window losing focus is the honest reset.
    const clear = () => onDescribe(null);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("blur", clear);
      if (dwell.current) clearTimeout(dwell.current);
    };
  });
  return { desc, onDescribe };
}
