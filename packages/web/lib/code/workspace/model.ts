// The code workspace as data: editor groups in a two-level split (lanes along
// the outer axis, groups stacked across it inside each lane), each with its own
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
// - A split along the outer axis adds a lane; a split across it divides the
//   group inside its lane, as vim's :sp after :vs does. Groups the split did
//   not touch keep their sizes; the new one takes half of the one it came from.

import { isVirtualTab } from "./virtualTabs";

export interface WsTab {
  path: string;
  preview?: true;
  pinned?: true;
  /** Where the cursor was, and the line at the top of the view, carried
   *  across reloads (1-based). */
  cursor?: { line: number; col: number; top?: number };
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

/** One cell along the outer axis: the next `count` groups, in order, stacked
 *  across it. */
export interface WsLane {
  count: number;
  /** Percent per group inside the lane; null means equal. */
  sizes: number[] | null;
}

export interface Workspace {
  /** Every group in layout order, lane by lane. */
  groups: WsGroup[];
  activeGroup: string;
  /** The outer axis: "horizontal" sets lanes side by side (each stacking its
   *  groups top to bottom), "vertical" stacks lanes (each laying its groups
   *  side by side). */
  orientation: "horizontal" | "vertical";
  /** Percent per lane along the outer axis; null means equal. */
  sizes: number[] | null;
  /** How the groups fall into lanes. Absent (an older workspace): one lane a
   *  group. */
  lanes?: WsLane[];
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
  return { groups: [{ id: "g1", tabs: [], active: null }], activeGroup: "g1", orientation: "horizontal", sizes: null, lanes: [{ count: 1, sizes: null }], mru: [], closed: [] };
}

// ── lanes ───────────────────────────────────────────────────────────────────

/** The lanes, one per group when the workspace carries none (or a stale set). */
export function lanesOf(ws: Workspace): WsLane[] {
  const lanes = ws.lanes;
  if (lanes && lanes.length && lanes.every((l) => l.count > 0) && lanes.reduce((n, l) => n + l.count, 0) === ws.groups.length) return lanes;
  return ws.groups.map(() => ({ count: 1, sizes: null }));
}

/** The groups of each lane, in order. */
export function laneGroups(ws: Workspace): WsGroup[][] {
  let at = 0;
  return lanesOf(ws).map((l) => ws.groups.slice(at, (at += l.count)));
}

/** Where the group at flat index `at` sits: its lane, its place in it, and
 *  the flat index the lane starts at. */
function locate(lanes: WsLane[], at: number): { lane: number; index: number; start: number } {
  let start = 0;
  for (let lane = 0; lane < lanes.length; lane++) {
    if (at < start + lanes[lane].count) return { lane, index: at - start, start };
    start += lanes[lane].count;
  }
  return { lane: lanes.length - 1, index: 0, start: start - lanes[lanes.length - 1].count };
}

const equalShares = (n: number) => Array.from({ length: n }, () => 100 / n);
const sharesOf = (sizes: number[] | null | undefined, n: number) => (sizes && sizes.length === n ? sizes : equalShares(n));

/** Shares with the one at `at` split in two halves. */
function halve(sizes: number[] | null, n: number, at: number): number[] | null {
  if (!sizes) return null;
  const s = sharesOf(sizes, n);
  return [...s.slice(0, at), s[at] / 2, s[at] / 2, ...s.slice(at + 1)];
}

/** Shares without the one at `at`, the rest scaled back up to the whole. */
function dropShare(sizes: number[] | null, n: number, at: number): number[] | null {
  if (!sizes || n < 2) return null;
  const rest = sharesOf(sizes, n).filter((_, i) => i !== at);
  const total = rest.reduce((a, b) => a + b, 0) || 1;
  return rest.map((x) => (x * 100) / total);
}

const flip = (o: Workspace["orientation"]): Workspace["orientation"] => (o === "horizontal" ? "vertical" : "horizontal");

/** One lane holding several groups is the same layout as one lane each
 *  along the other axis; keep the second, so a lane only ever exists to
 *  stack groups beside another lane. */
function normalizeLanes(ws: Workspace): Workspace {
  const lanes = lanesOf(ws);
  if (lanes.length === 1 && lanes[0].count > 1) {
    return { ...ws, orientation: flip(ws.orientation), sizes: lanes[0].sizes, lanes: ws.groups.map(() => ({ count: 1, sizes: null })) };
  }
  return lanes === ws.lanes ? ws : { ...ws, lanes };
}

export interface GroupRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Each group's place in the workspace, as fractions of its width and height. */
export function groupRects(ws: Workspace): Map<string, GroupRect> {
  const out = new Map<string, GroupRect>();
  const lanes = lanesOf(ws);
  const outer = sharesOf(ws.sizes, lanes.length);
  const horizontal = ws.orientation === "horizontal";
  let a = 0;
  laneGroups(ws).forEach((groups, li) => {
    const span = outer[li] / 100;
    const inner = sharesOf(lanes[li].sizes, groups.length);
    let b = 0;
    groups.forEach((g, gi) => {
      const len = inner[gi] / 100;
      out.set(g.id, horizontal ? { x: a, y: b, w: span, h: len } : { x: b, y: a, w: len, h: span });
      b += len;
    });
    a += span;
  });
  return out;
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
  // The groups left keep their sizes; the gone one's share goes to its lane
  // (or, a lane emptied, to the other lanes).
  const lanes = lanesOf(ws);
  const { lane, index } = locate(lanes, at);
  const l = lanes[lane];
  const sizes = l.count === 1 ? dropShare(ws.sizes, lanes.length, lane) : ws.sizes;
  const nextLanes = l.count === 1 ? lanes.filter((_, i) => i !== lane) : lanes.map((x, i) => (i === lane ? { count: x.count - 1, sizes: dropShare(x.sizes, x.count, index) } : x));
  const next = normalizeLanes({ ...forgetMru(ws, groupId, null), groups, sizes, lanes: nextLanes });
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

/** Whether a group can split: false at the group limit, where vim says
 *  "E36: Not enough room" and nothing moves. */
export const canSplitMore = (ws: Workspace) => ws.groups.length < MAX_GROUPS;

/** Open `path` in a new group beside `groupId`, right of it or below it. Along
 *  the outer axis that is a new lane; across it, the group divides inside its
 *  lane. At the group limit nothing changes. */
export function splitTo(ws: Workspace, groupId: string, path: string, direction: SplitDirection, opts: { at?: string; preview?: boolean } = {}): Workspace {
  const at = ws.groups.findIndex((g) => g.id === groupId);
  if (at < 0 || !canSplitMore(ws)) return ws;
  const id = newGroupId(ws);
  const axis = direction === "down" ? "vertical" : "horizontal";
  const group: WsGroup = { id, tabs: [], active: null };
  const lanes = lanesOf(ws);
  const { lane, index, start } = locate(lanes, at);
  let next: Workspace;
  if (ws.groups.length === 1) {
    next = { ...ws, groups: [ws.groups[0], group], orientation: axis, sizes: null, lanes: [{ count: 1, sizes: null }, { count: 1, sizes: null }] };
  } else if (axis === ws.orientation) {
    // A new lane after this one, taking half of this lane's share.
    const end = start + lanes[lane].count;
    next = {
      ...ws,
      groups: [...ws.groups.slice(0, end), group, ...ws.groups.slice(end)],
      sizes: halve(ws.sizes, lanes.length, lane),
      lanes: [...lanes.slice(0, lane + 1), { count: 1, sizes: null }, ...lanes.slice(lane + 1)],
    };
  } else {
    const l = lanes[lane];
    next = {
      ...ws,
      groups: [...ws.groups.slice(0, at + 1), group, ...ws.groups.slice(at + 1)],
      lanes: lanes.map((x, i) => (i === lane ? { count: l.count + 1, sizes: halve(l.sizes, l.count, index) } : x)),
    };
  }
  return openTab(next, path, { groupId: id, at: opts.at, preview: opts.preview });
}

export type FocusDirection = "left" | "right" | "up" | "down";

/** The group in a direction from the focused one: the one sharing that edge
 *  with it, the longest shared stretch first. */
export function neighborGroup(ws: Workspace, dir: FocusDirection): string | null {
  const rects = groupRects(ws);
  const r = rects.get(ws.activeGroup);
  if (!r) return null;
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
  let best: string | null = null;
  let bestOverlap = 1e-6;
  for (const [id, c] of rects) {
    if (id === ws.activeGroup) continue;
    const touches =
      dir === "right" ? near(c.x, r.x + r.w) : dir === "left" ? near(c.x + c.w, r.x) : dir === "down" ? near(c.y, r.y + r.h) : near(c.y + c.h, r.y);
    if (!touches) continue;
    const across = dir === "left" || dir === "right" ? Math.min(r.y + r.h, c.y + c.h) - Math.max(r.y, c.y) : Math.min(r.x + r.w, c.x + c.w) - Math.max(r.x, c.x);
    if (across > bestOverlap) {
      best = id;
      bestOverlap = across;
    }
  }
  return best;
}

/** The group `delta` places from the focused one in layout order, wrapping
 *  (vim's <C-w>w and <C-w>W). Null with one group. */
export function cycleGroup(ws: Workspace, delta: number): string | null {
  const n = ws.groups.length;
  if (n < 2) return null;
  const at = Math.max(0, ws.groups.findIndex((g) => g.id === ws.activeGroup));
  return ws.groups[(((at + delta) % n) + n) % n].id;
}

/** The group focused before this one (vim's <C-w>p): the newest recent tab
 *  that sits in another group still open. */
export function previousGroup(ws: Workspace): string | null {
  for (const key of ws.mru) {
    const { groupId } = splitMruKey(key);
    if (groupId !== ws.activeGroup && groupById(ws, groupId)) return groupId;
  }
  return null;
}

/** The smallest share a group keeps, matching the panel's own minimum. */
export const MIN_GROUP_SIZE = 12;

/** The run of sizes a change along `axis` acts on for the focused group: the
 *  lanes when the axis is the outer one, else the focused group's lane. Null
 *  when nothing sits beside it along that axis. */
function sizeRun(ws: Workspace, axis: "width" | "height"): { lane: number | null; at: number; sizes: number[] } | null {
  const lanes = lanesOf(ws);
  const pos = locate(lanes, Math.max(0, ws.groups.findIndex((g) => g.id === ws.activeGroup)));
  if ((axis === "width") === (ws.orientation === "horizontal")) {
    return lanes.length > 1 ? { lane: null, at: pos.lane, sizes: sharesOf(ws.sizes, lanes.length) } : null;
  }
  const l = lanes[pos.lane];
  return l.count > 1 ? { lane: pos.lane, at: pos.index, sizes: sharesOf(l.sizes, l.count) } : null;
}

/** Grow (or shrink, `by` < 0) the focused group by `by` percent, taken from
 *  its neighbors along that axis in proportion to the room they have (vim's
 *  <C-w>+ - < >). */
export function resizeGroup(ws: Workspace, axis: "width" | "height", by: number): Workspace {
  const run = by ? sizeRun(ws, axis) : null;
  if (!run) return ws;
  const { sizes, at } = run;
  const max = 100 - MIN_GROUP_SIZE * (sizes.length - 1);
  const target = Math.min(max, Math.max(MIN_GROUP_SIZE, sizes[at] + by));
  const delta = target - sizes[at];
  if (Math.abs(delta) < 0.1) return ws;
  // Growing takes from the room above each one's minimum; shrinking gives
  // back to every other group evenly.
  const room = sizes.map((s, i) => (i === at ? 0 : delta > 0 ? s - MIN_GROUP_SIZE : 1));
  const total = room.reduce((a, b) => a + b, 0);
  return setSizes(ws, run.lane, sizes.map((s, i) => (i === at ? target : s - (delta * room[i]) / total)));
}

/** The focused group as large as the others allow (vim's <C-w>_ and <C-w>|). */
export function maximizeGroup(ws: Workspace, axis: "width" | "height"): Workspace {
  return resizeGroup(ws, axis, 100);
}

/** Every group the same size (vim's <C-w>=). */
export function equalizeGroups(ws: Workspace): Workspace {
  const lanes = lanesOf(ws);
  if (ws.sizes === null && lanes.every((l) => l.sizes === null)) return ws;
  return { ...ws, sizes: null, lanes: lanes.map((l) => (l.sizes ? { ...l, sizes: null } : l)) };
}

/** The focused group's siblings for exchange and rotate: the groups of its
 *  lane when it shares one, else the lanes. */
function swapScope(ws: Workspace): { lanes: WsLane[]; lane: number; index: number; start: number; inLane: boolean } | null {
  const at = ws.groups.findIndex((g) => g.id === ws.activeGroup);
  if (ws.groups.length < 2 || at < 0) return null;
  const lanes = lanesOf(ws);
  const pos = locate(lanes, at);
  return { lanes, ...pos, inLane: lanes[pos.lane].count > 1 };
}

/** Reorder the lanes; their groups and inner sizes go with them, each place
 *  keeps its outer size. */
function reorderLanes(ws: Workspace, lanes: WsLane[], order: number[]): Workspace {
  const blocks = laneGroups({ ...ws, lanes });
  return { ...ws, groups: order.flatMap((i) => blocks[i]), lanes: order.map((i) => lanes[i]) };
}

/** Reorder the groups of one lane; each place keeps its size. */
function reorderInLane(ws: Workspace, start: number, count: number, order: number[]): Workspace {
  const block = ws.groups.slice(start, start + count);
  return { ...ws, groups: [...ws.groups.slice(0, start), ...order.map((i) => block[i]), ...ws.groups.slice(start + count)] };
}

/** Swap the focused group with the next one in its row or column, or the
 *  previous one when it is last (vim's <C-w>x). Each place keeps its size,
 *  and focus stays in the place, now showing the other group. */
export function exchangeGroup(ws: Workspace): Workspace {
  const s = swapScope(ws);
  if (!s) return ws;
  const n = s.inLane ? s.lanes[s.lane].count : s.lanes.length;
  const at = s.inLane ? s.index : s.lane;
  const other = at + 1 < n ? at + 1 : at - 1;
  const order = Array.from({ length: n }, (_, i) => (i === at ? other : i === other ? at : i));
  const next = s.inLane ? reorderInLane(ws, s.start, n, order) : reorderLanes(ws, s.lanes, order);
  const place = s.inLane ? s.start + at : laneGroups(next).slice(0, at).reduce((k, block) => k + block.length, 0);
  return focusGroupId(next, next.groups[place].id);
}

/** Rotate the focused group's row or column one place forward (`delta` 1,
 *  vim's <C-w>r) or back (-1, <C-w>R). Focus moves with its group. */
export function rotateGroups(ws: Workspace, delta: 1 | -1): Workspace {
  const s = swapScope(ws);
  if (!s) return ws;
  const n = s.inLane ? s.lanes[s.lane].count : s.lanes.length;
  const order = Array.from({ length: n }, (_, i) => (((i - delta) % n) + n) % n);
  return s.inLane ? reorderInLane(ws, s.start, n, order) : reorderLanes(ws, s.lanes, order);
}

export type GroupEdge = "left" | "right" | "top" | "bottom";

/** Move the focused group to an edge, full length (vim's <C-w>H L K J). The
 *  rest keep their arrangement beside it. */
export function moveGroupToEdge(ws: Workspace, edge: GroupEdge): Workspace {
  const at = ws.groups.findIndex((g) => g.id === ws.activeGroup);
  if (ws.groups.length < 2 || at < 0) return ws;
  const group = ws.groups[at];
  const orientation = edge === "left" || edge === "right" ? "horizontal" : "vertical";
  const lanes = lanesOf(ws);
  const { lane } = locate(lanes, at);
  // The others, as lanes of the old layout.
  let rest = lanes.map((l, i) => (i === lane ? l.count - 1 : l.count)).filter((c) => c > 0);
  // Along the other axis the old lanes turn: one lane of several becomes one
  // lane each, and single lanes side by side become one lane. (Two others at
  // most, so these are the only shapes.)
  if (orientation !== ws.orientation) rest = rest.length === 1 ? Array.from({ length: rest[0] }, () => 1) : [rest.reduce((a, b) => a + b, 0)];
  const others = ws.groups.filter((g) => g !== group);
  const first = edge === "left" || edge === "top";
  const groups = first ? [group, ...others] : [...others, group];
  const counts = first ? [1, ...rest] : [...rest, 1];
  const same = orientation === ws.orientation && groups.every((g, i) => g === ws.groups[i]) && counts.length === lanes.length && counts.every((c, i) => c === lanes[i].count);
  if (same) return ws;
  return normalizeLanes({ ...ws, groups, orientation, sizes: null, lanes: counts.map((count) => ({ count, sizes: null })) });
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

/** The alternate file (vim's `:b#`, <C-^>): the tab used before the focused
 *  one, in the focused group when it has one, else in any group. */
export function alternateTab(ws: Workspace): MruEntry | null {
  const group = activeGroup(ws);
  const others = mruTabs(ws).filter((e) => !(e.groupId === group.id && e.path === group.active));
  return others.find((e) => e.groupId === group.id) ?? others.find((e) => e.path !== group.active) ?? null;
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

/** Sizes from a drag or a command: the lanes' (`lane` null) or one lane's groups'. */
export function setSizes(ws: Workspace, lane: number | null, sizes: number[]): Workspace {
  const lanes = lanesOf(ws);
  const same = (have: number[] | null) => !!have && have.length === sizes.length && have.every((s, i) => Math.abs(s - sizes[i]) < 0.1);
  if (lane === null) {
    if (sizes.length !== lanes.length || same(ws.sizes)) return ws;
    return { ...ws, sizes };
  }
  const l = lanes[lane];
  if (!l || sizes.length !== l.count || same(l.sizes)) return ws;
  return { ...ws, lanes: lanes.map((x, i) => (i === lane ? { ...x, sizes } : x)) };
}

/** A persisted value back into a workspace, dropping anything malformed. */
export function reviveWorkspace(raw: unknown): Workspace | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<Workspace>;
  if (!Array.isArray(r.groups) || r.groups.length === 0) return null;
  const groups: WsGroup[] = [];
  // Which stored lane each group came from, so the layout survives a group
  // dropped as malformed or empty.
  const stored = r.groups.slice(0, MAX_GROUPS);
  const storedLanes = Array.isArray(r.lanes) && r.lanes.every((l) => l && Number.isInteger(l.count) && l.count > 0) && r.lanes.reduce((n, l) => n + l.count, 0) === r.groups.length ? r.lanes : null;
  const laneAt = (i: number) => (storedLanes ? locate(storedLanes, i).lane : i);
  const laneOfGroup = new Map<WsGroup, number>();
  for (const [i, g] of stored.entries()) {
    if (!g || typeof g.id !== "string" || !Array.isArray(g.tabs)) continue;
    const seen = new Set<string>();
    // A virtual tab (search results) holds nothing a reload brings back.
    const tabs = g.tabs.filter((t): t is WsTab => !!t && typeof t.path === "string" && !isVirtualTab(t.path) && !seen.has(t.path) && !!seen.add(t.path));
    const active = typeof g.active === "string" && seen.has(g.active) ? g.active : (tabs[0]?.path ?? null);
    const group = { id: g.id, tabs: pinnedFirst(tabs), active };
    laneOfGroup.set(group, laneAt(i));
    groups.push(group);
  }
  const live = groups.filter((g) => g.tabs.length > 0);
  const kept = live.length ? live : [groups[0] ?? { id: "g1", tabs: [], active: null }];
  const activeId = kept.some((g) => g.id === r.activeGroup) ? r.activeGroup! : kept[0].id;
  // Rebuild the lanes from what was kept; a size stays only where its run
  // kept every member.
  const laneIds = [...new Set(kept.map((g) => laneOfGroup.get(g) ?? -1))];
  const lanes: WsLane[] = laneIds.map((id) => {
    const count = kept.filter((g) => (laneOfGroup.get(g) ?? -1) === id).length;
    const prev = storedLanes?.[id];
    return { count, sizes: prev && prev.count === count && Array.isArray(prev.sizes) && prev.sizes.length === count ? prev.sizes : null };
  });
  const lanesWhole = storedLanes ? lanes.length === storedLanes.length : lanes.length === r.groups.length;
  return normalizeLanes({
    groups: kept,
    activeGroup: activeId,
    orientation: r.orientation === "vertical" ? "vertical" : "horizontal",
    sizes: lanesWhole && Array.isArray(r.sizes) && r.sizes.length === lanes.length ? r.sizes : null,
    lanes,
    mru: Array.isArray(r.mru) ? r.mru.filter((k): k is string => typeof k === "string" && !isVirtualTab(k.slice(k.indexOf("\u0000") + 1))).slice(0, MAX_MRU) : [],
    closed: Array.isArray(r.closed) ? r.closed.filter((c) => c && typeof c.path === "string" && !isVirtualTab(c.path)).slice(0, MAX_CLOSED) : [],
  });
}

/** What persists: everything but one-shot reveal requests. */
export function serializeWorkspace(ws: Workspace): Workspace {
  return { ...ws, groups: ws.groups.map(({ reveal: _r, ...g }) => g) };
}
