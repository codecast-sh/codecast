import { useEffect, DependencyList } from "react";

/** An effect keyed on `deps`. Without deps it runs after every render, for the
 *  rare surface that must re-read the DOM or re-publish a handle each time. */
export function useWatchEffect(effect: () => void | (() => void), deps?: DependencyList): void {
  // eslint-disable-next-line no-restricted-syntax, react-hooks/exhaustive-deps
  useEffect(effect, deps);
}
