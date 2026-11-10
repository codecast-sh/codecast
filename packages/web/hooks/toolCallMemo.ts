// Per-tool-call memo for derivations that walk a whole transcript on every
// streamed update. A tool call's contribution depends only on its name and
// input (and, for some, a salt such as the home directory), so a pass reuses
// the previous pass's value for every call whose name and input are unchanged
// and parses only the new or edited ones. Keyed by the call id and checked by
// value, not by object identity: a page push decodes every message afresh.
// Each pass keeps only the calls it read, so the memo never outgrows the
// window. It is a cache with a check, so a pass React discards cannot make a
// later pass wrong.

type ToolCallLike = { id: string; name: string; input: string };
type Entry<T> = { name: string; input: string; value: T };

export class ToolCallMemo<T> {
  private prev = new Map<string, Entry<T>>();
  private next = new Map<string, Entry<T>>();
  private salt: unknown = undefined;

  /** Starts a pass. A different salt drops everything memoized under the old one. */
  begin(salt?: unknown): void {
    if (!Object.is(salt, this.salt)) {
      this.prev = new Map();
      this.salt = salt;
    }
    this.next = new Map();
  }

  get(tc: ToolCallLike, compute: (tc: ToolCallLike) => T): T {
    const hit = this.next.get(tc.id) ?? this.prev.get(tc.id);
    if (hit && hit.name === tc.name && hit.input === tc.input) {
      this.next.set(tc.id, hit);
      return hit.value;
    }
    const value = compute(tc);
    this.next.set(tc.id, { name: tc.name, input: tc.input, value });
    return value;
  }

  /** Ends a pass: calls the pass did not read are forgotten. */
  end(): void {
    this.prev = this.next;
    this.next = new Map();
  }
}

/**
 * `prev` when `next` holds the same keys in the same order with equal values,
 * else `next`. Lets a pass that changed nothing keep its result's identity, so
 * memoized consumers (every transcript row) hold.
 */
export function keepIfSameRecord<V>(
  prev: Record<string, V> | undefined,
  next: Record<string, V>,
  same: (a: V, b: V) => boolean = Object.is,
): Record<string, V> {
  if (!prev || prev === next) return next;
  const a = Object.keys(prev);
  const b = Object.keys(next);
  if (a.length !== b.length) return next;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i] || !same(prev[a[i]], next[b[i]])) return next;
  }
  return prev;
}

/** Arrays with the same elements, by reference, in the same order. */
export function sameElements<V>(a: readonly V[], b: readonly V[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
