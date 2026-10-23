// Memos that outlive the fiber. React throws a render away whenever an urgent
// update lands during a long concurrent render, and a page that has not
// committed yet is mounted again from nothing: every useMemo of the discarded
// attempt is lost, and the next attempt computes it all again (the Line's
// workspace ran its whole model two or three times on a first open). A
// shared memo keeps its last result in a slot outside the fiber, so an
// attempt with the same inputs reads it back instead.
//
// Slots are named by the instance a hook is given and the order of the calls,
// which the rules of hooks keep stable. One value per slot; deps compare with
// Object.is, as useMemo's do.
import { useMemo, type DependencyList } from "react";

type Slot = { deps: DependencyList; value: unknown };
const slots = new Map<string, Slot>();

const sameDeps = (a: DependencyList, b: DependencyList) => a.length === b.length && a.every((d, i) => Object.is(d, b[i]));
const sameRows = (a: ReadonlyArray<unknown>, b: ReadonlyArray<unknown>) => a.length === b.length && a.every((r, i) => r === b[i]);

/** `useShared` and `useSharedRows` for one instance of a hook (`instance` names it, e.g. by its arguments). Call them in
 *  a fixed order at the top level of that hook, as any hook. */
export function useSharedMemos(instance: string) {
  let n = 0;
  /** useMemo, kept in this instance's next slot. */
  function useShared<T>(compute: () => T, deps: DependencyList): T {
    const slot = `${instance}#${n++}`;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the deps are the caller's, passed through
    return useMemo(() => {
      const was = slots.get(slot);
      if (was && sameDeps(was.deps, deps)) return was.value as T;
      const value = compute();
      slots.set(slot, { deps, value });
      return value;
    }, deps);
  }
  /** The array this slot last returned when it holds the same rows in the same order: a store read hands each mount a
   *  new array of the same rows, and every memo below would miss on it. */
  function useSharedRows<T>(rows: T[]): T[] {
    const slot = `${instance}#${n++}`;
    const was = slots.get(slot);
    if (was && sameRows(was.value as T[], rows)) return was.value as T[];
    slots.set(slot, { deps: [], value: rows });
    return rows;
  }
  return { useShared, useSharedRows };
}
