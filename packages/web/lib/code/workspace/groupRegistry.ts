// Which editor view and which breadcrumbs row belong to each mounted editor
// group. The row is React (it lives in the page bundle); the symbol path in it
// is written by a ViewPlugin inside the editor chunk, without React. This
// registry is the meeting point and imports neither side.

interface GroupSlot {
  view: object | null;
  crumbs: HTMLElement | null;
}

const slots = new Map<string, GroupSlot>();
const crumbListeners = new Set<(view: object) => void>();

function slot(key: string): GroupSlot {
  let s = slots.get(key);
  if (!s) slots.set(key, (s = { view: null, crumbs: null }));
  return s;
}

function drop(key: string): void {
  const s = slots.get(key);
  if (s && !s.view && !s.crumbs) slots.delete(key);
}

function announce(s: GroupSlot): void {
  if (s.view && s.crumbs) for (const fn of crumbListeners) fn(s.view);
}

/** An editor group's view; returns the release. */
export function bindGroupView(key: string, view: object): () => void {
  const s = slot(key);
  s.view = view;
  announce(s);
  return () => {
    if (s.view === view) s.view = null;
    drop(key);
  };
}

/** The element a group's symbol path is written into; returns the release. */
export function bindGroupCrumbs(key: string, el: HTMLElement): () => void {
  const s = slot(key);
  s.crumbs = el;
  announce(s);
  return () => {
    if (s.crumbs === el) s.crumbs = null;
    drop(key);
  };
}

export function crumbsForView(view: object): HTMLElement | null {
  for (const s of slots.values()) if (s.view === view) return s.crumbs;
  return null;
}

export function groupKeyOfView(view: object): string | null {
  for (const [key, s] of slots) if (s.view === view) return key;
  return null;
}

export function viewOfGroup(key: string): object | null {
  return slots.get(key)?.view ?? null;
}

/** Called when a view and its breadcrumbs row are both bound (the row mounts
 *  after the editor, or the editor moves to another group). */
export function onCrumbsBound(fn: (view: object) => void): () => void {
  crumbListeners.add(fn);
  return () => crumbListeners.delete(fn);
}

// ── synchronous tab switches ────────────────────────────────────────────────
// Each mounted code editor registers how to put an already-open buffer on
// screen at once; the workspace verbs (controller.ts) call it before the store
// changes, so the switch never waits on a React render.

const switchers = new Map<string, Set<(path: string) => boolean>>();
const switchKey = (vaultId: string, groupId: string) => `${vaultId}\u0000${groupId}`;

export function registerGroupSwitcher(vaultId: string, groupId: string, show: (path: string) => boolean): () => void {
  const key = switchKey(vaultId, groupId);
  let set = switchers.get(key);
  if (!set) switchers.set(key, (set = new Set()));
  set.add(show);
  return () => {
    set!.delete(show);
    if (set!.size === 0) switchers.delete(key);
  };
}

/** Show `path` in the group's editors now, if a buffer for it is open. True
 *  when at least one editor shows it and none was left behind. */
export function switchGroupNow(vaultId: string, groupId: string, path: string): boolean {
  const set = switchers.get(switchKey(vaultId, groupId));
  if (!set?.size) return false;
  let all = true;
  for (const show of set) all = show(path) && all;
  return all;
}
