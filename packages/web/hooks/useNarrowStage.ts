import { useEffect, useState } from "react";

/** Below this width the stage renders one pane only — a split layout stays
 *  stored for a wider window, and drops onto the stage are inert. Matches the
 *  gate in lib/stage.openBeside. */
export const NARROW_STAGE_MAX_WIDTH = 900;

export function useNarrowStage(): boolean {
  const [narrow, setNarrow] = useState(
    () => typeof window !== "undefined" && window.innerWidth < NARROW_STAGE_MAX_WIDTH,
  );
  useEffect(() => {
    const mq = window.matchMedia?.(`(max-width: ${NARROW_STAGE_MAX_WIDTH - 1}px)`);
    if (!mq) return;
    const on = () => setNarrow(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return narrow;
}
