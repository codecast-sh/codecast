// Tabs follow the files they show. A rename in the tree moves every tab, the
// closed-tab stack and the cursor history onto the new path, and unsaved
// edits move with it; a delete closes the file's clean tabs and forgets it;
// a folder never holds a tab. Driven by the vault store's file table and its
// move ledger (resolveRecentMove), the way bookmarks follow their files
// (lib/vault/bookmarksHost.ts), so the store's own file operations stay as
// they are.

import type { Text } from "@codemirror/state";
import { bufferKey, useCodeStore } from "../../../store/codeStore";
import { resolveRecentMove, useVaultStore } from "../../../store/vaultStore";
import { codeBuffers, currentState, encodeFileText, isDirty, savedDocField, type CodeBuffer } from "../buffers";
import { applyToBuffer } from "../fileSync";
import { clearHotExit, scheduleHotExit } from "../hotExit";
import { forgetPath, renameInHistory } from "./navHistory";
import * as M from "./model";

type FileTable = Record<string, { dir?: boolean } | undefined>;

/** A folder: a dir row, or the prefix of any scanned path (folders can exist
 *  in the table only as prefixes). */
export function isFolderPath(files: FileTable, path: string): boolean {
  const row = files[path];
  if (row) return !!row.dir;
  const prefix = `${path}/`;
  for (const p in files) if (p.startsWith(prefix)) return true;
  return false;
}

/** Every path a workspace follows: its tabs, its closed stack, and unsaved
 *  buffers whose tab was closed (their text follows a rename too). */
function namedPaths(vaultId: string, ws: M.Workspace): Set<string> {
  const out = new Set<string>();
  for (const g of ws.groups) for (const t of g.tabs) out.add(t.path);
  for (const c of ws.closed) out.add(c.path);
  for (const b of codeBuffers.dirty()) if (b.vaultId === vaultId) out.add(b.path);
  return out;
}

const update = (vaultId: string, fn: (w: M.Workspace) => M.Workspace) => useCodeStore.getState().updateWorkspace(vaultId, fn);

/** A path is gone: clean tabs close, and nothing reopens it. A tab with
 *  unsaved edits stays, showing the deleted strip and its Recreate. */
export function forgetFile(vaultId: string, path: string): void {
  const dirty = !!useCodeStore.getState().dirty[bufferKey(vaultId, path)];
  update(vaultId, (w) => M.forgetPath(w, path, { keepTabs: dirty }));
  if (!dirty) forgetPath(vaultId, path);
}

// ── unsaved edits follow a rename ─────────────────────────────────────────────
// A buffer's state is built for its path (language, LSP document, features),
// so a moved file gets a fresh buffer at the new path and the old one's
// unsaved text lands in it as one edit, dirty against what disk holds there.
//
// The text moves when the rename happens, whether or not its tab is on
// screen: it is held for hot exit under the new key at once (a reload before
// the tab is shown restores it there) and handed to the new path's buffer
// when one is created. The store renames optimistically and puts the old row
// back if the daemon refuses, so the old buffer, its dirty flag and its
// hot-exit copy stay until the daemon's answer is final, and a refused rename
// moves everything back.

interface CarriedEdits {
  doc: Text;
  mine: string;
  base: string;
  baseEtag: string;
}

/** Unsaved text waiting for its new path's buffer, by that buffer's key. */
const pendingEdits = new Map<string, CarriedEdits>();

interface TentativeRename {
  vaultId: string;
  from: string;
  to: string;
  /** The destination had a row before the move. The daemon refuses to rename
   *  onto an existing file, so the workspace waits for its answer instead of
   *  moving tabs onto another file. */
  onto: boolean;
  timer: ReturnType<typeof setTimeout>;
}

/** Renames the daemon may still refuse, by the old path's key. */
const tentative = new Map<string, TentativeRename>();

/** A rename op settles within the vault client's fetch timeout (10 s); a
 *  rename older than this was accepted. */
const RENAME_SETTLE_MS = 12_000;

/** The unsaved text a path holds: its dirty buffer, or text still waiting
 *  from an earlier rename. */
function editsAt(vaultId: string, path: string): CarriedEdits | null {
  const key = bufferKey(vaultId, path);
  const b = codeBuffers.get(key);
  if (b) {
    const state = currentState(b);
    if (!isDirty(state)) return null;
    return { doc: state.doc, mine: encodeFileText(state), base: encodeFileText(state, state.field(savedDocField)), baseEtag: b.baseEtag };
  }
  return pendingEdits.get(key) ?? null;
}

