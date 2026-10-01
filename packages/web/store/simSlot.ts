/**
 * Building blocks for the sim seams (`__*SimSlots`): module-level state that
 * belongs to one window, snapshotted by get(), loaded back by set(), and
 * started from fresh() (docs/architecture/multiplayer-sim-harness.md).
 *
 * The live binding is never reassigned, because other module code holds it;
 * set() refills it in place.
 */

export function replaceContents<K, V>(target: Map<K, V>, source: Map<K, V>): void;
export function replaceContents<T>(target: Set<T>, source: Set<T>): void;
export function replaceContents(target: Map<unknown, unknown> | Set<unknown>, source: Map<unknown, unknown> | Set<unknown>): void {
  target.clear();
  if (target instanceof Map) for (const [k, v] of source as Map<unknown, unknown>) target.set(k, v);
  else for (const v of source as Set<unknown>) target.add(v);
}

type MapRecord = Record<string, Map<any, any>>;

/**
 * A whole seam over a record of module-level maps: get() copies each map so
 * the snapshot is detached, set() refills each live map, fresh() hands back
 * empty ones.
 */
export function mapSlots<T extends MapRecord>(maps: T) {
  const each = (make: (m: Map<any, any>) => Map<any, any>): T =>
    Object.fromEntries(Object.entries(maps).map(([k, m]) => [k, make(m)])) as T;
  return {
    fresh: (): T => each(() => new Map()),
    get: (): T => each((m) => new Map(m)),
    set: (s: T): void => {
      for (const k of Object.keys(maps)) replaceContents(maps[k], s[k]);
    },
  };
}
