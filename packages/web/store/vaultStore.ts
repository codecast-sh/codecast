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
  purgeVault,
  saveVaultBodies,
  saveVaultMeta,
  type VaultBodyRow,
} from "../lib/vault/db";

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
  /** Explorer expand/collapse state (per active vault, session-lived). */
  expandedDirs: Record<string, boolean>;
  /** Recently opened note paths, most recent first (feeds switcher ranking). */
  recentPaths: string[];

  toggleDir: (path: string) => void;
  setDirsExpanded: (paths: string[], expanded: boolean) => void;
  noteOpened: (path: string) => void;
  connect: (convex: ConvexReactClient, opts?: { force?: boolean }) => Promise<void>;
  selectVault: (vaultId: string) => Promise<void>;
  refresh: () => Promise<void>;
  writeFile: (path: string, content: string) => Promise<void>;
  createFile: (path: string, content?: string) => Promise<void>;
  renamePath: (path: string, to: string) => Promise<void>;
  deletePath: (path: string) => Promise<void>;
  createFolder: (path: string) => Promise<void>;
  resolveConflictWithDisk: (path: string) => void;
  resolveConflictKeepMine: (path: string) => Promise<void>;
}

const BODY_FETCH_CONCURRENCY = 12;
const PERSIST_DEBOUNCE_MS = 800;

let wsDispose: (() => void) | null = null;
let convexRef: ConvexReactClient | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let pendingBodyRows: Map<string, VaultBodyRow> = new Map();
let pendingBodyDeletes: Set<string> = new Set();

function schedulePersist(vaultId: string) {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const s = useVaultStore.getState();
    if (s.activeVaultId !== vaultId) return;
    const info = s.vaults.find((v) => v.id === vaultId);
    if (info && s.scannedAt) {
      void saveVaultMeta({ id: vaultId, info, files: Object.values(s.files), scannedAt: s.scannedAt });
    }
    const rows = [...pendingBodyRows.values()];
    pendingBodyRows = new Map();
    void saveVaultBodies(rows);
    const dels = [...pendingBodyDeletes];
    pendingBodyDeletes = new Set();
    void deleteVaultBodies(vaultId, dels);
  }, PERSIST_DEBOUNCE_MS);
}

function stageBody(vaultId: string, path: string, body: VaultBody) {
  pendingBodyRows.set(path, {
    key: bodyKey(vaultId, path),
    vaultId,
    path,
    content: body.content,
    mtime: body.mtime,
    etag: body.etag,
  });
  pendingBodyDeletes.delete(path);
  schedulePersist(vaultId);
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

function applyWsEvent(ev: VaultWsEvent) {
  const s = useVaultStore.getState();
  const vaultId = s.activeVaultId;
  if (!vaultId || ev.vault !== vaultId) return;
  if (ev.type === "reset") {
    void s.refresh();
    return;
  }
  if (ev.type === "removed") {
    useVaultStore.setState((st) => ({
      files: omit(st.files, ev.path),
      bodies: omit(st.bodies, ev.path),
    }));
    pendingBodyRows.delete(ev.path);
    pendingBodyDeletes.add(ev.path);
    schedulePersist(vaultId);
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
  for (const p of removed) {
    pendingBodyRows.delete(p);
    pendingBodyDeletes.add(p);
  }
  schedulePersist(vaultId);

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

    const ep = await getVaultEndpoint(convex, opts);
    if (!ep) {
      set((s) => ({ connection: s.scannedAt ? "cached" : "no-daemon", endpoint: null }));
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

    const active = get().activeVaultId ?? vaults[0]?.id ?? null;
    if (active) await get().selectVault(active);
    else set({ connection: "connected" });
  },

  selectVault: async (vaultId) => {
    const prev = get().activeVaultId;
    if (prev !== vaultId) {
      wsDispose?.();
      wsDispose = null;
      set({ activeVaultId: vaultId, files: {}, bodies: {}, scannedAt: null, conflicts: {}, loadingPaths: {} });
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
      set((s) => ({ connection: s.scannedAt ? "cached" : "no-daemon" }));
      return;
    }
    wsDispose?.();
    wsDispose = subscribeVaultEvents(ep, vaultId, {
      onEvent: applyWsEvent,
      onDown: () => {
        const s = useVaultStore.getState();
        if (s.activeVaultId === vaultId && s.connection === "connected") {
          set({ connection: "cached" });
          // The daemon may have restarted with a fresh token; rediscover.
          if (convexRef) void useVaultStore.getState().connect(convexRef, { force: true });
        }
      },
      onUp: () => {
        const s = useVaultStore.getState();
        if (s.activeVaultId === vaultId && s.endpoint) void syncActiveVault(s.endpoint, vaultId);
      },
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
    const res = await vaultOp(endpoint, activeVaultId, { op: "create", path, content });
    const entry = res.file ?? { path, mtime: Date.now(), size: content.length };
    const body: VaultBody = { content, mtime: entry.mtime, etag: "" };
    set((s) => ({
      files: { ...s.files, [path]: entry },
      bodies: isVaultMarkdownPath(path) ? { ...s.bodies, [path]: body } : s.bodies,
    }));
    if (isVaultMarkdownPath(path)) stageBody(activeVaultId, path, body);
  },

  renamePath: async (path, to) => {
    const { endpoint, activeVaultId } = get();
    if (!endpoint || !activeVaultId) throw new Error("vault not connected");
    await vaultOp(endpoint, activeVaultId, { op: "rename", path, to });
    // The watcher's reconcile emits removed+add; apply optimistically now.
    set((s) => {
      const files = { ...s.files };
      const bodies = { ...s.bodies };
      const entry = files[path];
      delete files[path];
      if (entry) files[to] = { ...entry, path: to };
      const body = bodies[path];
      delete bodies[path];
      if (body) bodies[to] = body;
      return { files, bodies };
    });
    pendingBodyDeletes.add(path);
    const moved = get().bodies[to];
    if (moved) stageBody(activeVaultId, to, moved);
  },

  deletePath: async (path) => {
    const { endpoint, activeVaultId } = get();
    if (!endpoint || !activeVaultId) throw new Error("vault not connected");
    await vaultOp(endpoint, activeVaultId, { op: "delete", path });
    set((s) => ({ files: omit(s.files, path), bodies: omit(s.bodies, path) }));
    pendingBodyRows.delete(path);
    pendingBodyDeletes.add(path);
    schedulePersist(activeVaultId);
  },

  createFolder: async (path) => {
    const { endpoint, activeVaultId } = get();
    if (!endpoint || !activeVaultId) throw new Error("vault not connected");
    await vaultOp(endpoint, activeVaultId, { op: "mkdir", path });
    set((s) => ({ files: { ...s.files, [path]: { path, mtime: Date.now(), size: 0, dir: true } } }));
  },

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