function carryEdits(vaultId: string, from: string, to: string): void {
  const edits = editsAt(vaultId, from);
  if (!edits) return;
  pendingEdits.delete(bufferKey(vaultId, from));
  const key = bufferKey(vaultId, to);
  const chrome = useCodeStore.getState();
  chrome.setDirty(key, true);
  scheduleHotExit(key, () => ({ key, vaultId, path: to, mine: edits.mine, base: () => edits.base, baseEtag: edits.baseEtag, savedAt: Date.now() }), 0);
  const existing = codeBuffers.get(key);
  // A buffer left from an earlier file at this path describes text that is
  // gone: a fresh one is built from disk and takes the edits.
  if (existing && !existing.view && !existing.dirty) codeBuffers.close(key);
  const target = codeBuffers.get(key);
  if (target) applyEdits(target, edits.doc);
  else pendingEdits.set(key, edits);
}

function applyEdits(b: CodeBuffer, doc: Text): void {
  const now = currentState(b).doc;
  if (!doc.eq(now)) applyToBuffer(b, { changes: { from: 0, to: now.length, insert: doc } });
}

/** Called when a buffer is first created: a rename's unsaved text lands here. */
export function adoptMovedEdits(b: CodeBuffer): void {
  const moved = pendingEdits.get(b.key);
  if (!moved) return;
  pendingEdits.delete(b.key);
  applyEdits(b, moved.doc);
}

/** The old path's buffer, dirty flag and hot-exit copy go: the rename stood. */
function dropOldPath(vaultId: string, path: string): void {
  const key = bufferKey(vaultId, path);
  const old = codeBuffers.get(key);
  if (old && !old.view) codeBuffers.close(key);
  const chrome = useCodeStore.getState();
  chrome.setDirty(key, false);
  chrome.setConflict(key, null);
  void clearHotExit(key);
}

function moveWorkspace(vaultId: string, from: string, to: string): void {
  update(vaultId, (w) => M.renamePath(w, from, to));
  renameInHistory(vaultId, from, to);
}

function beginRename(vaultId: string, from: string, to: string, onto: boolean): void {
  const key = bufferKey(vaultId, from);
  const prev = tentative.get(key);
  if (prev) clearTimeout(prev.timer);
  // Renaming straight back undoes a rename still in flight: the path it left
  // is in use again, so that rename never drops it.
  const undone = tentative.get(bufferKey(vaultId, to));
  if (undone?.to === from) {
    clearTimeout(undone.timer);
    tentative.delete(bufferKey(vaultId, to));
  }
  if (!onto) {
    carryEdits(vaultId, from, to);
    moveWorkspace(vaultId, from, to);
  }
  tentative.set(key, { vaultId, from, to, onto, timer: setTimeout(() => settleRename(key), RENAME_SETTLE_MS) });
}

/** Nothing names the old path again: no file at it (unless `ignoreRow`), no
 *  tab, no unsaved text waiting for it, no other rename landing on it. */
function oldPathFree(t: TentativeRename, ignoreRow: boolean): boolean {
  if (pendingEdits.has(bufferKey(t.vaultId, t.from))) return false;
  for (const o of tentative.values()) if (o !== t && o.vaultId === t.vaultId && o.to === t.from) return false;
  const ws = useCodeStore.getState().workspaces[t.vaultId];
  if (ws && (ws.closed.some((c) => c.path === t.from) || ws.groups.some((g) => g.tabs.some((x) => x.path === t.from)))) return false;
  if (ignoreRow) return true;
  const vault = useVaultStore.getState();
  return !(vault.activeVaultId === t.vaultId && vault.files[t.from]);
}

/** The daemon accepted the rename. The old path's leftovers go only while
 *  nothing uses that path again. `ignoreRow`: the row now at the old path is
 *  a new file, whose buffer must not be the moved file's leftover. */
function settleRename(key: string, ignoreRow = false): void {
  const t = tentative.get(key);
  if (!t) return;
  clearTimeout(t.timer);
  tentative.delete(key);
  if (t.onto) {
    carryEdits(t.vaultId, t.from, t.to);
    moveWorkspace(t.vaultId, t.from, t.to);
  }
  if (oldPathFree(t, ignoreRow)) dropOldPath(t.vaultId, t.from);
}

/** The daemon refused the rename and the store put the old row back:
 *  everything that followed it moves back, typing since included. */
function rollBack(t: TentativeRename): void {
  clearTimeout(t.timer);
  tentative.delete(bufferKey(t.vaultId, t.from));
  if (t.onto) return;
  const toKey = bufferKey(t.vaultId, t.to);
  // The text at the new path (its buffer, or text still waiting for one)
  // goes back the way it came.
  carryEdits(t.vaultId, t.to, t.from);
  if (codeBuffers.get(toKey)) codeBuffers.close(toKey);
  pendingEdits.delete(toKey);
  const chrome = useCodeStore.getState();
  chrome.setDirty(toKey, false);
  chrome.setConflict(toKey, null);
  void clearHotExit(toKey);
  moveWorkspace(t.vaultId, t.to, t.from);
}

