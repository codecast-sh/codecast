// The code workspace as data: editor groups side by side, each with its own
// tab list, plus the history a person moves through (most recently used tabs,
// closed tabs to reopen). Pure functions over plain objects, so the store
// (store/codeStore.ts) holds one value per vault, persistence writes it as
// JSON, and tests drive every rule here without a DOM.
//
// Rules, after VS Code and Zed:
// - A single-click open is a preview tab (italic). The next preview open in the
//   same group replaces it. Editing, a double click or "keep open" makes it a
//   normal tab.
// - A pinned tab sits at the left of its group and survives close-others and
//   close-to-the-right.
// - At most MAX_GROUPS groups; a group that loses its last tab collapses.

import { isVirtualTab } from "./virtualTabs";

export interface WsTab {
  path: string;
  preview?: true;
  pinned?: true;
  /** Where the cursor was, carried across reloads (1-based). */
  cursor?: { line: number; col: number };
}

export interface WsGroup {
  id: string;
  tabs: WsTab[];
  active: string | null;
  /** A one-shot cursor target for `path` (`"42"`, `"42:5"`); `n` makes the
   *  same target twice a new request. Never persisted. */
  reveal?: { path: string; at: string; n: number };
}

export interface ClosedTab {
  path: string;
  groupId: string;
  index: number;
}

export interface Workspace {
  groups: WsGroup[];
  activeGroup: string;
  orientation: "horizontal" | "vertical";
  /** Percent per group, in order; null means equal. */
  sizes: number[] | null;
  /** Most recent first: `groupId\0path`. */
  mru: string[];
  closed: ClosedTab[];
}

export const MAX_GROUPS = 3;
const MAX_CLOSED = 40;
const MAX_MRU = 100;

export const mruKey = (groupId: string, path: string) => `${groupId}\u0000${path}`;
export const splitMruKey = (key: string) => {
  const i = key.indexOf("\u0000");
  return { groupId: key.slice(0, i), path: key.slice(i + 1) };
};

export function emptyWorkspace(): Workspace {
  return { groups: [{ id: "g1", tabs: [], active: null }], activeGroup: "g1", orientation: "horizontal", sizes: null, mru: [], closed: [] };
}

function newGroupId(ws: Workspace): string {
  for (let i = 1; ; i++) if (!ws.groups.some((g) => g.id === `g${i}`)) return `g${i}`;
}

export function groupById(ws: Workspace, id: string | null | undefined): WsGroup | undefined {
  return id ? ws.groups.find((g) => g.id === id) : undefined;
}

export function activeGroup(ws: Workspace): WsGroup {
  return groupById(ws, ws.activeGroup) ?? ws.groups[0];
}

function replaceGroup(ws: Workspace, group: WsGroup): Workspace {
  return { ...ws, groups: ws.groups.map((g) => (g.id === group.id ? group : g)) };
}

function touch(ws: Workspace, groupId: string, path: string): Workspace {
  const key = mruKey(groupId, path);
  if (ws.mru[0] === key && ws.activeGroup === groupId) return ws;
  return { ...ws, activeGroup: groupId, mru: [key, ...ws.mru.filter((k) => k !== key)].slice(0, MAX_MRU) };
}

/** Pinned tabs first, the rest after, each in its own order. */
function pinnedFirst(tabs: WsTab[]): WsTab[] {
  const pinned = tabs.filter((t) => t.pinned);
  return pinned.length === 0 || pinned.length === tabs.length ? tabs : [...pinned, ...tabs.filter((t) => !t.pinned)];
}

function withReveal(group: WsGroup, path: string, at: string | undefined): WsGroup {
  // A request for another file is spent once the group shows something else.
  if (!at) return group.reveal && group.reveal.path !== path ? { ...group, reveal: undefined } : group;
  return { ...group, reveal: { path, at, n: (group.reveal?.n ?? 0) + 1 } };
}

export interface OpenOptions {
  /** The group to open in; the focused group when absent or gone. */
  groupId?: string;
  /** A preview open (a single click in the tree, quick open's Enter). */
  preview?: boolean;
  /** Where the cursor goes: `"42"` or `"42:5"`. */
  at?: string;
  /** Insert at this index instead of right of the active tab. */
  index?: number;
}

