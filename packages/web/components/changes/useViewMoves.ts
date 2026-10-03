// The page's view bookkeeping: which way the view moved, whether it has moved
// at all since the page mounted, and one call per arrival at a view.
import { useLayoutEffect, useRef } from "react";

export type View = { mode: string; key: string; repo: string | undefined };

/**
 * Which way the view slides, read off the view change itself, so every way of
 * moving (keys, Back and Forward, the strip, a pasted link) agrees: a later
 * day or week slides in from the right, an earlier one from the left, and a
 * change of mode or repository does not slide. It holds until the next
 * change, so a render in between keeps the slide it started.
 *
 * The default repository arriving for a URL that named none completes the
 * first view: it is not a move, so it neither slides nor calls `onArrive`
 * again. `moved` says the view has changed since the page mounted: from then
 * on nothing replays the first paint's rise, a Day/Week switch included.
 * `onArrive(first)` runs in a layout effect once on mount and once per move.
 */
export function useViewMoves(view: View, onArrive: (first: boolean) => void) {
  const last = useRef(view);
  const travel = useRef<"next" | "prev" | null>(null);
  const moved = useRef(false);
  const moves = useRef(0);
  const was = last.current;
  if (was.mode !== view.mode || was.key !== view.key || was.repo !== view.repo) {
    const settling = was.repo === undefined && was.mode === view.mode && was.key === view.key;
    if (!settling) {
      travel.current = was.mode === view.mode && was.repo === view.repo ? (view.key > was.key ? "next" : "prev") : null;
      moved.current = true;
      moves.current += 1;
    }
    last.current = view;
  }
  const arrive = useRef(onArrive);
  arrive.current = onArrive;
  const seen = useRef(-1);
  const count = moves.current;
  useLayoutEffect(() => {
    if (seen.current === count) return;
    const first = seen.current === -1;
    seen.current = count;
    arrive.current(first);
  }, [count]);
  return { travel: travel.current, moved: moved.current };
}
