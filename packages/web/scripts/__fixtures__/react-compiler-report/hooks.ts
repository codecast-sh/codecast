// Fixture hooks for scripts/react-compiler-report.test.ts: each hands back a
// function, and the test says which of them a compiled caller may call.
import { createContext, useCallback, useContext, useMemo } from "react";

const Instant = createContext<number | null>(null);
declare const useThingStore: { getState(): { rows: Record<string, string> } };

/** The same callback for the life of the caller; it reads the clock when called. */
export function useFrozenAge(): (ts: number) => string {
  const fixed = useContext(Instant);
  return useCallback((ts: number) => String((fixed ?? Date.now()) - ts), [fixed]);
}

/** The instant is read per render, and the callback is made from it. */
export function useMovingAge(): (ts: number) => string {
  const now = useContext(Instant) ?? Date.now();
  return useCallback((ts: number) => String(now - ts), [now]);
}

/** An object of functions from useMemo: `age` reads the clock, `name` reads nothing. */
export function useFormatters() {
  return useMemo(() => ({ age: (ts: number) => String(Date.now() - ts), name: (s: string) => s.trim() }), []);
}

/** A tuple whose first item reads the clock. */
export function usePair(): [(ts: number) => string, number] {
  const age = useCallback((ts: number) => String(Date.now() - ts), []);
  return [age, 1];
}

/** Hands on what another hook hands back. */
export function useForwardedAge(): (ts: number) => string {
  return useFrozenAge();
}

/** A stable callback that reads a store when called. */
export function useRowReader(): (id: string) => string {
  return useCallback((id: string) => useThingStore.getState().rows[id], []);
}
