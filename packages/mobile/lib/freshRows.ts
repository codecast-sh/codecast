/**
 * Which transcript rows just arrived, so only those animate in. A row is
 * fresh when it lands at the newest end of a transcript the screen already
 * showed: a send, a reply, a step. Everything else is already there when the
 * person looks, so it never animates: the first load, an older page, a burst
 * of rows caught up after being away, and a row the list remounts on scroll.
 */

/** More new rows than this in one update is a catch-up, not a conversation. */
const BURST = 3;
/** How long after arriving a row still counts as fresh, for a cell mounted a beat late. */
const FRESH_MS = 1200;

export class FreshRows {
  private known = new Set<string>();
  private freshAt = new Map<string, number>();
  private primed = false;

  /** Takes the row keys oldest first, as they render now. */
  update(keys: readonly string[], now: number): void {
    if (!this.primed) {
      if (keys.length === 0) return;
      this.primed = true;
      for (const k of keys) this.known.add(k);
      return;
    }
    // The unknown keys at the newest end, before the first row already shown.
    const tail: string[] = [];
    for (let i = keys.length - 1; i >= 0 && !this.known.has(keys[i]); i--) tail.push(keys[i]);
    const burst = tail.length > BURST || tail.length === keys.length;
    for (const k of keys) {
      if (this.known.has(k)) continue;
      this.known.add(k);
      if (!burst && tail.includes(k)) this.freshAt.set(k, now);
    }
  }

  isFresh(key: string, now: number): boolean {
    const at = this.freshAt.get(key);
    return at !== undefined && now - at < FRESH_MS;
  }
}
