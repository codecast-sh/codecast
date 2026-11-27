// Vault store: local-first state for the markdown vault surface.
//
// The vault's canonical store is the local filesystem, reached over the
// daemon's loopback bridge (lib/vault/client.ts). This store is deliberately
// separate from inboxStore — vault data never flows through Convex sync in
// local mode. Boot order: hydrate from IndexedDB and paint immediately, then
// discover the daemon endpoint, scan-diff, fetch changed markdown bodies, and
// hold a WS subscription for live file events.

import { create } from "zustand";
import type { ConvexReactClient } from "convex/react";
import type { VaultFileEntry, VaultInfo, VaultWsEvent } from "@codecast/shared/contracts";
import { isVaultMarkdownPath, VAULT_MAX_PREVIEW_BYTES } from "@codecast/shared/contracts";
import { getTerminalEndpoint, lastDiscoveryFailure, loopbackFailureReason } from "../lib/terminal/endpoint";
import {
  hostEndpoint,
  hostOfEndpoint,
  hostOfVault,
  onHostEndpointChange,
  reestablishHost,
  setHostEstablisher,
  setLocalEndpoint,
  tagHostVault,
} from "../lib/vault/hosts/routes";
import {
  fetchRemoteBody,
  fetchRemoteNotes,
  listRemoteVaults,
  remoteNotesToFileTable,
} from "../lib/vault/remoteMirror";
import {
  DEFAULT_DAILY_SETTINGS,
  adjacentDailyNote,
  dailyNotePath,
  expandTemplate,
  shiftDays,
} from "../lib/vault/dailyNotes";
import {
  getVaultEndpoint,
  listVaults,
  locateVault,
  readFailureLabel,
  readVaultFile,
  scanVault,
  subscribeVaultEvents,
  writeVaultFile,
  vaultOp,
  VaultRequestError,
  VaultWriteConflict,
  type VaultEndpoint,
} from "../lib/vault/client";
import {
  bodyKey,
  deleteVaultBodies,
  loadVaultBodies,
  loadVaultBookmarks,
  loadVaultMeta,
  saveVaultBodies,
  saveVaultBookmarks,
  saveVaultMeta,
  type VaultBodyRow,
} from "../lib/vault/db";
import {
  addBookmark as addBookmarkTo,
  findBookmark,
  removeBookmark as removeBookmarkFrom,
  retargetBookmarks as retargetList,
  retitleBookmark,
  sortBookmarks,
  type BookmarkItem,
} from "../lib/vault/bookmarks";
import {
  ancestorDirs,
  joinVaultPath,
  nextUntitledName,
  renameMoves,
  siblingNames,
} from "../lib/vault/explorerModel";
import { applySpanEdits, planFolderRewrites, type FileRewrite } from "../lib/vault/linkRewrite";
import { syncVaultIndex, vaultIndex } from "../lib/vault/indexSingleton";

import type {
  HostConnectionState,
  HostFallback,
  RenameReport,
  VaultBody,
  VaultConnection,
  VaultRightPanelTab,
  VaultState,
} from "./vaultTypes";
export type { HostConnectionState, HostFallback, RenameReport, VaultBody, VaultConnection, VaultRightPanelTab };

const BODY_FETCH_CONCURRENCY = 12;
// Rewrites are writes, not reads: kept modest so a folder move touching a
// hundred notes doesn't flood the daemon's write path.
const REWRITE_CONCURRENCY = 4;
const PERSIST_DEBOUNCE_MS = 800;
// A "reset" WS event arriving right after connect duplicates the scan the
// connect path just ran; scans started within this window are skipped.
const SCAN_DEDUPE_MS = 2000;

let wsDispose: (() => void) | null = null;
// Generation counter: every (re)subscription bumps it, and callbacks from an
// older generation are ignored — a vault switch mid-scan can otherwise leave
// the socket bound to the vault the user left.
let wsGen = 0;
let convexRef: ConvexReactClient | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let lastScanStartedAt = 0;
// Pending IDB writes are keyed BY VAULT and flushed for every vault with
// staged work — flushing against "whichever vault is active" corrupted the
// cache when the user switched vaults inside the debounce window.
const pendingBodyRows = new Map<string, Map<string, VaultBodyRow>>();
const pendingBodyDeletes = new Map<string, Set<string>>();

function pendingRowsFor(vaultId: string): Map<string, VaultBodyRow> {
  let m = pendingBodyRows.get(vaultId);
  if (!m) pendingBodyRows.set(vaultId, (m = new Map()));
  return m;
}

function pendingDeletesFor(vaultId: string): Set<string> {
  let s = pendingBodyDeletes.get(vaultId);
  if (!s) pendingBodyDeletes.set(vaultId, (s = new Set()));
  return s;
}

function schedulePersist() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const s = useVaultStore.getState();
    // File-table meta persists only for the active vault (it's the only one
    // whose table lives in the store); bodies flush for every staged vault.
    const active = s.activeVaultId;
    if (active && s.scannedAt) {
      const info = s.vaults.find((v) => v.id === active);
      if (info) {
        // The cache holds the default scope only: ignored rows are a snapshot
        // the next scan re-derives, and a cached boot with the toggle off must
        // not paint them for a frame.
        void saveVaultMeta({ id: active, info, files: Object.values(withoutIgnored(s.files)), scannedAt: s.scannedAt, isRepo: s.isRepo });
      }
    }
    for (const [vaultId, rows] of pendingBodyRows) {
      if (rows.size) void saveVaultBodies([...rows.values()]);
      pendingBodyRows.delete(vaultId);
    }
    for (const [vaultId, dels] of pendingBodyDeletes) {
      if (dels.size) void deleteVaultBodies(vaultId, [...dels]);
      pendingBodyDeletes.delete(vaultId);
    }
  }, PERSIST_DEBOUNCE_MS);
}

function stageBody(vaultId: string, path: string, body: VaultBody) {
  pendingRowsFor(vaultId).set(path, {
    key: bodyKey(vaultId, path),
    vaultId,
    path,
    content: body.content,
    mtime: body.mtime,
    etag: body.etag,
  });
  pendingDeletesFor(vaultId).delete(path);
  schedulePersist();
}

function stageDelete(vaultId: string, path: string) {
  pendingRowsFor(vaultId).delete(path);
  pendingDeletesFor(vaultId).add(path);
  schedulePersist();
}

// Recent renames, old path → new path, so an editor instance unmounting AFTER
// a rename can redirect its final flush instead of resurrecting the old file
// (review finding, R8). Entries are short-lived — the flush happens within the
// same tick-ish window as the rename.
const recentMoves = new Map<string, { to: string; at: number }>();

export function resolveRecentMove(path: string): string | null {
  const hit = recentMoves.get(path);
  if (!hit) return null;
  if (Date.now() - hit.at > 30_000) {
    recentMoves.delete(path);
    return null;
  }
  return hit.to;
}

function forgetMoves(moves: { from: string; to: string }[]) {
  for (const m of moves) recentMoves.delete(m.from);
}

function recordMoves(moves: { from: string; to: string }[]) {
  const now = Date.now();
  for (const m of moves) recentMoves.set(m.from, { to: m.to, at: now });
  // Prune anything stale so the map can't grow unbounded.
  for (const [k, v] of recentMoves) if (now - v.at > 30_000) recentMoves.delete(k);
}

// Paths the person deleted here (the tree's Delete), as against a file that
// left disk under the app (an agent's rm, a branch switch, a stash): an editor
// tab closes for the first and stays, marked deleted, for the second, so the
// file comes back into it when it returns.
const recentDeletes = new Map<string, number>();

