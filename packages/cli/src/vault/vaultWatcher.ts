// Live change events for a vault, streamed to whichever browser tabs are
// looking at it.
//
// RecursiveWatcher gives us add and change and NOTHING ELSE — no delete, no
// rename (see recursiveWatcher.ts). A watcher alone would therefore leave a
// deleted note on screen forever. So every watched vault also gets a reconcile
// scan (periodically, and whenever a client connects) that diffs a fresh listing
// against the in-memory file table and synthesizes the "removed" events the
// watcher can't produce. The table is the truth about what the client has been
// told, which is also why the add/change split is decided here rather than taken
// from the watcher's own priming state.

import * as fs from "fs";
import { RecursiveWatcher } from "../recursiveWatcher.js";
import type { VaultInfo, VaultWsEvent } from "@codecast/shared/contracts";
import {
  isVaultPathIgnored,
  normalizeVaultPath,
  scanVault,
  vaultRelativePath,
} from "./vaultScope.js";

const DEBOUNCE_MS = 100;
const RECONCILE_MS = 60_000;
/** How long a vault keeps its watcher after the last client goes away. Cheap to
 *  keep warm, expensive to re-prime, and users flip between tabs constantly. */
const IDLE_MS = 10 * 60_000;
const SWEEP_MS = 60_000;

type Listener = (event: VaultWsEvent) => void;

interface FileState {
  mtime: number;
  size: number;
}

interface WatchEntry {
  vault: VaultInfo;
  watcher: RecursiveWatcher;
  files: Map<string, FileState>;
  dirs: Set<string>;
  listeners: Set<Listener>;
  lastActive: number;
  reconcileTimer: ReturnType<typeof setInterval>;
  reconciling: boolean;
  /** Resolves once the priming scan has filled the file table. Reconciles wait
   *  on it: a reconcile against an empty table would announce every file in the
   *  vault as an add to a client that just scanned it. */
  ready: Promise<void>;
  /** False until the first reconcile has run: the folder set it establishes is
   *  the baseline, not a change worth telling clients to re-scan over. */
  primed: boolean;
}

export interface VaultWatchHubOptions {
  log?: (msg: string) => void;
  reconcileMs?: number;
  idleMs?: number;
}

export class VaultWatchHub {
  private entries = new Map<string, WatchEntry>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private readonly reconcileMs: number;
  private readonly idleMs: number;

  constructor(private opts: VaultWatchHubOptions = {}) {
    this.reconcileMs = opts.reconcileMs ?? RECONCILE_MS;
    this.idleMs = opts.idleMs ?? IDLE_MS;
  }

  /** Start watching a vault (or keep an already-watched one warm) without
   *  subscribing — what a scan does, so the first edit after a scan is live. */
  touch(vault: VaultInfo): void {
    this.entryFor(vault).lastActive = Date.now();
  }

  /** Subscribe to a vault's events. Connecting also forces a reconcile, so a
   *  client that was away while files were deleted learns about it at once
   *  rather than up to a reconcile interval later. */
  subscribe(vault: VaultInfo, listener: Listener): () => void {
    const entry = this.entryFor(vault);
    entry.listeners.add(listener);
    entry.lastActive = Date.now();
    void this.reconcile(entry);
    return () => {
      entry.listeners.delete(listener);
      entry.lastActive = Date.now();
    };
  }

