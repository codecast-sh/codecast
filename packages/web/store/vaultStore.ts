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
import { isVaultMarkdownPath } from "@codecast/shared/contracts";
import {
  getVaultEndpoint,
  listVaults,
  readVaultFile,
  scanVault,
  subscribeVaultEvents,
  writeVaultFile,
  vaultOp,
  VaultWriteConflict,
  type VaultEndpoint,
} from "../lib/vault/client";
import {
  bodyKey,
  deleteVaultBodies,
  loadVaultBodies,
  loadVaultMeta,
  saveVaultBodies,
  saveVaultMeta,
  type VaultBodyRow,
} from "../lib/vault/db";
import {
  ancestorDirs,
  joinVaultPath,
  nextUntitledName,
  renameMoves,
  siblingNames,
  type VaultSortMode,
} from "../lib/vault/explorerModel";

export type VaultConnection =
  | "idle"          // not yet asked
  | "discovering"   // looking for the daemon endpoint
  | "connected"     // WS up, scan complete
  | "cached"        // painting from IDB, daemon unreachable
  | "no-daemon";    // discovery failed and no cache exists

export interface VaultBody {
  content: string;
  mtime: number;
  etag: string;
}

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
  /** Last failed file operation, for a dismissible strip in the UI. */
  opError: string | null;
  clearOpError: () => void;
  /** Explorer expand/collapse state (per active vault, session-lived). */
  expandedDirs: Record<string, boolean>;
  /** Recently opened note paths, most recent first (feeds switcher ranking). */
  recentPaths: string[];
  /** Explorer row order — ephemeral, like the panel tabs below. */
  sortMode: VaultSortMode;
  setSortMode: (mode: VaultSortMode) => void;
  /** Path whose explorer row should be in inline-rename mode. Set by the store
   *  so a freshly created note lands in rename regardless of which surface
   *  (header button, row context menu) created it. */
  renameTarget: string | null;
  setRenameTarget: (path: string | null) => void;

  /** Quick switcher (Cmd+O) visibility — ephemeral UI state. */
  quickSwitchOpen: boolean;
  setQuickSwitchOpen: (open: boolean) => void;
  /** Right panel state — lifted so a #tag pill click can open the tag pane. */
  rightPanelTab: "backlinks" | "outline" | "tags";
  setRightPanelTab: (tab: "backlinks" | "outline" | "tags") => void;
  selectedTag: string | null;
  setSelectedTag: (tag: string | null) => void;
  openTagPane: (tag: string) => void;
  toggleDir: (path: string) => void;
  setDirsExpanded: (paths: string[], expanded: boolean) => void;
  noteOpened: (path: string) => void;
  connect: (convex: ConvexReactClient, opts?: { force?: boolean }) => Promise<void>;
  selectVault: (vaultId: string) => Promise<void>;
  refresh: () => Promise<void>;
  writeFile: (path: string, content: string) => Promise<void>;
  createFile: (path: string, content?: string) => Promise<void>;
  /** Moves an entry; a folder carries its whole subtree with it. */
  renamePath: (path: string, to: string) => Promise<void>;
  deletePath: (path: string) => Promise<void>;
  createFolder: (path: string) => Promise<void>;
  /** Create an "Untitled" note / "New folder" inside `dir` ("" = vault root),
   *  reveal it, and put it in inline rename. Resolves to the created path, or
   *  null when the daemon refused (opError carries the reason). */
  newNote: (dir: string) => Promise<string | null>;
  newFolder: (dir: string) => Promise<string | null>;
  resolveConflictWithDisk: (path: string) => void;
  resolveConflictKeepMine: (path: string) => Promise<void>;
}

const BODY_FETCH_CONCURRENCY = 12;
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

/** Fetch a set of markdown bodies with bounded concurrency, patching the store
 *  as each lands so the UI streams in rather than waiting for the batch. */
async function fetchBodies(ep: VaultEndpoint, vaultId: string, paths: string[]): Promise<void> {
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
          stageBody(vaultId, path, body);
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
  if (isVaultMarkdownPath(ev.path) && s.endpoint) {
    // Skip refetch when the change is our own write echo (same mtime already stored).
    const known = s.bodies[ev.path];
    if (!known || known.mtime !== ev.mtime) {
      void fetchBodies(s.endpoint, vaultId, [ev.path]);
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
  vaults: [],
  activeVaultId: null,
  files: {},
  bodies: {},
  scannedAt: null,
  loadingPaths: {},
  conflicts: {},
  expandedDirs: {},
  recentPaths: [],
  sortMode: "name-asc" as const,
  renameTarget: null,
  quickSwitchOpen: false,
  rightPanelTab: "backlinks" as const,
  selectedTag: null,
  opError: null,

  clearOpError: () => set({ opError: null }),

  setQuickSwitchOpen: (open) => set({ quickSwitchOpen: open }),

  setSortMode: (mode) => set({ sortMode: mode }),
  setRenameTarget: (path) => set({ renameTarget: path }),

  setRightPanelTab: (tab) => set({ rightPanelTab: tab }),
  setSelectedTag: (tag) => set({ selectedTag: tag }),
  openTagPane: (tag) => set({ rightPanelTab: "tags", selectedTag: tag }),

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
      set({ endpoint: null });
      if (remembered && !get().scannedAt) {
        await get().selectVault(remembered);
      }
      set((s) => ({ connection: s.scannedAt ? "cached" : "no-daemon" }));
      return;
    }
    let vaults: VaultInfo[] = [];
    try {
      vaults = await listVaults(ep);
    } catch {
      // Daemon answered the probe but predates the vault routes.
      set((s) => ({ connection: s.scannedAt ? "cached" : "no-daemon", endpoint: ep }));
      return;
    }
    set({ endpoint: ep, vaults });

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
    if (prev !== vaultId) {
      set({
        activeVaultId: vaultId,
        files: {},
        bodies: {},
        scannedAt: null,
        conflicts: {},
        loadingPaths: {},
        renameTarget: null,
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

  refresh: async () => {
    const { endpoint, activeVaultId } = get();
    if (endpoint && activeVaultId) await syncActiveVault(endpoint, activeVaultId);
  },

  writeFile: async (path, content) => {
    const { endpoint, activeVaultId, bodies } = get();
    if (!endpoint || !activeVaultId) throw new Error("vault not connected");
    const base = bodies[path];
    // Optimistic: the UI reflects the write immediately; disk follows.
    set((s) => ({
      bodies: { ...s.bodies, [path]: { content, mtime: Date.now(), etag: base?.etag ?? "" } },
    }));
    try {
      const res = await writeVaultFile(endpoint, activeVaultId, path, content, base?.etag || undefined);
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
    // Snapshot exactly the keys the move touches — a rollback that restored
    // whole tables would also revert a WS event that landed mid-op. Rows
    // sitting on a destination are captured too, so a rejected
    // rename-over-existing doesn't evict the real file from the tree.
    const snapshot = snapshotPaths(get(), moves.flat());
    // Optimistic move; the watcher's reconcile confirms with removed+add.
    applyMoves(moves);
    set({ opError: null });
    try {
      await vaultOp(endpoint, activeVaultId, { op: "rename", path, to });
      for (const [from, dest] of moves) {
        stageDelete(activeVaultId, from);
        const body = get().bodies[dest];
        if (body) stageBody(activeVaultId, dest, body);
      }
    } catch (e) {
      restorePaths(snapshot, moves);
      set({ opError: `Couldn't rename ${path}: ${e instanceof Error ? e.message : String(e)}` });
      throw e;
    }
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