/** The person deleted this path (or a folder holding it) moments ago. */
export function resolveRecentDelete(path: string): boolean {
  const now = Date.now();
  for (const [p, at] of recentDeletes) {
    if (now - at > 30_000) recentDeletes.delete(p);
    else if (p === path || path.startsWith(`${p}/`)) return true;
  }
  return false;
}

// Bookmark ids only have to be unique within one vault's list; the counter
// keeps two bookmarks made in the same millisecond apart.
let bookmarkSeq = 0;

// Last-opened vault id, so the IDB cache can paint on a boot where the daemon
// is unreachable (discovery failing must not blank a vault we've already seen).
const LAST_VAULT_KEY = "cast_vault_last";

function readLastVaultId(): string | null {
  try {
    return localStorage.getItem(LAST_VAULT_KEY);
  } catch {
    return null;
  }
}

function writeLastVaultId(id: string): void {
  try {
    localStorage.setItem(LAST_VAULT_KEY, id);
  } catch {}
}

// The vault LIST lives in localStorage rather than in the IndexedDB cache
// beside the file tables, and deliberately: the picker has to be populated on
// the very first render, and an IDB read — however fast — is a frame of empty
// list first. It matters more now that the list includes every project on the
// machine: discovering those costs the daemon a readdir per project, and first
// paint must never wait on that. The whole list is a few hundred short records.
const VAULT_LIST_KEY = "cast_vault_list";

function readCachedVaults(): VaultInfo[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(VAULT_LIST_KEY) ?? "null");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (v): v is VaultInfo =>
        !!v && typeof v === "object" && typeof v.id === "string" && typeof v.root === "string",
    );
  } catch {
    return [];
  }
}

function writeCachedVaults(vaults: VaultInfo[]): void {
  try {
    localStorage.setItem(VAULT_LIST_KEY, JSON.stringify(vaults));
  } catch {}
}

// "Show all files", per vault. localStorage and not the IDB prefs table for the
// same reason the vault list lives here: the tree paints on the first frame,
// and an async read would render the wrong file set and then flip.
const SHOW_ALL_KEY = "cast_vault_show_all";

/**
 * Whether a vault opens showing everything on disk. The default follows what
 * the folder IS (a discovered project, or any git checkout once the scan says
 * so): a code project whose tree hides its own source is the wrong
 * first impression, and a notes folder full of dotfiles is too. An explicit
 * choice, once made, outranks both.
 */
const RIGHT_PANEL_KEY = "vault.rightPanelOpen";

function readRightPanelOpen(): boolean {
  try {
    return localStorage.getItem(RIGHT_PANEL_KEY) === "1";
  } catch {
    return false;
  }
}

const TREE_LAYOUT_KEY = "vault.treeLayout";

/** Whether a full-tab Files page shows its tree, and how wide (px; null is
 *  the default share). A split-pane leaf keeps its own, unsaved. */
export interface TreeLayout {
  open: boolean;
  px: number | null;
}

export function readTreeLayout(): TreeLayout {
  try {
    const raw = JSON.parse(localStorage.getItem(TREE_LAYOUT_KEY) ?? "null") as Partial<TreeLayout> | null;
    if (raw && typeof raw === "object") return { open: raw.open !== false, px: typeof raw.px === "number" && raw.px > 0 ? Math.round(raw.px) : null };
  } catch {}
  return { open: true, px: null };
}

export function writeTreeLayout(patch: Partial<TreeLayout>): void {
  try {
    const next = { ...readTreeLayout(), ...patch };
    localStorage.setItem(TREE_LAYOUT_KEY, JSON.stringify(next));
  } catch {}
}

const SHOW_IGNORED_KEY = "cast_vault_show_ignored";

/** A per-vault boolean the user set explicitly, or null when they never did. */
function readVaultFlag(key: string, vaultId: string): boolean | null {
  try {
    const stored = localStorage.getItem(`${key}:${vaultId}`);
    if (stored === "1") return true;
    if (stored === "0") return false;
  } catch {}
  return null;
}

function writeVaultFlag(key: string, vaultId: string, value: boolean): void {
  try {
    localStorage.setItem(`${key}:${vaultId}`, value ? "1" : "0");
  } catch {}
}

function readShowAllFiles(vaultId: string, vaults: VaultInfo[], isRepo = false): boolean {
  return readVaultFlag(SHOW_ALL_KEY, vaultId) ?? (isRepo || vaults.find((v) => v.id === vaultId)?.kind === "project");
}

/** What a cached boot knows of the root being a checkout, until the scan says. */
function cachedRepo(vaultId: string, vaults: VaultInfo[], meta: { isRepo?: boolean }): Partial<Pick<VaultState, "isRepo" | "showAllFiles">> {
  return meta.isRepo ? { isRepo: true, showAllFiles: readShowAllFiles(vaultId, vaults, true) } : {};
}

function readShowIgnoredFiles(vaultId: string): boolean {
  return readVaultFlag(SHOW_IGNORED_KEY, vaultId) ?? false;
}

/** Fetch a set of file bodies with bounded concurrency, patching the store as
 *  each lands so the UI streams in rather than waiting for the batch.
 *
 *  `persist` is off for code: notes are cached to IDB so the vault reads
 *  offline, but a repo's source is megabytes of text nobody edits here, and
 *  refetching it on demand costs one local round trip. */
async function fetchBodies(
  ep: VaultEndpoint,
  vaultId: string,
  paths: string[],
  { persist = true }: { persist?: boolean } = {},
): Promise<Record<string, string>> {
  /** Each path whose read brought no body, with why (readFailureLabel). */
  const failures: Record<string, string> = {};
  const queue = [...paths];
  const workers = Array.from({ length: Math.min(BODY_FETCH_CONCURRENCY, queue.length) }, async () => {
    while (queue.length) {
      const path = queue.shift();
      if (!path) return;
      const before = useVaultStore.getState().bodies[path];
      try {
        const file = await readVaultFile(ep, vaultId, path);
        const s = useVaultStore.getState();
        if (s.activeVaultId !== vaultId) return;
        const now = s.bodies[path];
        // A body written while this read was in flight (a save, a recreate's
        // guarded PUT) wins unless the read is strictly newer: the read may
        // have caught the disk mid-sequence, before that write landed.
        if (file && now && now !== before && file.mtime <= now.mtime) {
          useVaultStore.setState((st) => ({ loadingPaths: omit(st.loadingPaths, path) }));
        } else if (file) {
          const body: VaultBody = { content: file.content, mtime: file.mtime, etag: file.etag, size: file.size, ...(file.lockedMode ? { lockedMode: file.lockedMode } : {}) };
          useVaultStore.setState((st) => ({
            bodies: { ...st.bodies, [path]: body },
            loadingPaths: omit(st.loadingPaths, path),
          }));
          if (persist) stageBody(vaultId, path, body);
        } else {
          failures[path] = "Not found";
          useVaultStore.setState((st) => ({ loadingPaths: omit(st.loadingPaths, path) }));
        }
      } catch (e) {
        failures[path] = readFailureLabel(e);
        useVaultStore.setState((st) => ({ loadingPaths: omit(st.loadingPaths, path) }));
      }
    }
  });
  await Promise.all(workers);
  return failures;
}

function omit<T extends Record<string, unknown>>(rec: T, key: string): T {
  if (!(key in rec)) return rec;
  const next = { ...rec };
  delete next[key];
  return next;
}

interface PathSnapshot {
  path: string;
  file: VaultFileEntry | undefined;
  body: VaultBody | undefined;
  expanded: boolean | undefined;
}

type PathTables = Pick<VaultState, "files" | "bodies" | "expandedDirs">;

/** Every path-keyed value a rename could disturb, for a precise rollback. */
function snapshotPaths(s: PathTables, paths: string[]): PathSnapshot[] {
  return paths.map((path) => ({
    path,
    file: s.files[path],
    body: s.bodies[path],
    expanded: s.expandedDirs[path],
  }));
}

