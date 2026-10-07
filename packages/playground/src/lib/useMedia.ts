import { useSyncExternalStore } from "react";

export function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const m = matchMedia(query);
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    () => matchMedia(query).matches,
  );
}

/** Desktop room (side panel) from 1024px; below that the room is a sheet. */
export const useDesktop = () => useMedia("(min-width: 1024px)");

/** The person asked for less motion: scroll and move instantly. */
export const useReducedMotion = () => useMedia("(prefers-reduced-motion: reduce)");
