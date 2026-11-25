// The code workspace survives a reload: each vault's groups, tabs, focus and
// history are written to localStorage a moment after they change (and at once
// when the page hides), and read back synchronously the first time the vault's
// workspace is asked for, so the tabs paint on the first frame.
//
// Each tab's cursor rides along. The editor's own state lives in the buffer
// manager, which this module must not import (it loads in the page bundle,
// CodeMirror does not), so the editor chunk registers a reader for it.

import { reviveWorkspace, serializeWorkspace, type Workspace } from "./model";

const KEY = (vaultId: string) => `codecast:code-workspace:v1:${vaultId}`;

type CursorReader = (vaultId: string, path: string) => { line: number; col: number } | null;
let readCursor: CursorReader | null = null;

/** The editor chunk tells persistence where each open buffer's cursor is. */
export function setCursorReader(reader: CursorReader): void {
  readCursor = reader;
}

export function loadWorkspace(vaultId: string): Workspace | null {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(KEY(vaultId));
    return raw ? reviveWorkspace(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

function withCursors(vaultId: string, ws: Workspace): Workspace {
  const base = serializeWorkspace(ws);
  if (!readCursor) return base;
  const read = readCursor;
  return {
    ...base,
    groups: base.groups.map((g) => ({
      ...g,
      tabs: g.tabs.map((t) => {
        const cursor = read(vaultId, t.path);
        return cursor ? { ...t, cursor } : t;
      }),
    })),
  };
}

export function saveWorkspace(vaultId: string, ws: Workspace): void {
  try {
    localStorage.setItem(KEY(vaultId), JSON.stringify(withCursors(vaultId, ws)));
  } catch {
    // Storage full or blocked: the workspace lasts for this page.
  }
}

/**
 * Keep the store's workspaces written: a change is saved after `delayMs`, and
 * everything pending (with fresh cursors) when the page hides. Returns the stop.
 */
export function persistWorkspaces(
  subscribe: (fn: () => void) => () => void,
  read: () => Record<string, Workspace>,
  delayMs = 400,
): () => void {
  let last = read();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const dirty = new Set<string>();
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    const all = read();
    for (const id of dirty) if (all[id]) saveWorkspace(id, all[id]);
    dirty.clear();
  };
  const off = subscribe(() => {
    const next = read();
    if (next === last) return;
    for (const id of Object.keys(next)) if (next[id] !== last[id]) dirty.add(id);
    last = next;
    if (!dirty.size) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, delayMs);
  });
  // Cursors move without the workspace changing: the page hiding writes them.
  const onHide = () => {
    for (const id of Object.keys(read())) dirty.add(id);
    flush();
  };
  window.addEventListener("pagehide", onHide);
  const onVisibility = () => document.visibilityState === "hidden" && onHide();
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    off();
    flush();
    window.removeEventListener("pagehide", onHide);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}
