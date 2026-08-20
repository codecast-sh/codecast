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
import { lastDiscoveryFailure, type DiscoveryFailure } from "../lib/terminal/endpoint";
import {
  fetchRemoteBody,
  fetchRemoteNotes,
  listRemoteVaults,
  remoteNotesToFileTable,
  type RemoteVault,
} from "../lib/vault/remoteMirror";
import {
  DEFAULT_DAILY_SETTINGS,
  adjacentDailyNote,
  dailyNotePath,
  expandTemplate,
  shiftDays,
  type DailyNoteSettings,
} from "../lib/vault/dailyNotes";
import {
  getVaultEndpoint,
  listVaults,
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
  type BookmarkInput,
  type BookmarkItem,
} from "../lib/vault/bookmarks";
import {
  ancestorDirs,
  joinVaultPath,
  nextUntitledName,
  renameMoves,
  siblingNames,
  type VaultSortMode,
} from "../lib/vault/explorerModel";
import { applySpanEdits, planFolderRewrites, type FileRewrite } from "../lib/vault/linkRewrite";
import { syncVaultIndex, vaultIndex } from "../lib/vault/indexSingleton";

export type VaultConnection =
  | "idle"          // not yet asked
  | "discovering"   // looking for the daemon endpoint
  | "connected"     // WS up, scan complete
  | "cached"        // painting from IDB, daemon unreachable
  | "no-daemon";    // discovery failed and no cache exists

export type VaultRightPanelTab = "backlinks" | "outgoing" | "outline" | "tags" | "bookmarks";

export interface VaultBody {
  content: string;
  mtime: number;
  etag: string;
}

/** What a rename did to the links pointing at the renamed file. */
export interface RenameReport {
  /** The rename that produced this, for the strip's wording. */
  path: string;
  filesChanged: number;
  linksRewritten: number;
  /** Links deliberately left alone: the file had changed under the plan, or
   *  its write didn't land. Surfaced rather than swallowed — a silent partial
   *  rewrite is the one outcome nobody can recover from. */
  skipped: number;
}

/** Every way the vault page can fail to reach a machine's files: the shared
 *  endpoint-discovery outcomes plus the ones only the vault routes produce.
 *  Named so the teaching panel can bind to it instead of restating the members
 *  — a new discovery outcome must not be able to drift out of the UI. */
export type VaultUnreachableReason = DiscoveryFailure | "old-daemon" | "refused" | "error";

interface VaultState {
  connection: VaultConnection;
  endpoint: VaultEndpoint | null;
  vaults: VaultInfo[];
  activeVaultId: string | null;
  /** Vault-relative path → entry, for the active vault. */
  files: Record<string, VaultFileEntry>;
  /** Markdown bodies for the active vault (all .md files are held — vaults are
   *  small text; assets are never fetched into memory). */
  bodies: Record<string, VaultBody>;
  scannedAt: number | null;
  /** Paths currently being (re)fetched, for subtle loading affordances. */
  loadingPaths: Record<string, true>;
  /** A write hit a 409: someone changed the file on disk under us. */
  conflicts: Record<string, VaultBody>;
  /** Vaults mirrored from OTHER machines — read-only projections. Present
   *  alongside local vaults; the surface hides every write affordance for one. */
  remoteVaults: RemoteVault[];
  /** Set while the active vault is a remote mirror rather than local disk. */
  isRemote: boolean;
  /** Why the local daemon couldn't be reached — drives cause-specific guidance
   *  instead of one message that blames the daemon for a browser permission. */
  unreachableReason: VaultUnreachableReason;
  /** The underlying failure text, shown verbatim in the teaching state so a
   *  cause we did not anticipate is still diagnosable from the screen. */
  unreachableDetail: string | null;
  openRemoteVault: (vaultId: string) => Promise<void>;
  loadRemoteBody: (path: string) => Promise<void>;
  /** Last failed file operation, for a dismissible strip in the UI. */
  opError: string | null;
  clearOpError: () => void;
  /** What the last rename did to the vault's links, for a dismissible strip.
   *  Transient: never persisted, cleared when the next rename starts. */
  lastRenameReport: RenameReport | null;
  clearRenameReport: () => void;
  /** Explorer expand/collapse state (per active vault, session-lived). */
  expandedDirs: Record<string, boolean>;
  /** Recently opened note paths, most recent first (feeds switcher ranking). */
  recentPaths: string[];
  /** Explorer row order — ephemeral, like the panel tabs below. */
  sortMode: VaultSortMode;
  setSortMode: (mode: VaultSortMode) => void;
  /** Show every file on disk, not just notes and their attachments. Persisted
   *  per vault; the default follows the vault's kind (see readShowAllFiles). */
  showAllFiles: boolean;
  setShowAllFiles: (value: boolean) => void;
  /** Pull a non-markdown file's text on demand. Markdown bodies all arrive with
   *  the scan; code is fetched only when someone opens it. */
  loadTextBody: (path: string) => Promise<void>;
  /** Path whose explorer row should be in inline-rename mode. Set by the store
   *  so a freshly created note lands in rename regardless of which surface
   *  (header button, row context menu) created it. */
  renameTarget: string | null;
  setRenameTarget: (path: string | null) => void;