/** Tests: settle every rename still waiting on the daemon, as if accepted. */
export function _settleRenamesForTests(): void {
  for (const key of [...tentative.keys()]) settleRename(key);
}

// ── the subscription ──────────────────────────────────────────────────────────

const nonEmpty = (t: FileTable) => {
  for (const _ in t) return true;
  return false;
};

/** This change moves some file onto `path`. */
function movedOnto(path: string, files: FileTable, prev: FileTable, movedTo: (path: string) => string | null): boolean {
  for (const p in prev) if (!files[p] && movedTo(p) === path) return true;
  return false;
}

/** What the file table's change did to the paths a workspace names. */
function reconcile(vaultId: string, files: FileTable, prev: FileTable, scanned: boolean, movedTo: (path: string) => string | null = resolveRecentMove): void {
  // A row back at a rename's old path: a refused rename (the store forgot the
  // move), a rename back onto it (beginRename below undoes the first), or a
  // new file made there, which means the rename stood.
  for (const t of [...tentative.values()]) {
    if (t.vaultId !== vaultId || !files[t.from] || prev[t.from]) continue;
    if (movedTo(t.from) !== t.to) rollBack(t);
    else if (!movedOnto(t.from, files, prev, movedTo)) settleRename(bufferKey(vaultId, t.from), true);
  }
  const ws = useCodeStore.getState().workspaces[vaultId];
  if (!ws) return;
  const renames: [string, string][] = [];
  const left: string[] = [];
  const folders: string[] = [];
  const unseen: string[] = [];
  const booting = !nonEmpty(prev);
  for (const path of namedPaths(vaultId, ws)) {
    const row = files[path];
    if (row) {
      if (row.dir) folders.push(path);
      continue;
    }
    if (prev[path]) {
      const to = movedTo(path);
      if (to) renames.push([path, to]);
      else left.push(path);
    } else if (scanned && isFolderPath(files, path)) {
      folders.push(path);
    } else if (booting) {
      unseen.push(path);
    }
  }
  for (const [from, to] of renames) beginRename(vaultId, from, to, !!prev[to]);
  for (const path of folders) update(vaultId, (w) => M.forgetPath(w, path));
  // Outside a rescan, a row leaves the table only when its file is deleted
  // (the store's delete, or the watcher). A rescan can drop rows that still
  // exist (its cap, its filters, show-all-files turned off), so it closes
  // nothing. Asking the daemon instead races the delete itself: the store
  // drops the row before the file leaves disk.
  if (!scanned) for (const path of left) forgetFile(vaultId, path);
  // The first table after a reload: tabs saved for files the scan does not
  // list may be past its cap, or deleted while the page was closed. No delete
  // is in flight now, so the daemon's answer is the truth.
  for (const path of unseen) {
    void useVaultStore
      .getState()
      .ensureEntry(path)
      .then((row) => {
        if (row === null || row?.dir) forgetFile(vaultId, path);
      });
  }
}

/** Tests: run one file-table change through, with a stand-in move ledger. */
export const _reconcileForTests = reconcile;

let started = false;

/** Follow file changes for every workspace, and settle `vaultId`'s saved
 *  tabs against the table as it stands (a workspace mounting after the scan
 *  landed never sees the table arrive). */
export function followVaultFiles(vaultId: string): void {
  if (typeof window === "undefined") return;
  const now = useVaultStore.getState();
  if (now.activeVaultId === vaultId && nonEmpty(now.files)) reconcile(vaultId, now.files, {}, true);
  if (started) return;
  started = true;
  useVaultStore.subscribe((s, prev) => {
    const vaultId = s.activeVaultId;
    if (!vaultId || vaultId !== prev.activeVaultId) return;
    // Hiding ignored files drops their rows locally, which is a filter like a
    // rescan's, never a delete.
    const scanned = s.scannedAt !== prev.scannedAt || s.showIgnoredFiles !== prev.showIgnoredFiles;
    if (s.files === prev.files && !scanned) return;
    // An empty table on either side is a vault switch or a scan in flight,
    // never a vault whose every file went.
    if (!nonEmpty(s.files)) return;
    if (!nonEmpty(prev.files)) return reconcile(vaultId, s.files, {}, true);
    reconcile(vaultId, s.files, prev.files, scanned);
  });
}
