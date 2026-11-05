import { useState } from "react";
import { useWatchEffect } from "./useWatchEffect";

export function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useWatchEffect(() => {
    // Nothing to settle when the value is already the debounced one (on mount,
    // or typed back to it). A same-value set is not free: landing just after
    // another update on the component, it re-renders the component anyway (the
    // composer's typing budget caught it as a second commit on one keystroke).
    if (Object.is(value, debounced)) return;
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, debounced, delay]);
  return debounced;
}