/** Put the snapshotted keys back exactly as they were, and undo the path
 *  rewrite in the recents list. */
function restorePaths(snapshot: PathSnapshot[], moves: [string, string][]): void {
  useVaultStore.setState((st) => {
    const files = { ...st.files };
    const bodies = { ...st.bodies };
    const expandedDirs = { ...st.expandedDirs };
    for (const { path, file, body, expanded } of snapshot) {
      if (file) files[path] = file;
      else delete files[path];
      if (body) bodies[path] = body;
      else delete bodies[path];
      if (expanded === undefined) delete expandedDirs[path];
      else expandedDirs[path] = expanded;
    }
    const undo = new Map(moves.map(([from, to]) => [to, from]));
    return { files, bodies, expandedDirs, recentPaths: st.recentPaths.map((p) => undo.get(p) ?? p) };
  });
}

/** Rewrite every path-keyed table for a list of path→path moves. Sources are
 *  read before anything is deleted, so a move whose destination is another
 *  move's source still lands intact. */
function applyMoves(moves: [string, string][]): void {
  useVaultStore.setState((st) => {
    const sources = snapshotPaths(st, moves.map(([from]) => from));
    const files = { ...st.files };
    const bodies = { ...st.bodies };
    const expandedDirs = { ...st.expandedDirs };
    for (const { path } of sources) {
      delete files[path];
      delete bodies[path];
      delete expandedDirs[path];
    }
    moves.forEach(([, to], i) => {
      const src = sources[i];
      if (!src) return;
      if (src.file) files[to] = { ...src.file, path: to };
      if (src.body) bodies[to] = src.body;
      if (src.expanded !== undefined) expandedDirs[to] = src.expanded;
    });
    const remap = new Map(moves);
    return { files, bodies, expandedDirs, recentPaths: st.recentPaths.map((p) => remap.get(p) ?? p) };
  });
}

/**
 * Apply a link-rewrite plan, one file at a time through the normal writeFile
 * path so every rewrite carries its If-Match etag and a 409 lands in the same
 * conflict flow a hand edit would. Nothing is forced.
 *
 * The plan was built from the index BEFORE the move; applySpanEdits re-checks
 * the text at every span, so a file that changed in between loses only the
 * edits that no longer match, and says so.
 */
async function applyLinkRewrites(plan: FileRewrite[]): Promise<Omit<RenameReport, "path"> | null> {
  if (!plan.length) return null;
  let filesChanged = 0;
  let linksRewritten = 0;
  let skipped = 0;

  const queue = [...plan];
  const workers = Array.from({ length: Math.min(REWRITE_CONCURRENCY, queue.length) }, async () => {
    while (queue.length) {
      const job = queue.shift();
      if (!job) return;
      const store = useVaultStore.getState();
      const body = store.bodies[job.source];
      if (!body) {
        skipped += job.edits.length;
        continue;
      }
      const result = applySpanEdits(body.content, job.edits);
      skipped += result.skipped;
      if (!result.applied) continue;
      try {
        await store.writeFile(job.source, result.content);
      } catch (e) {
        skipped += result.applied;
        // Keep the first reason: a strip that names one file the user can go
        // look at beats one that names the last of five.
        useVaultStore.setState((s) => ({
          opError:
            s.opError ??
            `Couldn't update links in ${job.source}: ${e instanceof Error ? e.message : String(e)}`,
        }));
        continue;
      }
      // A conflicting write leaves the file on disk untouched: those links are
      // still pointing at the old name until the user resolves the conflict.
      if (useVaultStore.getState().conflicts[job.source]) {
        skipped += result.applied;
        continue;
      }
      filesChanged++;
      linksRewritten += result.applied;
    }
  });
  await Promise.all(workers);
  return { filesChanged, linksRewritten, skipped };
}

/** Shared body of newNote/newFolder: take the first free name, let the create's
 *  optimistic write paint the row, reveal it, and hand it to inline rename —
 *  all before the daemon answers. */
async function createThenRename(
  dir: string,
  base: string,
  ext: string,
  create: (path: string) => Promise<void>,
): Promise<string | null> {
  const store = useVaultStore.getState();
  const path = joinVaultPath(dir, nextUntitledName(siblingNames(Object.keys(store.files), dir), base, ext));
  const ancestors = ancestorDirs(path);
  if (ancestors.length) store.setDirsExpanded(ancestors, true);
  const pending = create(path); // the optimistic row lands before the first await
  useVaultStore.setState({ renameTarget: path });
  try {
    await pending;
  } catch (e) {
    // Stated here rather than left to createFile/createFolder: the refusal
    // they don't cover — no daemon at all — throws before they set opError,
    // and a create button that does nothing at all is the worst outcome.
    useVaultStore.setState((s) => ({
      renameTarget: s.renameTarget === path ? null : s.renameTarget,
      opError: `Couldn't create ${path}: ${e instanceof Error ? e.message : String(e)}`,
    }));
    return null;
  }
  return path;
}

/** Whether an open code editor holds this file. A checkout or an agent's
 *  delete-and-rewrite brings a file back as an 'add' after the 'removed'
 *  dropped its body, and an editor still open on it needs the text again.
 *  The editor registers this when its chunk loads (lib/code/fileSync.ts), so
 *  the store never imports CodeMirror and holds no list of its own. */
let codeBodyHeld: (vaultId: string, path: string) => boolean = () => false;
export function setCodeBodyHolder(held: (vaultId: string, path: string) => boolean): void {
  codeBodyHeld = held;
}

// Watcher events land in the file table in batches. Each write copies the
// whole table (20,000 rows in a repo) and wakes everything that reads it (the
// tree, git status, quick open), so a checkout's thousands of events, or an
// agent's steady saves, cost one write per batch instead of one per file.
const WS_BATCH_MS = 100;
/** Path to its new row, or null when it was removed; in arrival order. */
let pendingRows = new Map<string, VaultFileEntry | null>();
let pendingVault: string | null = null;
let pendingTimer: ReturnType<typeof setTimeout> | null = null;

function flushWsRows(): void {
  if (pendingTimer) clearTimeout(pendingTimer);
  pendingTimer = null;
  const rows = pendingRows;
  const vaultId = pendingVault;
  pendingRows = new Map();
  pendingVault = null;
  if (!rows.size || useVaultStore.getState().activeVaultId !== vaultId) return;
  useVaultStore.setState((st) => {
    const files = { ...st.files };
    let bodies = st.bodies;
    for (const [path, row] of rows) {
      if (row) files[path] = row;
      else {
        delete files[path];
        if (path in bodies) bodies = omit(bodies, path);
      }
    }
    return { files, bodies };
  });
}

function queueWsRow(vaultId: string, path: string, row: VaultFileEntry | null): void {
  if (pendingVault !== vaultId) flushWsRows();
  pendingVault = vaultId;
  pendingRows.delete(path);
  pendingRows.set(path, row);
  pendingTimer ??= setTimeout(flushWsRows, WS_BATCH_MS);
}