  /** Quick switcher (Cmd+O) visibility — ephemeral UI state. */
  quickSwitchOpen: boolean;
  setQuickSwitchOpen: (open: boolean) => void;
  /** Text the switcher opens with (consumed on open). A deep link that named
   *  a file this vault doesn't have seeds the search with its name, so the
   *  near-misses are one keystroke away instead of a dead end. */
  quickSwitchSeed: string | null;
  openQuickSwitch: (seed?: string) => void;
  /** Left pane tab and the search pane's query, lifted here so a saved-search
   *  bookmark can switch to Search and type its query in for you. */
  leftPaneTab: "files" | "search";
  setLeftPaneTab: (tab: "files" | "search") => void;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  openSearch: (query: string) => void;

  /** Bookmarks for the active vault, oldest first. Persisted to the vault's
   *  own IndexedDB — a bookmark names a path on THIS machine. */
  bookmarks: BookmarkItem[];
  /** The vault the loaded list belongs to (null while a load is in flight). */
  bookmarksVaultId: string | null;
  loadBookmarks: () => Promise<void>;
  addBookmark: (item: BookmarkInput) => void;
  /** Pin or unpin a target — what every bookmark button in the UI calls. */
  toggleBookmark: (item: BookmarkInput) => void;
  removeBookmark: (id: string) => void;
  setBookmarkTitle: (id: string, title: string) => void;
  /** Follow the vault when paths move or vanish; `resolve` returns the new
   *  path, null to drop the bookmark, or undefined to leave it alone. Driven
   *  by lib/vault/bookmarksHost, which watches the file table. */
  retargetBookmarks: (resolve: (path: string) => string | null | undefined) => void;
  /** Right panel state — lifted so a #tag pill click can open the tag pane. */
  rightPanelTab: VaultRightPanelTab;
  setRightPanelTab: (tab: VaultRightPanelTab) => void;
  /** Whether the backlinks/outline side panel is showing. Closed by default —
   *  most visits are reading, and the panel is a lookup you open on purpose.
   *  Remembered across reloads. */
  rightPanelOpen: boolean;
  setRightPanelOpen: (open: boolean) => void;
  selectedTag: string | null;
  setSelectedTag: (tag: string | null) => void;
  openTagPane: (tag: string) => void;
  /** One-shot explorer reveal request (breadcrumb click): expand + scroll. */
  revealTarget: string | null;
  requestReveal: (path: string) => void;
  clearReveal: () => void;
  toggleDir: (path: string) => void;
  setDirsExpanded: (paths: string[], expanded: boolean) => void;
  noteOpened: (path: string) => void;
  connect: (convex: ConvexReactClient, opts?: { force?: boolean }) => Promise<void>;
  selectVault: (vaultId: string) => Promise<void>;
  refresh: () => Promise<void>;
  writeFile: (path: string, content: string, baseEtag?: string) => Promise<void>;
  createFile: (path: string, content?: string) => Promise<void>;
  /** Moves an entry; a folder carries its whole subtree with it. */
  renamePath: (path: string, to: string) => Promise<void>;
  deletePath: (path: string) => Promise<void>;
  createFolder: (path: string) => Promise<void>;
  /** Create an "Untitled" note / "New folder" inside `dir` ("" = vault root),
   *  reveal it, and put it in inline rename. Resolves to the created path, or
   *  null when the daemon refused (opError carries the reason). */
  newNote: (dir: string) => Promise<string | null>;
  /** Daily notes: settings live per vault in the prefs table; the defaults are
   *  Obsidian's (a "Daily" folder, ISO date names). */
  dailySettings: DailyNoteSettings;
  setDailySettings: (next: Partial<DailyNoteSettings>) => void;
  /** Open (creating if needed) the note for a date — today by default. */
  openDailyNote: (date?: Date) => Promise<string | null>;
  /** Nearest EXISTING daily note before/after the given date, or null. */
  adjacentDaily: (date: Date, direction: -1 | 1) => string | null;
  newFolder: (dir: string) => Promise<string | null>;
  resolveConflictWithDisk: (path: string) => void;
  resolveConflictKeepMine: (path: string) => Promise<void>;
}

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
        void saveVaultMeta({ id: active, info, files: Object.values(s.files), scannedAt: s.scannedAt });
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
 * the folder IS: a code project whose tree hides its own source is the wrong
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

