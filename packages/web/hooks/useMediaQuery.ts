// A CSS media query's answer, live. Its own module, so a test that mocks one
// of the hooks built on it (useIsPhone, useCoarsePointer) leaves the rest real.
import { useState } from "react";
import { useMountEffect } from "./useMountEffect";

/** A CSS media query's answer, live: re-renders when it flips. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof window !== "undefined" && !!window.matchMedia?.(query).matches);
  useMountEffect(() => {
    const mq = window.matchMedia?.(query);
    if (!mq) return;
    const on = () => setMatches(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  });
  return matches;
}