/** Open (or show) a file in a group, as a preview or a kept tab. */
export function openTab(ws: Workspace, path: string, opts: OpenOptions = {}): Workspace {
  const group = groupById(ws, opts.groupId) ?? activeGroup(ws);
  const existing = group.tabs.findIndex((t) => t.path === path);
  let tabs = group.tabs;
  if (existing >= 0) {
    // Opening a preview again leaves it a preview; any other open keeps it.
    if (!opts.preview && tabs[existing].preview) {
      tabs = tabs.map((t, i) => (i === existing ? withoutPreview(t) : t));
    }
  } else {
    const tab: WsTab = opts.preview ? { path, preview: true } : { path };
    const previewAt = opts.preview ? tabs.findIndex((t) => t.preview) : -1;
    if (previewAt >= 0) {
      tabs = tabs.map((t, i) => (i === previewAt ? tab : t));
    } else {
      const activeAt = tabs.findIndex((t) => t.path === group.active);
      const at = opts.index ?? (activeAt >= 0 ? activeAt + 1 : tabs.length);
      tabs = [...tabs.slice(0, at), tab, ...tabs.slice(at)];
      tabs = pinnedFirst(tabs);
    }
  }
  const next = withReveal({ ...group, tabs, active: path }, path, opts.at);
  return touch(replaceGroup(ws, next), group.id, path);
}

function withoutPreview(t: WsTab): WsTab {
  const { preview: _p, ...rest } = t;
  return rest;
}

/** A preview tab becomes a normal tab (edited, double-clicked, kept open). */
export function keepOpen(ws: Workspace, groupId: string, path: string): Workspace {
  const group = groupById(ws, groupId);
  if (!group?.tabs.some((t) => t.path === path && t.preview)) return ws;
  return replaceGroup(ws, { ...group, tabs: group.tabs.map((t) => (t.path === path ? withoutPreview(t) : t)) });
}

/** Keep every preview of `path` open, in whichever group shows it. */
export function keepOpenEverywhere(ws: Workspace, path: string): Workspace {
  let next = ws;
  for (const g of ws.groups) next = keepOpen(next, g.id, path);
  return next;
}

export function activateTab(ws: Workspace, groupId: string, path: string, at?: string): Workspace {
  const group = groupById(ws, groupId);
  if (!group || !group.tabs.some((t) => t.path === path)) return ws;
  const next = group.active === path && !at ? group : withReveal({ ...group, active: path }, path, at);
  return touch(next === group ? ws : replaceGroup(ws, next), groupId, path);
}

export function focusGroupId(ws: Workspace, groupId: string): Workspace {
  const group = groupById(ws, groupId);
  if (!group || ws.activeGroup === groupId) return ws;
  return group.active ? touch(ws, groupId, group.active) : { ...ws, activeGroup: groupId };
}

export function togglePinned(ws: Workspace, groupId: string, path: string): Workspace {
  const group = groupById(ws, groupId);
  const tab = group?.tabs.find((t) => t.path === path);
  if (!group || !tab) return ws;
  let tabs: WsTab[];
  if (tab.pinned) {
    const { pinned: _p, ...rest } = tab;
    const others = group.tabs.filter((t) => t !== tab);
    const lastPinned = others.reduce((n, t, i) => (t.pinned ? i + 1 : n), 0);
    tabs = [...others.slice(0, lastPinned), rest, ...others.slice(lastPinned)];
  } else {
    const pinned: WsTab = { ...withoutPreview(tab), pinned: true };
    const others = group.tabs.filter((t) => t !== tab);
    const lastPinned = others.reduce((n, t, i) => (t.pinned ? i + 1 : n), 0);
    tabs = [...others.slice(0, lastPinned), pinned, ...others.slice(lastPinned)];
  }
  return replaceGroup(ws, { ...group, tabs });
}

/** The tab a group shows after `closing` goes: the most recently used tab of
 *  that group still open, else the neighbor. */
function nextActive(ws: Workspace, group: WsGroup, remaining: WsTab[], closingIndex: number): string | null {
  if (remaining.length === 0) return null;
  const open = new Set(remaining.map((t) => t.path));
  for (const key of ws.mru) {
    const { groupId, path } = splitMruKey(key);
    if (groupId === group.id && open.has(path)) return path;
  }
  return remaining[Math.min(closingIndex, remaining.length - 1)].path;
}

function forgetMru(ws: Workspace, groupId: string, paths: Set<string> | null): Workspace {
  return {
    ...ws,
    mru: ws.mru.filter((k) => {
      const m = splitMruKey(k);
      return m.groupId !== groupId || (paths !== null && !paths.has(m.path));
    }),
  };
}