function readShowAllFiles(vaultId: string, vaults: VaultInfo[]): boolean {
  try {
    const stored = localStorage.getItem(`${SHOW_ALL_KEY}:${vaultId}`);
    if (stored === "1") return true;
    if (stored === "0") return false;
  } catch {}
  return vaults.find((v) => v.id === vaultId)?.kind === "project";
}

function writeShowAllFiles(vaultId: string, value: boolean): void {
  try {
    localStorage.setItem(`${SHOW_ALL_KEY}:${vaultId}`, value ? "1" : "0");
  } catch {}
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
): Promise<void> {
  const queue = [...paths];
  const workers = Array.from({ length: Math.min(BODY_FETCH_CONCURRENCY, queue.length) }, async () => {
    while (queue.length) {
      const path = queue.shift();
      if (!path) return;
      try {
        const file = await readVaultFile(ep, vaultId, path);
        const s = useVaultStore.getState();
        if (s.activeVaultId !== vaultId) return;
        if (file) {
          const body: VaultBody = { content: file.content, mtime: file.mtime, etag: file.etag };
          useVaultStore.setState((st) => ({
            bodies: { ...st.bodies, [path]: body },
            loadingPaths: omit(st.loadingPaths, path),
          }));
          if (persist) stageBody(vaultId, path, body);
        } else {
          useVaultStore.setState((st) => ({ loadingPaths: omit(st.loadingPaths, path) }));
        }
      } catch {
        useVaultStore.setState((st) => ({ loadingPaths: omit(st.loadingPaths, path) }));
      }
    }
  });
  await Promise.all(workers);
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

function applyWsEvent(ev: VaultWsEvent) {
  const s = useVaultStore.getState();
  const vaultId = s.activeVaultId;
  if (!vaultId || ev.vault !== vaultId) return;
  if (ev.type === "reset") {
    // The server sends reset right after every successful hello; when the
    // connect path just scanned, this would be a duplicate whole-vault walk.
    if (Date.now() - lastScanStartedAt > SCAN_DEDUPE_MS) void s.refresh();
    return;
  }
  if (ev.type === "removed") {
    useVaultStore.setState((st) => ({
      files: omit(st.files, ev.path),
      bodies: omit(st.bodies, ev.path),
    }));
    stageDelete(vaultId, ev.path);
    return;
  }
  // add | change
  useVaultStore.setState((st) => ({
    files: {
      ...st.files,
      [ev.path]: { path: ev.path, mtime: ev.mtime, size: ev.size },
    },
  }));
  // Markdown is always held, so it always refetches. A code file refetches only
  // when we already have its body — i.e. someone has it open — which keeps a
  // repo's build output from pulling megabytes through here.
  const isMarkdown = isVaultMarkdownPath(ev.path);
  const known = s.bodies[ev.path];
  if (s.endpoint && (isMarkdown || known)) {
    // Skip refetch when the change is our own write echo (same mtime already stored).
    if (!known || known.mtime !== ev.mtime) {
      void fetchBodies(s.endpoint, vaultId, [ev.path], { persist: isMarkdown });
    }
  }
}

async function syncActiveVault(ep: VaultEndpoint, vaultId: string): Promise<void> {
  lastScanStartedAt = Date.now();
  const scan = await scanVault(ep, vaultId);
  const s = useVaultStore.getState();
  if (s.activeVaultId !== vaultId) return;

  const files: Record<string, VaultFileEntry> = {};
  for (const f of scan.files) files[f.path] = f;

  // Diff against what we have (from IDB or a previous scan): fetch new/changed
  // markdown, drop entries that no longer exist.
  const prevBodies = s.bodies;
  const toFetch: string[] = [];
  for (const f of scan.files) {
    if (f.dir || !isVaultMarkdownPath(f.path)) continue;
    const known = prevBodies[f.path];
    if (!known || known.mtime !== f.mtime) toFetch.push(f.path);
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
    connection: "connected",
    loadingPaths: loading,
  });
  for (const p of removed) stageDelete(vaultId, p);
  schedulePersist();

  await fetchBodies(ep, vaultId, toFetch);
}

