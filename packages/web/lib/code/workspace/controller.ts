// The workspace's verbs, bound to the store: every tab bar click, palette
// command, vim ex command and shortcut reaches the model through these, so
// each does one thing one way. No React here.

import { useCodeStore, workspaceFor } from "../../../store/codeStore";
import { switchGroupNow } from "./groupRegistry";
import * as M from "./model";
import { isVirtualTab } from "./virtualTabs";

type Verb = (w: M.Workspace) => M.Workspace;

/** Store writes waiting for the next paint, by vault: the workspace they
 *  started from, the verbs since, and the result. */
const pending = new Map<string, { base: M.Workspace; verb: Verb; next: M.Workspace }>();
let flushScheduled = false;

function commit(vaultId: string): void {
  const p = pending.get(vaultId);
  if (!p) return;
  pending.delete(vaultId);
  // Someone else wrote the workspace meanwhile (a rename followed by
  // followFiles): the verbs run again on what is there now.
  useCodeStore.getState().updateWorkspace(vaultId, (cur) => (cur === p.base ? p.next : p.verb(cur)));
}

function flush(): void {
  flushScheduled = false;
  if (typeof document !== "undefined") document.removeEventListener("visibilitychange", flush);
  for (const vaultId of [...pending.keys()]) commit(vaultId);
}

/** After the next paint. A hidden document runs no animation frames, so the
 *  store would wait until the tab came back: there the write goes out on a
 *  timer, and a document hidden while it waits flushes right away. */
function scheduleFlush(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  if (typeof document !== "undefined" && document.hidden) {
    setTimeout(flush, 0);
    return;
  }
  requestAnimationFrame(() => setTimeout(flush, 0));
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", flush, { once: true });
}

/** Only which tab is active (and the recency list) changed. */
function onlyActiveChanged(a: M.Workspace, b: M.Workspace): boolean {
  if (a.groups.length !== b.groups.length || a.activeGroup !== b.activeGroup || a.closed !== b.closed || a.sizes !== b.sizes || a.orientation !== b.orientation) return false;
  return a.groups.every((g, i) => {
    const h = b.groups[i];
    return g.id === h.id && g.tabs.length === h.tabs.length && g.tabs.every((t, j) => t.path === h.tabs[j].path && t.preview === h.tabs[j].preview && t.pinned === h.tabs[j].pinned);
  });
}

/** Apply a verb. A group whose active tab changes shows the new file's buffer
 *  in its editor right here, inside the key or click handler. When that was
 *  the whole change, the store (and React's render of the tab strip and
 *  breadcrumbs) waits until after the next paint, so the switch lands in the
 *  same frame; any other verb first commits what is waiting. */
function update(vaultId: string, fn: Verb): void {
  const waiting = pending.get(vaultId);
  const before = waiting?.next ?? workspaceFor(vaultId);
  const next = fn(before);
  if (next === before) return;
  let shown = 0;
  let switched = 0;
  for (const g of next.groups) {
    const was = before.groups.find((b) => b.id === g.id);
    if (!g.active || !was || was.active === g.active) continue;
    switched++;
    if (switchGroupNow(vaultId, g.id, g.active)) shown++;
  }
  if (switched > 0 && shown === switched && onlyActiveChanged(before, next) && typeof requestAnimationFrame === "function") {
    pending.set(vaultId, waiting ? { base: waiting.base, verb: (w) => fn(waiting.verb(w)), next } : { base: before, verb: fn, next });
    scheduleFlush();
    return;
  }
  if (waiting) {
    commit(vaultId);
    useCodeStore.getState().updateWorkspace(vaultId, fn);
  } else useCodeStore.getState().updateWorkspace(vaultId, () => next);
}

export const workspaceActions = {
  open: (vaultId: string, path: string, opts?: M.OpenOptions) => update(vaultId, (w) => M.openTab(w, path, opts)),
  activate: (vaultId: string, groupId: string, path: string, at?: string) => update(vaultId, (w) => M.activateTab(w, groupId, path, at)),
  keepOpen: (vaultId: string, groupId: string, path: string) => update(vaultId, (w) => M.keepOpen(w, groupId, path)),
  keepOpenEverywhere: (vaultId: string, path: string) => update(vaultId, (w) => M.keepOpenEverywhere(w, path)),
  close: (vaultId: string, groupId: string, path: string) => update(vaultId, (w) => M.closeTab(w, groupId, path)),
  closeOthers: (vaultId: string, groupId: string, path: string) => update(vaultId, (w) => M.closeOthers(w, groupId, path)),
  closeToRight: (vaultId: string, groupId: string, path: string) => update(vaultId, (w) => M.closeToRight(w, groupId, path)),
  closeGroup: (vaultId: string, groupId: string) => update(vaultId, (w) => M.closeGroup(w, groupId)),
  only: (vaultId: string, groupId: string) => update(vaultId, (w) => M.onlyGroup(w, groupId)),
  reopen: (vaultId: string) => update(vaultId, (w) => M.reopenClosed(w)),
  pin: (vaultId: string, groupId: string, path: string) => update(vaultId, (w) => M.togglePinned(w, groupId, path)),
  move: (vaultId: string, from: string, path: string, to: string, index: number) => update(vaultId, (w) => M.moveTab(w, from, path, to, index)),
  // A virtual tab (search results) is one editor, never two views of one
  // document: splitting it moves it.
  split: (vaultId: string, groupId: string, path: string, dir: M.SplitDirection, opts?: { at?: string; preview?: boolean }) =>
    update(vaultId, (w) => {
      const next = M.splitTo(w, groupId, path, dir, opts);
      return isVirtualTab(path) && next.groups.length > w.groups.length ? { ...M.closeTab(next, groupId, path), closed: w.closed } : next;
    }),
  focusGroup: (vaultId: string, groupId: string) => update(vaultId, (w) => M.focusGroupId(w, groupId)),
  cycle: (vaultId: string, delta: number) => update(vaultId, (w) => M.cycleTab(w, delta)),
  goto: (vaultId: string, index: number) => update(vaultId, (w) => M.gotoTab(w, index)),
  sizes: (vaultId: string, sizes: number[]) => update(vaultId, (w) => M.setSizes(w, sizes)),
};