  stop(): void {
    for (const entry of this.entries.values()) {
      clearInterval(entry.reconcileTimer);
      entry.watcher.stop();
    }
    this.entries.clear();
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  private entryFor(vault: VaultInfo): WatchEntry {
    const existing = this.entries.get(vault.id);
    if (existing) return existing;

    const watcher = new RecursiveWatcher({
      path: vault.root,
      scanPolicy: { dirs: "vault", files: "vault" },
      // RecursiveWatcher hands both filters a platform-separator relative path.
      // The ignore rules ARE the scope — the same question the scan asks, so
      // the watcher can never announce an add for a file the scan never lists
      // (which the next reconcile would then announce removed, forever).
      filter: (rel) => {
        const norm = normalizeVaultPath(rel);
        return norm !== null && !isVaultPathIgnored(vault.root, norm);
      },
      dirFilter: (rel) => {
        const norm = normalizeVaultPath(rel);
        return norm !== null && !isVaultPathIgnored(vault.root, norm);
      },
      callback: (absPath) => this.onFsEvent(vault.id, absPath),
      debounceMs: DEBOUNCE_MS,
    });

    // Prime the table before anything can emit, so pre-existing files are not
    // announced as adds to a client that already has them from its scan.
    const ready = scanVault(vault.root)
      .then((files) => {
        for (const f of files) {
          if (f.dir) entry.dirs.add(f.path);
          else if (!entry.files.has(f.path)) entry.files.set(f.path, { mtime: f.mtime, size: f.size });
        }
      })
      .catch(() => {})
      .finally(() => {
        try {
          watcher.start();
        } catch (err) {
          this.opts.log?.(`[VAULT] watch failed for ${vault.root}: ${(err as Error)?.message ?? err}`);
        }
      });

    const entry: WatchEntry = {
      vault,
      watcher,
      files: new Map(),
      dirs: new Set(),
      listeners: new Set(),
      lastActive: Date.now(),
      reconciling: false,
      primed: false,
      ready,
      reconcileTimer: setInterval(() => void this.reconcile(entry), this.reconcileMs),
    };
    entry.reconcileTimer.unref?.();
    this.entries.set(vault.id, entry);

    this.startSweep();
    return entry;
  }

  private onFsEvent(vaultId: string, absPath: string): void {
    const entry = this.entries.get(vaultId);
    if (!entry) return;
    const rel = vaultRelativePath(entry.vault.root, absPath);
    if (rel === null) return;
    if (isVaultPathIgnored(entry.vault.root, rel)) return;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(absPath);
    } catch {
      return;
    }
    const state: FileState = { mtime: Math.round(stat.mtimeMs), size: stat.size };
    const known = entry.files.get(rel);
    if (known && known.mtime === state.mtime && known.size === state.size) return;
    entry.files.set(rel, state);
    this.emit(entry, {
      type: known ? "change" : "add",
      vault: entry.vault.id,
      path: rel,
      mtime: state.mtime,
      size: state.size,
    });
  }

  /** Diff a fresh listing against the file table: this is the only source of
   *  "removed" events, and it also catches adds/changes the watcher dropped. */
  private async reconcile(entry: WatchEntry): Promise<void> {
    if (entry.reconciling) return;
    entry.reconciling = true;
    try {
      await entry.ready;
      const scanned = await scanVault(entry.vault.root);
      const seenFiles = new Set<string>();
      const seenDirs = new Set<string>();
      for (const f of scanned) {
        if (f.dir) {
          seenDirs.add(f.path);
          continue;
        }
        seenFiles.add(f.path);
        const known = entry.files.get(f.path);
        if (known && known.mtime === f.mtime && known.size === f.size) continue;
        entry.files.set(f.path, { mtime: f.mtime, size: f.size });
        this.emit(entry, {
          type: known ? "change" : "add",
          vault: entry.vault.id,
          path: f.path,
          mtime: f.mtime,
          size: f.size,
        });
      }
      for (const known of [...entry.files.keys()]) {
        if (seenFiles.has(known)) continue;
        entry.files.delete(known);
        this.emit(entry, { type: "removed", vault: entry.vault.id, path: known });
      }
      // Directories carry no per-entry event in the protocol (a client can't tell
      // a folder from a file on an "add"), so a changed folder set asks the client
      // to re-scan instead.
      const dirsChanged =
        seenDirs.size !== entry.dirs.size || [...seenDirs].some((d) => !entry.dirs.has(d));
      entry.dirs = seenDirs;
      if (dirsChanged && entry.primed) this.emit(entry, { type: "reset", vault: entry.vault.id });
      entry.primed = true;
    } catch (err) {
      this.opts.log?.(`[VAULT] reconcile failed for ${entry.vault.root}: ${(err as Error)?.message ?? err}`);
    } finally {
      entry.reconciling = false;
    }
  }

  private emit(entry: WatchEntry, event: VaultWsEvent): void {
    for (const listener of entry.listeners) {
      try {
        listener(event);
      } catch {}
    }
  }

  private startSweep(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      const now = Date.now();
      for (const [id, entry] of this.entries) {
        if (entry.listeners.size > 0 || now - entry.lastActive < this.idleMs) continue;
        clearInterval(entry.reconcileTimer);
        entry.watcher.stop();
        this.entries.delete(id);
      }
      if (this.entries.size === 0 && this.sweepTimer) {
        clearInterval(this.sweepTimer);
        this.sweepTimer = null;
      }
    }, SWEEP_MS);
    this.sweepTimer.unref?.();
  }
}