export const useVaultStore = create<VaultState>((set, get) => ({
  connection: "idle",
  endpoint: null,
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
  renameTarget: null,
  quickSwitchOpen: false,
  leftPaneTab: "files" as const,
  searchQuery: "",
  rightPanelTab: "backlinks" as const,
  rightPanelOpen: readRightPanelOpen(),
  selectedTag: null,
  bookmarks: [],
  bookmarksVaultId: null,
  opError: null,
  lastRenameReport: null,

  clearOpError: () => set({ opError: null }),
  clearRenameReport: () => set({ lastRenameReport: null }),

  setQuickSwitchOpen: (open) => set({ quickSwitchOpen: open, ...(open ? {} : { quickSwitchSeed: null }) }),
  quickSwitchSeed: null,
  openQuickSwitch: (seed) => set({ quickSwitchOpen: true, quickSwitchSeed: seed ?? null }),

  setLeftPaneTab: (tab) => set({ leftPaneTab: tab }),
  setSearchQuery: (query) => set({ searchQuery: query }),
  openSearch: (query) => set({ leftPaneTab: "search", searchQuery: query }),

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
    if (vaultId) writeShowAllFiles(vaultId, value);
    set({ showAllFiles: value });
  },

  loadTextBody: async (path) => {
    const { endpoint, activeVaultId, bodies, files, loadingPaths } = get();
    if (!endpoint || !activeVaultId) return;
    if (bodies[path] || loadingPaths[path]) return;
    // Decline BEFORE the round trip: the scan already told us how big it is, so
    // a 40MB bundle never crosses the wire, let alone reaches the highlighter.
    if ((files[path]?.size ?? 0) > VAULT_MAX_PREVIEW_BYTES) return;
    set((s) => ({ loadingPaths: { ...s.loadingPaths, [path]: true } }));
    await fetchBodies(endpoint, activeVaultId, [path], { persist: false });
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
    get().setRightPanelOpen(true);
    set({ rightPanelTab: "tags", selectedTag: tag });
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

  connect: async (convex, opts) => {
    convexRef = convex;
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
      set({ endpoint: null, unreachableReason: lastDiscoveryFailure(), unreachableDetail: null });
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
      set((s) => ({
        connection: s.scannedAt ? "cached" : "no-daemon",
        endpoint: ep,
        unreachableReason: status === 404 ? "old-daemon" : status ? "refused" : "error",
        unreachableDetail: e instanceof Error ? e.message : String(e),
      }));
      return;
    }
    set({ endpoint: ep, vaults, unreachableReason: "none", unreachableDetail: null });
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
    writeLastVaultId(vaultId);
    // Dispose the old subscription up front — never after the awaits below,
    // where a concurrent select could already have subscribed the new vault.
    wsDispose?.();
    wsDispose = null;
    // Unconditional, NOT folded into the reset branch below: the local-first
    // boot sets activeVaultId straight from the IDB cache, so by the time
    // selectVault runs for the remembered vault `prev` already equals it — and
    // a project vault would have opened with the toggle off.
    set({ showAllFiles: readShowAllFiles(vaultId, get().vaults) });
    if (prev !== vaultId) {
      set({
        activeVaultId: vaultId,
        files: {},
        bodies: {},
        scannedAt: null,
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
      files: {},
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
    if (!convex || !activeVaultId || !isRemote || bodies[path]) return;
    const vault = get().remoteVaults.find((v) => v.id === activeVaultId);
    set((s) => ({ loadingPaths: { ...s.loadingPaths, [path]: true } }));
    const res = await fetchRemoteBody(convex, activeVaultId, path, vault?.device_id);
    if (get().activeVaultId !== activeVaultId) return;
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
      const body: VaultBody = { content, mtime: res.mtime, etag: res.etag };
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
    set((s) => ({ files: omit(s.files, path), bodies: omit(s.bodies, path), opError: null }));
    try {
      await vaultOp(endpoint, activeVaultId, { op: "delete", path });
      stageDelete(activeVaultId, path);
    } catch (e) {
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
