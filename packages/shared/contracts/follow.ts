// The follow lease, in numbers both halves agree on.
//
// A follower holds a lease on the leader and renews it while their window is
// on the follow; the leader writes their place only while a live lease exists.
// The two constants carry one invariant — the renew cadence sits well inside
// the lease, so a renew that is merely late does not read as a follower who
// went away. They live here because the web hook that renews and the convex
// functions that expire the lease must read the same numbers, and importing
// the convex module from the browser drags every query and mutation in that
// file (and its whole `./functions` chain) into the client bundle.

/** A lease older than this is dead: the follower's window closed or slept. */
export const FOLLOW_LEASE_MS = 30_000;
/** The follower renews at this cadence, well inside the lease. */
export const FOLLOW_RENEW_MS = 10_000;

/**
 * Where a leader is inside the page, beyond the route: which side panel is
 * open, the diff file and line in hand, and how far a named scroll region has
 * scrolled (0 at its top, 1 at its bottom, so windows of different heights
 * land on the same passage). Every part is optional; a surface that is not on
 * screen contributes nothing.
 */
export type FollowView = {
  panel?: string;
  diff?: { file: string; line?: number; base?: string };
  scroll?: { key: string; offset: number };
};

/** The view as it may be stored: bounded strings, a whole positive line, an
 *  offset inside 0..1 at three decimals. Undefined when nothing is left. */
export function clampFollowView(view: FollowView | null | undefined): FollowView | undefined {
  if (!view) return undefined;
  const out: FollowView = {};
  const panel = view.panel?.trim().slice(0, 64);
  if (panel) out.panel = panel;
  const file = view.diff?.file?.trim().slice(0, 512);
  if (file) {
    const diff: NonNullable<FollowView["diff"]> = { file };
    const line = view.diff!.line;
    if (typeof line === "number" && Number.isFinite(line) && line >= 1) diff.line = Math.floor(line);
    const base = view.diff!.base?.trim().slice(0, 128);
    if (base) diff.base = base;
    out.diff = diff;
  }
  const key = view.scroll?.key?.trim().slice(0, 64);
  const offset = view.scroll?.offset;
  if (key && typeof offset === "number" && Number.isFinite(offset)) {
    out.scroll = { key, offset: Math.round(Math.min(1, Math.max(0, offset)) * 1000) / 1000 };
  }
  return out.panel || out.diff || out.scroll ? out : undefined;
}