function pushClosed(ws: Workspace, entries: ClosedTab[]): Workspace {
  if (!entries.length) return ws;
  const paths = new Set(entries.map((e) => e.path));
  return { ...ws, closed: [...entries.slice().reverse(), ...ws.closed.filter((c) => !paths.has(c.path))].slice(0, MAX_CLOSED) };
}

/** Remove tabs from a group (recording them to reopen); a group left empty
 *  collapses unless it is the only one. */
function removeTabs(ws: Workspace, groupId: string, paths: Set<string>): Workspace {
  const group = groupById(ws, groupId);
  if (!group) return ws;
  const closing: ClosedTab[] = [];
  group.tabs.forEach((t, index) => paths.has(t.path) && closing.push({ path: t.path, groupId, index }));
  if (!closing.length) return ws;
  const remaining = group.tabs.filter((t) => !paths.has(t.path));
  let next = pushClosed(forgetMru(ws, groupId, paths), closing);
  const activeClosed = group.active !== null && paths.has(group.active);
  const firstClosed = closing.find((c) => c.path === group.active)?.index ?? closing[0].index;
  const active = activeClosed ? nextActive(next, group, remaining, firstClosed) : group.active;
  next = replaceGroup(next, { ...group, tabs: remaining, active, reveal: undefined });
  if (remaining.length === 0 && next.groups.length > 1) return removeGroup(next, groupId);
  return next;
}

function removeGroup(ws: Workspace, groupId: string): Workspace {
  const at = ws.groups.findIndex((g) => g.id === groupId);
  if (at < 0 || ws.groups.length === 1) return ws;
  const groups = ws.groups.filter((g) => g.id !== groupId);
  const focus = ws.activeGroup === groupId ? groups[Math.max(0, at - 1)].id : ws.activeGroup;
  const next: Workspace = { ...forgetMru(ws, groupId, null), groups, sizes: null };
  return focusGroupId({ ...next, activeGroup: focus === next.activeGroup ? focus : next.activeGroup }, focus);
}

export function closeTab(ws: Workspace, groupId: string, path: string): Workspace {
  return removeTabs(ws, groupId, new Set([path]));
}

/** Close every unpinned tab but `path` in the group. */
export function closeOthers(ws: Workspace, groupId: string, path: string): Workspace {
  const group = groupById(ws, groupId);
  if (!group) return ws;
  const next = removeTabs(ws, groupId, new Set(group.tabs.filter((t) => t.path !== path && !t.pinned).map((t) => t.path)));
  return activateTab(next, groupId, path);
}

/** Close the unpinned tabs right of `path`. */
export function closeToRight(ws: Workspace, groupId: string, path: string): Workspace {
  const group = groupById(ws, groupId);
  const at = group?.tabs.findIndex((t) => t.path === path) ?? -1;
  if (!group || at < 0) return ws;
  return removeTabs(ws, groupId, new Set(group.tabs.slice(at + 1).filter((t) => !t.pinned).map((t) => t.path)));
}

export function closeGroup(ws: Workspace, groupId: string): Workspace {
  const group = groupById(ws, groupId);
  if (!group) return ws;
  if (ws.groups.length === 1) return removeTabs(ws, groupId, new Set(group.tabs.map((t) => t.path)));
  const closing = group.tabs.map((t, index) => ({ path: t.path, groupId, index }));
  return removeGroup(pushClosed(ws, closing), groupId);
}

/** Close every group but this one (vim's :only). */
export function onlyGroup(ws: Workspace, groupId: string): Workspace {
  let next = ws;
  for (const g of ws.groups) if (g.id !== groupId) next = closeGroup(next, g.id);
  return focusGroupId(next, groupId);
}

/** Reopen the most recently closed tab, where it was when it still can be. */
export function reopenClosed(ws: Workspace, isOpenable: (path: string) => boolean = () => true): Workspace {
  let closed = ws.closed;
  while (closed.length && !isOpenable(closed[0].path)) closed = closed.slice(1);
  const entry = closed[0];
  if (!entry) return closed === ws.closed ? ws : { ...ws, closed };
  const rest = { ...ws, closed: closed.slice(1) };
  const group = groupById(rest, entry.groupId) ?? activeGroup(rest);
  return openTab(rest, entry.path, { groupId: group.id, index: Math.min(entry.index, group.tabs.length) });
}