function applyWsEvent(ev: VaultWsEvent) {
  const s = useVaultStore.getState();
  const vaultId = s.activeVaultId;
  if (!vaultId || ev.vault !== vaultId) return;
  if (ev.type === "reset") {
    flushWsRows();
    // The server sends reset right after every successful hello; when the
    // connect path just scanned, this would be a duplicate whole-vault walk.
    if (Date.now() - lastScanStartedAt > SCAN_DEDUPE_MS) void s.refresh();
    return;
  }
  if (ev.type === "removed") {
    queueWsRow(vaultId, ev.path, null);
    stageDelete(vaultId, ev.path);
    return;
  }
  // add | change
  queueWsRow(vaultId, ev.path, { path: ev.path, mtime: ev.mtime, size: ev.size });
  // Markdown is always held, so it always refetches. A code file refetches only
  // when someone has it open (its body is held, or an editor holds the file
  // after a 'removed' dropped the body), which keeps a repo's build output
  // from pulling megabytes through here.
  const isMarkdown = isVaultMarkdownPath(ev.path);
  const known = s.bodies[ev.path];
  // Skip refetch when the change is our own write echo (same mtime already stored).
  if (known && known.mtime === ev.mtime) return;
  if (s.endpoint && (isMarkdown || codeBodyHeld(vaultId, ev.path))) {
    void fetchBodies(s.endpoint, vaultId, [ev.path], { persist: isMarkdown });
  } else if (known && !isMarkdown) {
    // Text no editor holds is not read again on every write: it goes, and the
    // next view of the file reads it.
    useVaultStore.setState((st) => ({ bodies: omit(st.bodies, ev.path) }));
  }
}

/** Tests: deliver a watcher event as the subscription would. */
export const _applyVaultWsEventForTests = (ev: VaultWsEvent) => {
  applyWsEvent(ev);
  flushWsRows();
};
/** Tests: deliver a watcher event and leave it in the batch. */
export const _queueVaultWsEventForTests = (ev: VaultWsEvent) => applyWsEvent(ev);

/** The file table without the rows a scan flagged ignored. */
function withoutIgnored(files: Record<string, VaultFileEntry>): Record<string, VaultFileEntry> {
  if (!Object.values(files).some((f) => f.ignored)) return files;
  const out: Record<string, VaultFileEntry> = {};
  for (const [p, f] of Object.entries(files)) if (!f.ignored) out[p] = f;
  return out;
}

async function syncActiveVault(ep: VaultEndpoint, vaultId: string): Promise<void> {
  lastScanStartedAt = Date.now();
  const scan = await scanVault(ep, vaultId, { ignored: useVaultStore.getState().showIgnoredFiles });
  const s = useVaultStore.getState();
  if (s.activeVaultId !== vaultId) return;

  const files: Record<string, VaultFileEntry> = {};
  // The toggle may have gone off while the scan was in flight; honor the
  // current value rather than the one the request was built from.
  for (const f of scan.files) if (!f.ignored || s.showIgnoredFiles) files[f.path] = f;
  for (const f of Object.values(s.linkedFiles)) files[f.path] ??= f;

  // Diff against what we have (from IDB or a previous scan): fetch new/changed
  // markdown, drop entries that no longer exist. Ignored markdown is never
  // prefetched: a worktree's copy of the docs or a generated bundle would
  // otherwise land in the search index and the graph as a note.
  const prevBodies = s.bodies;
  const toFetch: string[] = [];
  const heldCode: string[] = [];
  for (const f of scan.files) {
    if (f.dir) continue;
    const known = prevBodies[f.path];
    const changed = !known || known.mtime !== f.mtime;
    // An open code buffer is read again when its file moved while the socket
    // was down (a daemon restart, a dropped WS): the watcher events that would
    // have told it are gone, and it would keep showing text disk no longer
    // holds. One batch with the notes, limited to buffers held (contract 10).
    if (isVaultMarkdownPath(f.path)) {
      if (!f.ignored && changed) toFetch.push(f.path);
    } else if (changed && codeBodyHeld(vaultId, f.path)) heldCode.push(f.path);
  }
  const removed = Object.keys(prevBodies).filter((p) => !files[p]);

  const nextBodies = { ...prevBodies };
  for (const p of removed) delete nextBodies[p];

  const loading: Record<string, true> = {};
  for (const p of toFetch) loading[p] = true;

  useVaultStore.setState({
    files,
    bodies: nextBodies,
    scannedAt: scan.scanned_at,
    isRepo: scan.repo,
    // A git checkout is a code project whatever registered it (a /files?path=
    // link, `cast vault add`), and only the scan knows the root is one.
    showAllFiles: readShowAllFiles(vaultId, s.vaults, scan.repo),
    connection: "connected",
    loadingPaths: loading,
  });
  for (const p of removed) stageDelete(vaultId, p);
  schedulePersist();

  // Code is never cached across reloads: only the open buffer wants it.
  await Promise.all([fetchBodies(ep, vaultId, toFetch), heldCode.length ? fetchBodies(ep, vaultId, heldCode, { persist: false }) : null]);
}

/** The endpoint requests for `vaultId` start from: its host's forward, or
 *  this machine's daemon. */
function endpointFor(vaultId: string | null, local: VaultEndpoint | null): VaultEndpoint | null {
  const host = hostOfVault(vaultId);
  return host ? hostEndpoint(host) : local;
}

/** This machine's daemon: `localEndpoint`, or an `endpoint` set without it
 *  (by anything that predates the field) unless that one reaches a host. */
export function localEndpointOf(s: Pick<VaultState, "localEndpoint" | "endpoint">): VaultEndpoint | null {
  return s.localEndpoint ?? (s.endpoint && !hostOfEndpoint(s.endpoint) ? s.endpoint : null);
}

/** An endpoint to start a request for some vault from. The request is
 *  routed by its vault id (lib/vault/hosts/routes.ts), so a host buffer whose
 *  forward is closed still saves (routing opens the forward), and a local
 *  buffer still saves while a host vault is active. */
export function requestEndpointOf(s: Pick<VaultState, "localEndpoint" | "endpoint">): VaultEndpoint | null {
  return s.endpoint ?? s.localEndpoint;
}

/** The vaults this machine's daemon serves, the only ones the boot cache
 *  and the last-vault pointer may name: a host vault needs its forward. */
function localOnly(vaults: VaultInfo[]): VaultInfo[] {
  return vaults.filter((v) => !hostOfVault(v.id));
}

