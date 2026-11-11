// The trail: the places a person walked through, in order, one trail per app
// tab, so the Modern back control can say where it goes ("← Tasks",
// "← Slack bot rebuild") and take them there.
//
// The trail is not browser history. History is every move in time; the trail
// is the way back. Going back pops it. Moving the selection inside a list
// (the next task, the next session in the inbox) replaces the entry rather
// than stacking one per row, so Back from a task you reached by j/k still
// says "← Tasks". Opening something from inside something else (a task from
// a conversation, a subtask from a task) pushes, so Back returns there.
//
// It lives in sessionStorage: it survives a reload of the browser tab, stays
// with that browser tab (a second browser tab starts its own), and never
// reaches the server or the store's synced state. Classic and Minimal never
// read it.

import { placeKey, placeOf } from "./navPlace";

export type TrailEntry = { path: string; title?: string; ts: number };

/** How the place on screen changed: a move, a browser history step (back or
 *  forward), the back control's own step along the trail, or its step up to
 *  a page's parent when there was no trail (a cold link): the parent takes
 *  the page's entry, so Back from the list does not lead into the item again. */
export type TrailMove = "push" | "traverse" | "back" | "up";

const STORAGE_KEY = "codecast.navTrail.v1";
/** Older entries fall off the front: the way back is what matters, and forty
 *  steps is further back than anyone walks. */
export const TRAIL_CAP = 40;

/** The address a place's list or container has, for the sibling rule. */
function parentHref(path: string): string | null {
  return placeOf(path).parent?.href ?? null;
}

function depth(path: string): number {
  return placeKey(path).split("?")[0].split("/").filter(Boolean).length;
}

/** Two detail pages of one list (two tasks, two sessions of the inbox). */
function siblings(a: string, b: string): boolean {
  if (placeKey(a) === placeKey(b)) return false;
  const pa = parentHref(a);
  return !!pa && pa === parentHref(b) && depth(a) === depth(b) && placeKey(a) !== placeKey(pa);
}

/**
 * One step of a trail. Pure: the recorder, the tests and the back control all
 * reason with this.
 *
 * - The same place again (a filter or a tab inside the page): the entry takes
 *   the new address.
 * - Back (the control), a history step onto the entry below, or a move up
 *   from an item to the list below it: pop to it.
 * - The next item of the list the person came from: replace the entry.
 * - Anything else: push.
 */
export function stepTrail(trail: readonly TrailEntry[], path: string, move: TrailMove, now: number, title?: string): TrailEntry[] {
  const key = placeKey(path);
  const n = trail.length;
  const top = trail[n - 1];
  const entry: TrailEntry = { path, title: title ?? undefined, ts: now };
  if (top && placeKey(top.path) === key) {
    if (top.path === path && (title === undefined || top.title === title)) return trail as TrailEntry[];
    return [...trail.slice(0, n - 1), { ...top, path, title: title ?? top.title, ts: top.ts }];
  }
  if (move === "back") {
    for (let i = n - 2; i >= 0; i--) {
      if (placeKey(trail[i].path) === key) return [...trail.slice(0, i), { ...trail[i], path, title: title ?? trail[i].title }];
    }
  }
  // A history step onto the entry below, or a move up from an item to the
  // list it was opened from (the list's own close: space on the open row),
  // is the way back, not a new step.
  const upToBelow = move === "push" && n >= 2 && parentHref(top.path) != null && placeKey(parentHref(top.path)!) === key;
  if ((move === "traverse" || move === "back" || upToBelow) && n >= 2 && placeKey(trail[n - 2].path) === key) {
    return [...trail.slice(0, n - 2), { ...trail[n - 2], path, title: title ?? trail[n - 2].title }];
  }
  if (move === "up" && top) return [...trail.slice(0, n - 1), entry];
  if (top && n >= 2 && siblings(top.path, path) && placeKey(trail[n - 2].path) === placeKey(parentHref(path)!)) {
    return [...trail.slice(0, n - 1), entry];
  }
  const next = [...trail, entry];
  return next.length > TRAIL_CAP ? next.slice(next.length - TRAIL_CAP) : next;
}

/** Where Back goes from `current`: the entry below it, or (when the trail
 *  has not caught up with the page yet) the top. Null on a cold start. */
export function backEntry(trail: readonly TrailEntry[], current: string): TrailEntry | null {
  const n = trail.length;
  if (n === 0) return null;
  const key = placeKey(current);
  if (placeKey(trail[n - 1].path) === key) return n >= 2 ? trail[n - 2] : null;
  return trail[n - 1];
}

// ── The per-browser-tab store ─────────────────────────────────────────────

type Trails = Record<string, TrailEntry[]>;

function storage(): Storage | null {
  try {
    return typeof sessionStorage !== "undefined" ? sessionStorage : null;
  } catch {
    return null;
  }
}

function load(): Trails {
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? (parsed as Trails) : {};
  } catch {
    return {};
  }
}

// The parsed trails and their version, so a render reads memory, not JSON.
// One per document: a browser tab is one window, and sessionStorage is its own.
const state: { trails: Trails | null; version: number; listeners: Array<() => void> } = { trails: null, version: 0, listeners: [] };

function trails(): Trails {
  return (state.trails ??= load());
}

function save(next: Trails) {
  state.trails = next;
  state.version++;
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Private mode or a full quota: the trail lives in memory for this page.
  }
  for (const fn of [...state.listeners]) fn();
}

/** The trail of one app tab (or of the window, for a page with no tab). */
export function trailOf(scope: string): readonly TrailEntry[] {
  return trails()[scope] ?? [];
}

/** Record that `scope` now shows `path`. `live` names the scopes that still
 *  exist (the open app tabs), so a closed tab's trail is dropped. */
export function recordTrail(scope: string, path: string, move: TrailMove, title?: string, live?: readonly string[]): void {
  const all = trails();
  const cur = all[scope] ?? [];
  const next = stepTrail(cur, path, move, Date.now(), title);
  const stale = live ? Object.keys(all).filter((k) => k !== scope && !live.includes(k)) : [];
  if (next === cur && stale.length === 0) return;
  const out: Trails = { ...all, [scope]: next };
  for (const k of stale) delete out[k];
  save(out);
}

/** Re-render on any trail change (useSyncExternalStore). */
export function subscribeTrail(fn: () => void): () => void {
  state.listeners.push(fn);
  return () => {
    state.listeners = state.listeners.filter((l) => l !== fn);
  };
}

export function trailVersion(): number {
  return state.version;
}

/** Tests: forget the in-memory copy (the next read reloads sessionStorage). */
export function _resetTrailForTests(): void {
  state.trails = null;
  state.version = 0;
  state.listeners = [];
}
