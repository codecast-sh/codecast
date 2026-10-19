import { useCallback, useRef, useState } from "react";

/**
 * useState whose setter does nothing when the value is unchanged, for state set
 * from a layout effect or an observer on every pass (a measurement after each
 * keystroke). React does not skip such an update when the value is the same:
 * it re-renders and re-commits the component, a second commit per keystroke.
 */
export function useChangedState<T>(initial: T): [T, (next: T) => void] {
  const [value, setValue] = useState(initial);
  const latest = useRef(initial);
  const set = useCallback((next: T) => {
    if (Object.is(latest.current, next)) return;
    latest.current = next;
    setValue(next);
  }, []);
  return [value, set];
}
