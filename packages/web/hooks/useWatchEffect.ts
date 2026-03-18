import { useEffect, DependencyList } from "react";

export function useWatchEffect(effect: () => void | (() => void), deps: DependencyList): void {
  // eslint-disable-next-line no-restricted-syntax, react-hooks/exhaustive-deps
  useEffect(effect, deps);
}
