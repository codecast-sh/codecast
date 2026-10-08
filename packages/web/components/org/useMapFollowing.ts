// Whether the map follows what the conversation beside it points at (the
// map-only Org screen opened beside a thread). The thread's newest pointer
// moves the map; the one that was there when the pane opened does not, so
// opening on an older proposal's card holds.
import { useRef, useState } from "react";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useThreadChartPointer } from "./orgChartLink";
import type { ChartPointer } from "./orgChartPointer";

export function useMapFollowing(beside: string | null, onPointer: (pointer: ChartPointer) => void): { following: boolean; toggle: () => void } | null {
  const [following, setFollowing] = useState(true);
  const thread = useThreadChartPointer(beside);
  const applied = useRef(thread?.key ?? null);
  useWatchEffect(() => {
    if (!beside || !following || !thread || applied.current === thread.key) return;
    applied.current = thread.key;
    onPointer({ proposal: thread.proposal, focus: thread.focus, lens: thread.lens });
  }, [beside, following, thread?.key]);
  if (!beside) return null;
  const toggle = () => {
    const next = !following;
    setFollowing(next);
    if (next && thread) { applied.current = thread.key; onPointer({ proposal: thread.proposal, focus: thread.focus, lens: thread.lens }); }
  };
  return { following, toggle };
}