export const useVaultStore = create<VaultState>((set, get) => ({
  connection: "idle",
  endpoint: null,
  localEndpoint: null,
  hostStates: {},
  hostFallback: null,
  setHostFallback: (fallback) => set({ hostFallback: fallback }),
  connectHost: async (deviceId) => {
    const local = localEndpointOf(get());
    if (local?.deviceId === deviceId) return "local";
    const setState = (state: HostConnectionState) => set((s) => ({ hostStates: { ...s.hostStates, [deviceId]: state } }));
    // The forward is opened by this machine's daemon; with none, there is no way in.
    if (!local || !convexRef) {
      setState("unreachable");
      return "unreachable";
    }
    if (get().hostStates[deviceId] !== "connected") setState("connecting");
    const ep = await reestablishHost(deviceId);
    setState(ep ? "connected" : "unreachable");
    return ep ? "host" : "unreachable";
  },
  adoptHostVault: (vault, deviceId) => {
    set((s) => {
      const named = tagHostVault(vault, deviceId);
      const at = s.vaults.findIndex((v) => v.id === named.id);
      if (at >= 0 && s.vaults[at].name === named.name) return {};
      const vaults = at >= 0 ? s.vaults.map((v, i) => (i === at ? named : v)) : [...s.vaults, named];
      return { vaults, ...(s.activeVaultId === named.id ? { endpoint: hostEndpoint(deviceId) } : {}) };
    });
  },
  vaults: readCachedVaults(),
  remoteVaults: [],
  isRemote: false,
  unreachableReason: "none",
  unreachableDetail: null,
  activeVaultId: null,
  files: {},
  bodies: {},
  scannedAt: null,
  loadingPaths: {},
  conflicts: {},
  expandedDirs: {},
  recentPaths: [],
  sortMode: "name-asc" as const,
  showAllFiles: false,
  showIgnoredFiles: false,
  isRepo: false,
  renameTarget: null,
  quickSwitchOpen: false,
  leftPaneTab: "files" as const,
  searchQuery: "",
  rightPanelTab: "backlinks" as const,
  rightPanelOpen: readRightPanelOpen(),
  selectedTag: null,
  tagPaneRequest: 0,
  bookmarks: [],
  bookmarksVaultId: null,
  opError: null,
  lastRenameReport: null,

  clearOpError: () => set({ opError: null }),
  linkedFiles: {},
  adoptLinkedFile: (entry) =>
    set((s) => ({
      linkedFiles: { ...s.linkedFiles, [entry.path]: entry },
      files: { ...s.files, [entry.path]: s.files[entry.path] ?? entry },
    })),
  ensureEntry: async (path) => {
    const { endpoint, activeVaultId, vaults, files, isRemote } = get();
    if (files[path]) return files[path];
    const root = vaults.find((v) => v.id === activeVaultId)?.root;
    if (!endpoint || !root || isRemote) return undefined;
    try {
      const located = await locateVault(endpoint, `${root.replace(/\/$/, "")}/${path}`);
      if (get().activeVaultId !== activeVaultId) return undefined;
      const row = located?.vault.id === activeVaultId ? located.entry : undefined;
      if (!row) return null;
      if (!row.dir) get().adoptLinkedFile(row);
      return row;
    } catch {
      return undefined;
    }
  },
  adoptVault: (vault) =>
    set((s) => {
      if (s.vaults.some((v) => v.id === vault.id)) return {};
      const vaults = [...s.vaults, vault];
      writeCachedVaults(localOnly(vaults));
      return { vaults };
    }),
  clearRenameReport: () => set({ lastRenameReport: null }),

  setQuickSwitchOpen: (open) => set({ quickSwitchOpen: open, ...(open ? {} : { quickSwitchSeed: null }) }),
  quickSwitchSeed: null,
  openQuickSwitch: (seed) => set({ quickSwitchOpen: true, quickSwitchSeed: seed ?? null }),

  setLeftPaneTab: (tab) => set({ leftPaneTab: tab }),
  setSearchQuery: (query) => set({ searchQuery: query }),
  searchPaneRequest: 0,
  openSearch: (query) =>
    set((s) => ({
      leftPaneTab: "search",
      searchQuery: query ?? s.searchQuery,
      searchPaneRequest: s.searchPaneRequest + 1,
    })),

  loadBookmarks: async () => {
    const vaultId = get().activeVaultId;
    // Clear first: the list on screen belongs to the vault we just left.
    set({ bookmarks: [], bookmarksVaultId: null });
    if (!vaultId) return;
    const stored = await loadVaultBookmarks(vaultId);
    if (get().activeVaultId !== vaultId) return;
    // Anything bookmarked while the read was in flight belongs to this vault
    // too — merged rather than replaced, or a click landing in that window is
    // silently thrown away.
    const added = get().bookmarks;
    const merged = added.reduce(addBookmarkTo, stored);
    set({ bookmarks: sortBookmarks(merged), bookmarksVaultId: vaultId });
    if (merged !== stored) void saveVaultBookmarks(vaultId, merged);
  },

  addBookmark: (item) => {
    const { bookmarks, activeVaultId } = get();
    const next = addBookmarkTo(bookmarks, {
      ...item,
      id: `bm-${Date.now().toString(36)}-${(bookmarkSeq++).toString(36)}`,
      createdAt: Date.now(),
    } as BookmarkItem);
    if (next === bookmarks) return;
    set({ bookmarks: next });
    if (activeVaultId) void saveVaultBookmarks(activeVaultId, next);
  },

  toggleBookmark: (item) => {
    const existing = findBookmark(get().bookmarks, item);
    if (existing) get().removeBookmark(existing.id);
    else get().addBookmark(item);
  },

  removeBookmark: (id) => {
    const { bookmarks, activeVaultId } = get();
    const next = removeBookmarkFrom(bookmarks, id);
    if (next === bookmarks) return;
    set({ bookmarks: next });
    if (activeVaultId) void saveVaultBookmarks(activeVaultId, next);
  },

  setBookmarkTitle: (id, title) => {
    const { bookmarks, activeVaultId } = get();
    const next = retitleBookmark(bookmarks, id, title);
    if (next === bookmarks) return;
    set({ bookmarks: next });
    if (activeVaultId) void saveVaultBookmarks(activeVaultId, next);
  },

  retargetBookmarks: (resolve) => {
    const { bookmarks, activeVaultId } = get();
    const next = retargetList(bookmarks, resolve);
    if (next === bookmarks) return;
    set({ bookmarks: next });
    if (activeVaultId) void saveVaultBookmarks(activeVaultId, next);
  },

  setSortMode: (mode) => set({ sortMode: mode }),

  setShowAllFiles: (value) => {
    const vaultId = get().activeVaultId;
    if (vaultId) writeVaultFlag(SHOW_ALL_KEY, vaultId, value);
    set({ showAllFiles: value });
  },

  setShowIgnoredFiles: (value) => {
    const vaultId = get().activeVaultId;
    if (vaultId) writeVaultFlag(SHOW_IGNORED_KEY, vaultId, value);
    if (value) {
      // The ignored entries live only on the daemon: a rescan brings them.
      set({ showIgnoredFiles: true });
      void get().refresh();
      return;
    }
    // Off is local: drop the flagged rows now rather than after a round trip.
    set((s) => ({ showIgnoredFiles: false, files: { ...withoutIgnored(s.files), ...s.linkedFiles } }));
  },

  loadTextBody: async (path, opts) => {
    const { endpoint, activeVaultId, bodies, files, loadingPaths } = get();
    if (!endpoint || !activeVaultId) return null;
    if (bodies[path] || loadingPaths[path]) return null;
    // Decline BEFORE the round trip: the scan already told us how big it is, so
    // a 40MB bundle never crosses the wire, let alone reaches the highlighter.
    if ((files[path]?.size ?? 0) > (opts?.maxBytes ?? VAULT_MAX_PREVIEW_BYTES)) return "Too large";
    set((s) => ({ loadingPaths: { ...s.loadingPaths, [path]: true } }));
    const failures = await fetchBodies(endpoint, activeVaultId, [path], { persist: false });
    return failures[path] ?? null;
  },
  releaseCodeBody: (vaultId, path) => {
    const s = get();
    if (s.activeVaultId !== vaultId || isVaultMarkdownPath(path) || !(path in s.bodies)) return;
    set((st) => ({ bodies: omit(st.bodies, path) }));
  },
  adoptBody: (vaultId, path, body) => {
    if (get().activeVaultId !== vaultId) return;
    set((s) => {
      const row = s.files[path];
      return {
        bodies: { ...s.bodies, [path]: body },
        files: row ? { ...s.files, [path]: { ...row, mtime: body.mtime, size: body.size ?? row.size } } : s.files,
      };
    });
    if (isVaultMarkdownPath(path)) stageBody(vaultId, path, body);
  },
  setRenameTarget: (path) => set({ renameTarget: path }),

  setRightPanelTab: (tab) => set({ rightPanelTab: tab }),
  setRightPanelOpen: (open) => {
    try {
      localStorage.setItem(RIGHT_PANEL_KEY, open ? "1" : "0");
    } catch {}
    set({ rightPanelOpen: open });
  },
  revealTarget: null,
  requestReveal: (path) => {
    const dirs = path.split("/").slice(0, -1);
    const acc: string[] = [];
    let cur = "";
    for (const seg of dirs) {
      cur = cur ? `${cur}/${seg}` : seg;
      acc.push(cur);
    }
    set((s) => {
      const expandedDirs = { ...s.expandedDirs };
      for (const d of acc) expandedDirs[d] = true;
      return { expandedDirs, revealTarget: path };
    });
  },
  clearReveal: () => set({ revealTarget: null }),
  setSelectedTag: (tag) => set({ selectedTag: tag }),
  openTagPane: (tag) => {
    set((s) => ({ rightPanelTab: "tags", selectedTag: tag, tagPaneRequest: s.tagPaneRequest + 1 }));
  },

  toggleDir: (path) =>
    set((s) => ({ expandedDirs: { ...s.expandedDirs, [path]: !s.expandedDirs[path] } })),

  setDirsExpanded: (paths, expanded) =>
    set((s) => {
      const next = { ...s.expandedDirs };
      for (const p of paths) next[p] = expanded;
      return { expandedDirs: next };
    }),

  noteOpened: (path) =>
    set((s) => ({
      recentPaths: [path, ...s.recentPaths.filter((p) => p !== path)].slice(0, 50),
    })),

  reconnect: async () => {
    if (convexRef) await get().connect(convexRef, { force: true });
  },
  connect: async (convex, opts) => {
    convexRef = convex;
    // Reopening a host's forward goes through this machine's daemon and the
    // relay: the same lookup the terminal uses for a cloud pane. Only a
    // forward counts; this machine's own endpoint is never a host's.
    setHostEstablisher(async (deviceId) => {
      // The header's machine chip shows the reconnect while it runs.
      set((s) => ({ hostStates: { ...s.hostStates, [deviceId]: "connecting" } }));
      const ep = await getTerminalEndpoint(convex, { deviceId }).catch(() => null);
      const local = localEndpointOf(useVaultStore.getState());
      const forward = ep && ep.deviceId === deviceId && ep.port !== local?.port ? ep : null;
      // Settled here too: a forward that was still open comes back unchanged
      // and fires no endpoint change.
      set((s) => ({ hostStates: { ...s.hostStates, [deviceId]: forward ? "connected" : "unreachable" } }));
      return forward;
    });
    const st = get();
    if (st.connection === "discovering") return;
    // The picker before anything else: this is synchronous, so the list of
    // vaults and projects is on screen in the first frame rather than after
    // discovery, the roots call and a relay round-trip.
    if (!st.vaults.length) {
      const cached = readCachedVaults();
      if (cached.length) set({ vaults: cached });
    }
    set({ connection: st.scannedAt ? st.connection : "discovering" });

    // Local-first boot: paint the last vault's IDB cache NOW, in parallel with
    // endpoint discovery — the explorer must never sit blank behind a relay
    // round-trip when we've seen this vault before.
    const remembered = st.activeVaultId ?? readLastVaultId();
    if (remembered && !st.scannedAt) {
      void (async () => {
        const [meta, bodyRows] = await Promise.all([loadVaultMeta(remembered), loadVaultBodies(remembered)]);
        const cur = get();
        // Only if nothing fresher landed while we read.
        if (!meta || cur.scannedAt !== null || (cur.activeVaultId && cur.activeVaultId !== remembered)) return;
        const files: Record<string, VaultFileEntry> = {};
        for (const f of meta.files) files[f.path] = f;
        const bodies: Record<string, VaultBody> = {};
        for (const r of bodyRows) bodies[r.path] = { content: r.content, mtime: r.mtime, etag: r.etag };
        set((s) => ({
          activeVaultId: s.activeVaultId ?? remembered,
          vaults: s.vaults.length ? s.vaults : [meta.info],
          files,
          bodies,
          scannedAt: meta.scannedAt,
          ...cachedRepo(remembered, s.vaults.length ? s.vaults : [meta.info], meta),
          connection: s.connection === "connected" ? s.connection : "cached",
        }));
      })();
    }

    const ep = await getVaultEndpoint(convex, opts);
    if (!ep) {
      // No endpoint — but the last-used vault's IDB cache is still readable.
      // selectVault paints it and leaves connection as "cached"; only a truly
      // never-seen vault lands on the no-daemon teaching state.
      const remembered = get().activeVaultId ?? readLastVaultId();
      setLocalEndpoint(null);
      set({ endpoint: null, localEndpoint: null, unreachableReason: lastDiscoveryFailure(), unreachableDetail: null });
      if (remembered && !get().scannedAt) {
        await get().selectVault(remembered);
      }
      set((s) => ({ connection: s.scannedAt ? "cached" : "no-daemon" }));
      // Even with no local daemon, a mirrored vault from another machine is
      // still readable — offer it rather than dead-ending.
      void listRemoteVaults(convex)
        .then((remote) => set({ remoteVaults: remote }))
        .catch(() => {});
      return;
    }
    let vaults: VaultInfo[] = [];
    try {
      vaults = await listVaults(ep);
    } catch (e) {
      // The probe succeeded, so the daemon is alive; only a 404 means it truly
      // predates the vault routes. Anything else (a refusal, a fetch the
      // browser rejected) used to be reported as "too old", which sent people
      // to update a daemon that was already current.
      const status = e instanceof VaultRequestError ? e.status : 0;
      setLocalEndpoint(ep);
      set((s) => ({
        connection: s.scannedAt ? "cached" : "no-daemon",
        endpoint: endpointFor(s.activeVaultId, ep),
        localEndpoint: ep,
        unreachableReason: loopbackFailureReason(status),
        unreachableDetail: e instanceof Error ? e.message : String(e),
      }));
      return;
    }
    setLocalEndpoint(ep);
    // Host vaults opened in this window stay listed: a rediscovery of this
    // machine's daemon says nothing about them.
    set((s) => ({
      endpoint: endpointFor(s.activeVaultId, ep),
      localEndpoint: ep,
      vaults: [...vaults, ...s.vaults.filter((v) => hostOfVault(v.id) && !vaults.some((l) => l.id === v.id))],
      unreachableReason: "none",
      unreachableDetail: null,
    }));
    // Seeds the picker on the next cold boot, before discovery answers.
    writeCachedVaults(vaults);

    // Remote mirrors are additive: they list alongside local vaults so a vault
    // from another machine is reachable without leaving the surface.
    void listRemoteVaults(convex)
      .then((remote) => set({ remoteVaults: remote }))
      .catch(() => {});

    const active = get().activeVaultId ?? readLastVaultId() ?? vaults[0]?.id ?? null;
    if (active) await get().selectVault(active);
    else set({ connection: "connected" });
  },

  selectVault: async (vaultId) => {
    const prev = get().activeVaultId;
    const host = hostOfVault(vaultId);
    if (!host) writeLastVaultId(vaultId);
    // Dispose the old subscription up front — never after the awaits below,
    // where a concurrent select could already have subscribed the new vault.
    wsDispose?.();
    wsDispose = null;
    // Unconditional, NOT folded into the reset branch below: the local-first
    // boot sets activeVaultId straight from the IDB cache, so by the time
    // selectVault runs for the remembered vault `prev` already equals it — and
    // a project vault would have opened with the toggle off.
    set({
      showAllFiles: readShowAllFiles(vaultId, get().vaults, prev === vaultId && get().isRepo),
      showIgnoredFiles: readShowIgnoredFiles(vaultId),
      // A vault this path opens is a daemon's, never the mirror openRemoteVault left behind.
      isRemote: false,
      endpoint: endpointFor(vaultId, localEndpointOf(get())),
    });
    if (prev !== vaultId) {
      set({
        activeVaultId: vaultId,
        files: {},
        linkedFiles: {},
        bodies: {},
        scannedAt: null,
        isRepo: false,
        conflicts: {},
        loadingPaths: {},
        renameTarget: null,
        lastRenameReport: null,
      });
    } else {
      set({ activeVaultId: vaultId });
    }

    // Local-first: paint from IDB before the daemon answers.
    const [meta, bodyRows] = await Promise.all([loadVaultMeta(vaultId), loadVaultBodies(vaultId)]);
    if (get().activeVaultId !== vaultId) return;
    if (meta && get().scannedAt === null) {
      const files: Record<string, VaultFileEntry> = {};
      for (const f of meta.files) files[f.path] = f;
      const bodies: Record<string, VaultBody> = {};
      for (const r of bodyRows) bodies[r.path] = { content: r.content, mtime: r.mtime, etag: r.etag };
      set((s) => ({
        files,
        bodies,
        scannedAt: meta.scannedAt,
        ...cachedRepo(vaultId, s.vaults, meta),
        connection: s.connection === "connected" ? s.connection : "cached",
      }));
    }

    const ep = get().endpoint;
    if (!ep) return;
    try {
      await syncActiveVault(ep, vaultId);
    } catch {
      if (get().activeVaultId === vaultId) {
        set((s) => ({ connection: s.scannedAt ? "cached" : "no-daemon" }));
      }
      return;
    }
    // A newer select may have finished while the scan ran — it owns the socket.
    if (get().activeVaultId !== vaultId) return;
    const gen = ++wsGen;
    const guarded = (fn: () => void) => () => {
      if (gen !== wsGen) return;
      if (useVaultStore.getState().activeVaultId !== vaultId) return;
      fn();
    };
    wsDispose = subscribeVaultEvents(ep, vaultId, {
      onEvent: (ev) => {
        if (gen === wsGen) applyWsEvent(ev);
      },
      // A drop only surfaces the offline banner; the subscription's own
      // backoff owns socket retries. Full rediscovery happens exactly once,
      // via onStale, when reconnects keep failing (daemon restart = new
      // port/token, so retrying the old endpoint can never succeed).
      onDown: guarded(() => {
        if (useVaultStore.getState().connection === "connected") set({ connection: "cached" });
      }),
      onUp: guarded(() => {
        // Data recovery rides the server's post-hello "reset" event; here we
        // only clear the banner.
        if (useVaultStore.getState().connection === "cached") set({ connection: "connected" });
      }),
      onStale: guarded(() => {
        // A host's subscription reopens the forward itself before each retry
        // (subscribeVaultEvents); rediscovering this machine's daemon would
        // not help it.
        if (host) return;
        wsDispose?.();
        wsDispose = null;
        if (convexRef) void useVaultStore.getState().connect(convexRef, { force: true });
      }),
    });
  },

  openRemoteVault: async (vaultId) => {
    const convex = convexRef;
    if (!convex) return;
    const vault = get().remoteVaults.find((v) => v.id === vaultId);
    if (!vault) return;
    // A remote vault replaces the local view wholesale: different machine,
    // different file set. The WS subscription is dropped because there is
    // nothing local to watch.
    wsDispose?.();
    wsDispose = null;
    set({
      activeVaultId: vaultId,
      isRemote: true,
      // A mirror only ever carries notes and their attachments (the daemon
      // narrows what it pushes), so there is no "everything else" to show and
      // the toggle would promise a file set that does not exist.
      showAllFiles: false,
      showIgnoredFiles: false,
      isRepo: false,
      files: {},
      linkedFiles: {},
      bodies: {},
      conflicts: {},
      loadingPaths: {},
      connection: "discovering",
    });
    try {
      const notes = await fetchRemoteNotes(convex, vaultId, vault.device_id);
      if (get().activeVaultId !== vaultId) return;
      set({
        files: remoteNotesToFileTable(notes),
        scannedAt: vault.last_synced_at,
        connection: "connected",
      });
    } catch {
      if (get().activeVaultId === vaultId) set({ connection: "no-daemon" });
    }
  },

  loadRemoteBody: async (path) => {
    const convex = convexRef;
    const { activeVaultId, isRemote, bodies } = get();
    if (!convex || !activeVaultId || !isRemote || bodies[path]) return null;
    const vault = get().remoteVaults.find((v) => v.id === activeVaultId);
    set((s) => ({ loadingPaths: { ...s.loadingPaths, [path]: true } }));
    const res = await fetchRemoteBody(convex, activeVaultId, path, vault?.device_id);
    if (get().activeVaultId !== activeVaultId) return null;
    set((s) => ({
      loadingPaths: omit(s.loadingPaths, path),
      bodies:
        res.content === null
          ? s.bodies
          : { ...s.bodies, [path]: { content: res.content, mtime: 0, etag: "" } },
      opError:
        res.content === null && res.reason === "not-uploaded"
          ? `${path} isn't mirrored — its body lives on the machine that owns this vault.`
          : s.opError,
    }));
    if (res.content !== null) return null;
    return res.reason === "not-uploaded" ? "Not mirrored" : "Mirror unreachable";
  },

  refresh: async () => {
    const { endpoint, activeVaultId } = get();
    if (endpoint && activeVaultId) await syncActiveVault(endpoint, activeVaultId);
  },

  writeFile: async (path, content, baseEtag) => {
    const { endpoint, activeVaultId, bodies } = get();
    if (!endpoint || !activeVaultId) throw new Error("vault not connected");
    const base = bodies[path];
    // The editor passes the etag of the version it actually has on screen —
    // compare-and-swap from the CALLER's viewpoint. Without it, an external
    // clean write (link rewrite, WS echo) would refresh bodies[path].etag and
    // the next autosave would silently clobber that write with older text
    // (review finding, R8). Absent an explicit base, fall back to the store's.
    const guard = baseEtag ?? base?.etag;
    // Optimistic: the UI reflects the write immediately; disk follows.
    set((s) => ({
      bodies: { ...s.bodies, [path]: { content, mtime: Date.now(), etag: base?.etag ?? "" } },
    }));
    try {
      const res = await writeVaultFile(endpoint, activeVaultId, path, content, guard || undefined);
      const body: VaultBody = { content, mtime: res.mtime, etag: res.etag, size: res.size };
      set((s) => ({
        bodies: { ...s.bodies, [path]: body },
        files: { ...s.files, [path]: { path, mtime: res.mtime, size: res.size } },
      }));
      stageBody(activeVaultId, path, body);
    } catch (e) {
      if (e instanceof VaultWriteConflict) {
        set((s) => ({ conflicts: { ...s.conflicts, [path]: e.current } }));
        return;
      }
      // Roll back to the last known-good body so the UI doesn't lie about disk.
      if (base) set((s) => ({ bodies: { ...s.bodies, [path]: base } }));
      throw e;
    }
  },

  createFile: async (path, content = "") => {
    const { endpoint, activeVaultId } = get();
    if (!endpoint || !activeVaultId) throw new Error("vault not connected");
    // Local-first: the note exists in the tree and view immediately; disk
    // follows. Roll back if the daemon refuses — restoring any pre-existing
    // row rather than dropping it (create-over-existing is rejected server
    // side, and the rollback must not evict the real file from the tree).
    const prevEntry = get().files[path];
    const prevBody = get().bodies[path];
    const optimistic: VaultFileEntry = { path, mtime: Date.now(), size: content.length };
    const body: VaultBody = { content, mtime: optimistic.mtime, etag: "" };
    set((s) => ({
      files: { ...s.files, [path]: optimistic },
      bodies: isVaultMarkdownPath(path) ? { ...s.bodies, [path]: body } : s.bodies,
      opError: null,
    }));
    try {
      const res = await vaultOp(endpoint, activeVaultId, { op: "create", path, content });
      const entry = res.file ?? optimistic;
      set((s) => ({ files: { ...s.files, [path]: entry } }));
      if (isVaultMarkdownPath(path)) {
        stageBody(activeVaultId, path, { ...body, mtime: entry.mtime });
      }
    } catch (e) {
      set((s) => ({
        files: prevEntry ? { ...s.files, [path]: prevEntry } : omit(s.files, path),
        bodies: prevBody ? { ...s.bodies, [path]: prevBody } : omit(s.bodies, path),
        opError: `Couldn't create ${path}: ${e instanceof Error ? e.message : String(e)}`,
      }));
      throw e;
    }
  },

  renamePath: async (path, to) => {
    const { endpoint, activeVaultId } = get();
    if (!endpoint || !activeVaultId) throw new Error("vault not connected");
    // A folder rename is one daemon op (fsp.rename moves the directory) but
    // many store keys: every descendant path changes with it.
    const moves = renameMoves(Object.keys(get().files), path, to);
    // The link rewrite is planned HERE, against the index as it stands before
    // anything moves: once the file is gone from its old path, so are the
    // backlinks that name it. Applying the plan waits for the move to succeed.
    // The index is force-synced first — its normal refresh is deferred to an
    // idle callback, and a rename in that window must not quietly find no
    // backlinks and rewrite nothing.
    syncVaultIndex(activeVaultId, get().bodies);
    const plan = planFolderRewrites(vaultIndex, moves.map(([from, dest]) => ({ from, to: dest })));
    // Snapshot exactly the keys the move touches — a rollback that restored
    // whole tables would also revert a WS event that landed mid-op. Rows
    // sitting on a destination are captured too, so a rejected
    // rename-over-existing doesn't evict the real file from the tree.
    const snapshot = snapshotPaths(get(), moves.flat());
    // The redirect hint is recorded with the OPTIMISTIC move, not after the
    // daemon answers: the store update unmounts an open editor immediately,
    // and its final flush needs to know where the file went (review finding,
    // R8 — recording later left a window where the flush had nowhere to go).
    recordMoves(moves.map(([from, dest]) => ({ from, to: dest })));

    // Optimistic move; the watcher's reconcile confirms with removed+add.
    applyMoves(moves);
    set({ opError: null, lastRenameReport: null });
    try {
      await vaultOp(endpoint, activeVaultId, { op: "rename", path, to });
      for (const [from, dest] of moves) {
        stageDelete(activeVaultId, from);
        const body = get().bodies[dest];
        if (body) stageBody(activeVaultId, dest, body);
      }
    } catch (e) {
      // The move never happened — drop the redirect hint so a later flush
      // doesn't send this file's text to a path that doesn't exist.
      forgetMoves(moves.map(([from, dest]) => ({ from, to: dest })));
      restorePaths(snapshot, moves);
      set({ opError: `Couldn't rename ${path}: ${e instanceof Error ? e.message : String(e)}` });
      throw e;
    }
    // The rewrite is its own act, and it does NOT block the rename: the tree,
    // the URL and the open note follow the move immediately while the writes
    // fan out behind them. The outcome arrives through lastRenameReport.
    void applyLinkRewrites(plan).then((report) => {
      if (report && get().activeVaultId === activeVaultId) {
        set({ lastRenameReport: { path: to, ...report } });
      }
    });
  },

  deletePath: async (path) => {
    const { endpoint, activeVaultId } = get();
    if (!endpoint || !activeVaultId) throw new Error("vault not connected");
    const prevEntry = get().files[path];
    const prevBody = get().bodies[path];
    recentDeletes.set(path, Date.now());
    set((s) => ({ files: omit(s.files, path), bodies: omit(s.bodies, path), opError: null }));
    try {
      await vaultOp(endpoint, activeVaultId, { op: "delete", path });
      stageDelete(activeVaultId, path);
    } catch (e) {
      recentDeletes.delete(path);
      set((s) => ({
        files: prevEntry ? { ...s.files, [path]: prevEntry } : s.files,
        bodies: prevBody ? { ...s.bodies, [path]: prevBody } : s.bodies,
        opError: `Couldn't delete ${path}: ${e instanceof Error ? e.message : String(e)}`,
      }));
      throw e;
    }
  },

  createFolder: async (path) => {
    const { endpoint, activeVaultId } = get();
    if (!endpoint || !activeVaultId) throw new Error("vault not connected");
    set((s) => ({ files: { ...s.files, [path]: { path, mtime: Date.now(), size: 0, dir: true } }, opError: null }));
    try {
      await vaultOp(endpoint, activeVaultId, { op: "mkdir", path });
    } catch (e) {
      set((s) => ({
        files: omit(s.files, path),
        opError: `Couldn't create folder ${path}: ${e instanceof Error ? e.message : String(e)}`,
      }));
      throw e;
    }
  },

  newNote: (dir) => createThenRename(dir, "Untitled", ".md", (path) => get().createFile(path, "")),

  dailySettings: DEFAULT_DAILY_SETTINGS,

  setDailySettings: (next) => set((s) => ({ dailySettings: { ...s.dailySettings, ...next } })),

  openDailyNote: async (date) => {
    const when = date ?? new Date();
    const settings = get().dailySettings;
    const path = dailyNotePath(when, settings);
    if (get().files[path]) return path;
    // A template is optional; without one the note starts with its own title
    // so it never opens completely blank.
    // A template whose body hasn't streamed in yet must not silently degrade
    // to "no template" — fetch it on demand (review finding, R12; unreachable
    // until a settings UI ships, fixed before it can be).
    let templateBody = settings.template ? get().bodies[settings.template]?.content : undefined;
    if (settings.template && templateBody === undefined) {
      const { endpoint, activeVaultId } = get();
      if (endpoint && activeVaultId && get().files[settings.template]) {
        try {
          const file = await readVaultFile(endpoint, activeVaultId, settings.template);
          templateBody = file?.content;
        } catch {
          templateBody = undefined;
        }
      }
    }
    const title = path.split("/").pop()!.replace(/\.md$/i, "");
    const body = templateBody
      ? expandTemplate(templateBody, { title, date: when })
      : `# ${title}\n\n`;
    try {
      await get().createFile(path, body);
      return path;
    } catch {
      return null;
    }
  },

  adjacentDaily: (date, direction) => {
    const existing = adjacentDailyNote(Object.keys(get().files), date, get().dailySettings, direction);
    if (existing) return existing;
    // Nothing exists on that side — offer the literal adjacent day's path so a
    // caller can create it (Obsidian's "next daily note" makes tomorrow).
    return dailyNotePath(shiftDays(date, direction), get().dailySettings);
  },

  newFolder: (dir) => createThenRename(dir, "New folder", "", (path) => get().createFolder(path)),

  resolveConflictWithDisk: (path) => {
    set((s) => {
      const disk = s.conflicts[path];
      if (!disk) return s;
      const { activeVaultId } = s;
      if (activeVaultId) stageBody(activeVaultId, path, disk);
      return { bodies: { ...s.bodies, [path]: disk }, conflicts: omit(s.conflicts, path) };
    });
  },

  resolveConflictKeepMine: async (path) => {
    const s = get();
    const mine = s.bodies[path]?.content;
    const disk = s.conflicts[path];
    if (mine === undefined || !disk) return;
    set((st) => ({ conflicts: omit(st.conflicts, path) }));
    // Retry the write against the disk version we just saw.
    const { endpoint, activeVaultId } = get();
    if (!endpoint || !activeVaultId) return;
    const res = await writeVaultFile(endpoint, activeVaultId, path, mine, disk.etag || undefined);
    const body: VaultBody = { content: mine, mtime: res.mtime, etag: res.etag };
    set((st) => ({ bodies: { ...st.bodies, [path]: body } }));
    stageBody(activeVaultId, path, body);
  },
}));

// Dev console access, mirroring window.__inboxStore.
if (typeof window !== "undefined" && import.meta.env?.DEV) {
  (window as any).__vaultStore = useVaultStore;
}

// A host's forward reopened on a new port, or was lost: the header's state
// follows, and the active vault's endpoint is the new one.
onHostEndpointChange((deviceId, ep) => {
  const s = useVaultStore.getState();
  useVaultStore.setState({
    hostStates: { ...s.hostStates, [deviceId]: ep ? "connected" : "unreachable" },
    ...(ep && hostOfVault(s.activeVaultId) === deviceId ? { endpoint: ep } : {}),
  });
});