/** Move a tab to `toIndex` in `toGroupId` (its own group: a reorder). A tab
 *  dropped on a group that already shows the file just moves focus there. */
export function moveTab(ws: Workspace, fromGroupId: string, path: string, toGroupId: string, toIndex: number): Workspace {
  const from = groupById(ws, fromGroupId);
  const to = groupById(ws, toGroupId);
  const tab = from?.tabs.find((t) => t.path === path);
  if (!from || !to || !tab) return ws;
  if (from.id === to.id) {
    const without = from.tabs.filter((t) => t !== tab);
    const at = Math.max(0, Math.min(toIndex > from.tabs.indexOf(tab) ? toIndex - 1 : toIndex, without.length));
    // A tab keeps to its side of the pinned line.
    const pinnedCount = without.filter((t) => t.pinned).length;
    const bounded = tab.pinned ? Math.min(at, pinnedCount) : Math.max(at, pinnedCount);
    const tabs = [...without.slice(0, bounded), tab, ...without.slice(bounded)];
    if (tabs.every((t, i) => t === from.tabs[i])) return activateTab(ws, from.id, path);
    return activateTab(replaceGroup(ws, { ...from, tabs }), from.id, path);
  }
  let next = ws;
  if (!to.tabs.some((t) => t.path === path)) {
    const toTabs = pinnedFirst([...to.tabs.slice(0, toIndex), { ...tab }, ...to.tabs.slice(toIndex)]);
    next = replaceGroup(next, { ...to, tabs: toTabs });
  }
  next = activateTab(next, to.id, path);
  // Moving is not closing: nothing to reopen.
  const closedBefore = next.closed;
  next = removeTabs(next, from.id, new Set([path]));
  return { ...next, closed: closedBefore };
}

export type SplitDirection = "right" | "down";

/** Open `path` in a new group beside `groupId` (or, at the group limit, in
 *  the next group over). The first split sets the workspace's orientation. */
export function splitTo(ws: Workspace, groupId: string, path: string, direction: SplitDirection, opts: { at?: string; preview?: boolean } = {}): Workspace {
  const at = ws.groups.findIndex((g) => g.id === groupId);
  if (at < 0) return ws;
  if (ws.groups.length >= MAX_GROUPS) {
    const target = ws.groups[at + 1] ?? ws.groups[at - 1];
    return openTab(ws, path, { groupId: target.id, at: opts.at, preview: opts.preview });
  }
  const id = newGroupId(ws);
  const orientation = ws.groups.length === 1 ? (direction === "down" ? "vertical" : "horizontal") : ws.orientation;
  const group: WsGroup = { id, tabs: [], active: null };
  const groups = [...ws.groups.slice(0, at + 1), group, ...ws.groups.slice(at + 1)];
  return openTab({ ...ws, groups, orientation, sizes: null }, path, { groupId: id, at: opts.at, preview: opts.preview });
}

export type FocusDirection = "left" | "right" | "up" | "down";

/** The group in a direction from the focused one, given the orientation. */
export function neighborGroup(ws: Workspace, dir: FocusDirection): string | null {
  const horizontal = ws.orientation === "horizontal";
  const step = horizontal ? (dir === "left" ? -1 : dir === "right" ? 1 : 0) : dir === "up" ? -1 : dir === "down" ? 1 : 0;
  if (!step) return null;
  const at = ws.groups.findIndex((g) => g.id === ws.activeGroup);
  return ws.groups[at + step]?.id ?? null;
}

/** The tab `delta` away in the focused group, wrapping. */
export function cycleTab(ws: Workspace, delta: number): Workspace {
  const group = activeGroup(ws);
  if (group.tabs.length < 2) return ws;
  const at = group.tabs.findIndex((t) => t.path === group.active);
  const next = group.tabs[(((at + delta) % group.tabs.length) + group.tabs.length) % group.tabs.length];
  return activateTab(ws, group.id, next.path);
}

/** Go to the tab at `index` in the focused group; past the end means the last. */
export function gotoTab(ws: Workspace, index: number): Workspace {
  const group = activeGroup(ws);
  if (!group.tabs.length || index < 0) return ws;
  const tab = group.tabs[Math.min(index, group.tabs.length - 1)];
  return activateTab(ws, group.id, tab.path);
}

export interface MruEntry {
  groupId: string;
  path: string;
}

/** Every open tab, most recently used first (tabs never activated last, in
 *  group order). */
