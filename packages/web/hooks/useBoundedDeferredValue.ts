import { useDeferredValue, useEffect, useRef, useState } from "react";

/**
 * useDeferredValue with a deadline. React gives the deferred render a fresh
 * transition lane every time the component re-renders urgently while it is
 * behind, so the 5s starvation expiry never fires: a component whose store
 * subscription keeps firing (a streaming session on screen) while the deferred
 * tree takes longer to render than the gap between updates stays on the old
 * value for as long as the updates keep coming. Updates elsewhere in the root
 * restart the deferred render too, and those stall it for the full 5s.
 *
 * Past `maxMs` behind, the value is taken urgently instead: one blocking
 * render, which is what the deferral was avoiding, but the view moves. The
 * deadline is read in render because the starving re-renders are the urgent
 * renders that can take it; the timer covers a component nothing re-renders.
 */
export function useBoundedDeferredValue<T>(value: T, maxMs = 1000): T {
  const deferred = useDeferredValue(value);
  const [, kick] = useState(0);
  const track = useRef<{ v: T; since: number; floor: { v: T } | null }>({ v: value, since: 0, floor: null });
  const now = performance.now();
  let t = track.current;
  if (!Object.is(t.v, value)) {
    // The value moved on. If the one before never landed, what was on screen
    // was either taken at its deadline (it becomes the floor) or the older floor.
    const landed = Object.is(deferred, t.v);
    const floor = landed ? null : now - t.since >= maxMs ? { v: t.v } : t.floor;
    t = track.current = { v: value, since: now, floor };
  }
  const behind = !Object.is(deferred, value);
  if (!behind) t.floor = null;
  const since = t.since;
  useEffect(() => {
    if (!behind) return;
    const timer = setTimeout(() => kick((n) => n + 1), Math.max(0, since + maxMs - performance.now()));
    return () => clearTimeout(timer);
  }, [behind, since, maxMs]);
  if (!behind) return deferred;
  if (now - since >= maxMs) return value;
  return t.floor ? t.floor.v : deferred;
}
