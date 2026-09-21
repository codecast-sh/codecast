import { useEffect, useState } from "react";

// How long an outgoing value stays painted for its exit animation. Matches the
// tailwindcss-animate duration the exit classes below use.
export const EXIT_MS = 220;

/**
 * Hold the last non null value for one exit animation after it goes null, so a
 * node can fade out instead of vanishing. `leaving` is true during that hold.
 * A value that comes back before the hold ends cancels the exit.
 */
export function useLinger<T>(value: T | null): { value: T | null; leaving: boolean } {
  const [held, setHeld] = useState<T | null>(value);
  // eslint-disable-next-line no-restricted-syntax -- the exit timer is keyed to the value it is holding open
  useEffect(() => {
    if (value !== null) {
      setHeld(value);
      return;
    }
    if (held === null) return;
    const id = setTimeout(() => setHeld(null), EXIT_MS);
    return () => clearTimeout(id);
  }, [value, held]);
  return { value: value ?? held, leaving: value === null && held !== null };
}