export function mruTabs(ws: Workspace): MruEntry[] {
  const open = new Set<string>();
  for (const g of ws.groups) for (const t of g.tabs) open.add(mruKey(g.id, t.path));
  const out: MruEntry[] = [];
  const seen = new Set<string>();
  for (const key of ws.mru) {
    if (!open.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(splitMruKey(key));
  }
  for (const key of open) if (!seen.has(key)) out.push(splitMruKey(key));
  return out;
}

/** Follow a rename on disk: tabs on the path (or inside a renamed folder) follow it. */
export function renamePath(ws: Workspace, from: string, to: string): Workspace {
  const hit = (p: string) => p === from || p.startsWith(from + "/");
  if (!ws.groups.some((g) => g.tabs.some((t) => hit(t.path))) && !ws.closed.some((c) => hit(c.path))) return ws;
  const map = (p: string) => (p === from ? to : p.startsWith(from + "/") ? to + p.slice(from.length) : p);
  return {
    ...ws,
    groups: ws.groups.map((g) => ({ ...g, active: g.active && map(g.active), tabs: g.tabs.map((t) => ({ ...t, path: map(t.path) })), reveal: undefined })),
    mru: ws.mru.map((k) => {
      const m = splitMruKey(k);
      return mruKey(m.groupId, map(m.path));
    }),
    closed: ws.closed.map((c) => ({ ...c, path: map(c.path) })),
  };
}

/** A path is gone (deleted, or never a file): its tabs close, unless asked
 *  to stay, and nothing reopens it. */
export function forgetPath(ws: Workspace, path: string, opts: { keepTabs?: boolean } = {}): Workspace {
  let next = ws;
  if (!opts.keepTabs) {
    for (const g of ws.groups) if (g.tabs.some((t) => t.path === path)) next = removeTabs(next, g.id, new Set([path]));
  }
  if (!next.closed.some((c) => c.path === path)) return next;
  return { ...next, closed: next.closed.filter((c) => c.path !== path) };
}

export function setSizes(ws: Workspace, sizes: number[]): Workspace {
  if (sizes.length !== ws.groups.length) return ws;
  if (ws.sizes && ws.sizes.every((s, i) => Math.abs(s - sizes[i]) < 0.1)) return ws;
  return { ...ws, sizes };
}

/** A persisted value back into a workspace, dropping anything malformed. */
export function reviveWorkspace(raw: unknown): Workspace | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<Workspace>;
  if (!Array.isArray(r.groups) || r.groups.length === 0) return null;
  const groups: WsGroup[] = [];
  for (const g of r.groups.slice(0, MAX_GROUPS)) {
    if (!g || typeof g.id !== "string" || !Array.isArray(g.tabs)) continue;
    const seen = new Set<string>();
    // A virtual tab (search results) holds nothing a reload brings back.
    const tabs = g.tabs.filter((t): t is WsTab => !!t && typeof t.path === "string" && !isVirtualTab(t.path) && !seen.has(t.path) && !!seen.add(t.path));
    const active = typeof g.active === "string" && seen.has(g.active) ? g.active : (tabs[0]?.path ?? null);
    groups.push({ id: g.id, tabs: pinnedFirst(tabs), active });
  }
  const live = groups.filter((g) => g.tabs.length > 0);
  const kept = live.length ? live : [groups[0] ?? { id: "g1", tabs: [], active: null }];
  const activeId = kept.some((g) => g.id === r.activeGroup) ? r.activeGroup! : kept[0].id;
  return {
    groups: kept,
    activeGroup: activeId,
    orientation: r.orientation === "vertical" ? "vertical" : "horizontal",
    sizes: Array.isArray(r.sizes) && r.sizes.length === kept.length ? r.sizes : null,
    mru: Array.isArray(r.mru) ? r.mru.filter((k): k is string => typeof k === "string" && !isVirtualTab(k.slice(k.indexOf("\u0000") + 1))).slice(0, MAX_MRU) : [],
    closed: Array.isArray(r.closed) ? r.closed.filter((c) => c && typeof c.path === "string" && !isVirtualTab(c.path)).slice(0, MAX_CLOSED) : [],
  };
}

/** What persists: everything but one-shot reveal requests. */
export function serializeWorkspace(ws: Workspace): Workspace {
  return { ...ws, groups: ws.groups.map(({ reveal: _r, ...g }) => g) };
}
