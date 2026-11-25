// The git status of the active vault: one map per vault from the daemon's
// porcelain status (daemonClient.fetchGitStatus), shared by the file tree's
// colors, the editor's branch chip and the gutter's base refetch. No CodeMirror
// here: the explorer imports this from the main bundle.
//
// Refreshes are pulled, never polled per row: a watcher event (any change to
// the vault's file table), a save, window focus, and a slow tick while the page
// is visible (a commit changes nothing on disk the watcher reports). Bursts
// coalesce into one request; the daemon's own short cache absorbs the rest.

import { create } from "zustand";
import type { CodeGitFileState, CodeGitStatusResponse } from "@codecast/shared/contracts";
import { useVaultStore } from "../../../store/vaultStore";
import { fetchGitStatus } from "../daemonClient";

export interface VaultGitStatus {
  repo: boolean;
  branch: string | null;
  head: string | null;
  ahead: number;
  behind: number;
  /** The branch tracks an upstream (ahead/behind are against it). */
  upstream: boolean;
  files: Readonly<Record<string, CodeGitFileState>>;
}

interface GitStatusState {
  byVault: Readonly<Record<string, VaultGitStatus>>;
}

export const useGitStatusStore = create<GitStatusState>(() => ({ byVault: {} }));

export function gitStatusOf(vaultId: string): VaultGitStatus | undefined {
  return useGitStatusStore.getState().byVault[vaultId];
}

function sameFiles(a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) if (a[k] !== b[k]) return false;
  return true;
}

/** The wire response as stored; the previous object back when nothing changed,
 *  so a refresh that finds the same status re-renders nobody. */
export function foldStatus(prev: VaultGitStatus | undefined, res: CodeGitStatusResponse): VaultGitStatus {
  const next: VaultGitStatus = {
    repo: res.repo,
    branch: res.branch,
    head: res.head,
    ahead: res.ahead ?? 0,
    behind: res.behind ?? 0,
    upstream: res.ahead !== undefined,
    files: res.files,
  };
  if (
    prev &&
    prev.repo === next.repo &&
    prev.branch === next.branch &&
    prev.head === next.head &&
    prev.ahead === next.ahead &&
    prev.behind === next.behind &&
    prev.upstream === next.upstream &&
    sameFiles(prev.files, next.files)
  ) {
    return prev;
  }
  if (prev && sameFiles(prev.files, next.files)) next.files = prev.files;
  return next;
}

const inflight = new Map<string, Promise<VaultGitStatus | undefined>>();
/** A refresh asked for while one runs: it runs once that one ends, for every
 *  caller who asked meanwhile, since the running one may predate what they saw. */
const queued = new Map<string, { fresh: boolean; run: Promise<VaultGitStatus | undefined> }>();

/** Fetch now. A call while a fetch runs gets the one after it (shared by every
 *  such call), never the answer to a question asked before it. */
export function refreshGitStatus(vaultId: string, opts: { fresh?: boolean } = {}): Promise<VaultGitStatus | undefined> {
  const running = inflight.get(vaultId);
  if (running) {
    const next = queued.get(vaultId);
    if (next) {
      next.fresh ||= !!opts.fresh;
      return next.run;
    }
    const entry = { fresh: !!opts.fresh, run: null as unknown as Promise<VaultGitStatus | undefined> };
    entry.run = running.then(() => {
      queued.delete(vaultId);
      return refreshGitStatus(vaultId, { fresh: entry.fresh });
    });
    queued.set(vaultId, entry);
    return entry.run;
  }
  const { endpoint, isRemote, activeVaultId } = useVaultStore.getState();
  if (!endpoint || isRemote || activeVaultId !== vaultId) return Promise.resolve(gitStatusOf(vaultId));
  const run = fetchGitStatus(endpoint, vaultId, opts)
    .then((res) => {
      const prev = gitStatusOf(vaultId);
      const next = foldStatus(prev, res);
      if (next !== prev) useGitStatusStore.setState((s) => ({ byVault: { ...s.byVault, [vaultId]: next } }));
      return next;
    })
    .catch(() => gitStatusOf(vaultId))
    .finally(() => inflight.delete(vaultId));
  inflight.set(vaultId, run);
  return run;
}

/** The status, fetched once if nothing is held yet. */
export function ensureGitStatus(vaultId: string): Promise<VaultGitStatus | undefined> {
  const held = gitStatusOf(vaultId);
  return held ? Promise.resolve(held) : refreshGitStatus(vaultId);
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();

/** Refresh after a quiet moment: watcher bursts (a checkout, a formatter run)
 *  cost one status. `fresh` skips the daemon's cache (a save just landed). */
export function requestGitStatusRefresh(vaultId: string, opts: { fresh?: boolean; delayMs?: number } = {}): void {
  const t = timers.get(vaultId);
  if (t) clearTimeout(t);
  timers.set(
    vaultId,
    setTimeout(() => {
      timers.delete(vaultId);
      void refreshGitStatus(vaultId, { fresh: opts.fresh });
    }, opts.delayMs ?? 300),
  );
}

/** Calls `fn(vaultId, head)` when a vault's HEAD moves (a commit, a checkout). */
export function onGitHeadChange(fn: (vaultId: string, head: string | null) => void): () => void {
  let last = useGitStatusStore.getState().byVault;
  return useGitStatusStore.subscribe((s) => {
    const prev = last;
    last = s.byVault;
    for (const [id, st] of Object.entries(s.byVault)) {
      const before = prev[id];
      if (before && before !== st && before.head !== st.head) fn(id, st.head);
    }
  });
}

const TICK_MS = 30_000;
/** How long the feed outlives its last holder: a tab switch rebuilds every
 *  editor plugin, and the feed should not stop, restart and refetch for it. */
const RELEASE_GRACE_MS = 2_000;
let feedRefs = 0;
let stopFeed: (() => void) | null = null;
let stopTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Keep the active vault's status current while something on screen shows it.
 * Ref-counted: the tree and every editor may each hold it.
 */
export function holdGitStatusFeed(): () => void {
  if (stopTimer) {
    clearTimeout(stopTimer);
    stopTimer = null;
  }
  if (feedRefs++ === 0 && !stopFeed) stopFeed = startFeed();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--feedRefs > 0) return;
    stopTimer = setTimeout(() => {
      stopTimer = null;
      if (feedRefs > 0) return;
      stopFeed?.();
      stopFeed = null;
    }, RELEASE_GRACE_MS);
  };
}

function startFeed(): () => void {
  const active = () => {
    const s = useVaultStore.getState();
    return s.endpoint && !s.isRemote ? s.activeVaultId : null;
  };
  const first = active();
  if (first) void refreshGitStatus(first);
  const offStore = useVaultStore.subscribe((s, prev) => {
    const id = s.endpoint && !s.isRemote ? s.activeVaultId : null;
    if (!id) return;
    if (id !== prev.activeVaultId || s.endpoint !== prev.endpoint) void refreshGitStatus(id);
    // Every watcher event replaces the file table.
    else if (s.files !== prev.files) requestGitStatusRefresh(id, { delayMs: 500 });
  });
  const onFocus = () => {
    const id = active();
    if (id) requestGitStatusRefresh(id, { delayMs: 50 });
  };
  window.addEventListener("focus", onFocus);
  const tick = setInterval(() => {
    const id = active();
    if (id && document.visibilityState === "visible") void refreshGitStatus(id);
  }, TICK_MS);
  return () => {
    offStore();
    window.removeEventListener("focus", onFocus);
    clearInterval(tick);
  };
}

// ── the file tree's decorations ─────────────────────────────────────────────

/** Which state a folder shows when its files differ: the one that most needs
 *  a look. */
const RANK: Record<CodeGitFileState, number> = {
  conflicted: 5,
  modified: 4,
  renamed: 3,
  deleted: 3,
  added: 2,
  untracked: 1,
};

export interface ExplorerGitDecorations {
  /** Vault-relative file path to its state. */
  files: ReadonlyMap<string, CodeGitFileState>;
  /** Folder path ("" is the vault root) to the strongest state beneath it. */
  dirs: ReadonlyMap<string, CodeGitFileState>;
  /** Files gone from disk, so the tree can still list them. */
  deleted: readonly string[];
}

export const NO_GIT_DECORATIONS: ExplorerGitDecorations = { files: new Map(), dirs: new Map(), deleted: [] };

/**
 * Fold a status map into what the tree draws. Paths are already
 * vault-relative (the daemon strips a subdirectory vault's prefix), so a
 * vault inside a larger repository rolls up from its own root.
 */
export function explorerGitDecorations(files: Readonly<Record<string, CodeGitFileState>> | undefined): ExplorerGitDecorations {
  if (!files) return NO_GIT_DECORATIONS;
  const entries = Object.entries(files);
  if (!entries.length) return NO_GIT_DECORATIONS;
  const fileMap = new Map<string, CodeGitFileState>();
  const dirs = new Map<string, CodeGitFileState>();
  const deleted: string[] = [];
  for (const [rawPath, state] of entries) {
    // An untracked folder reported whole ("dir/") marks the folder.
    const isDir = rawPath.endsWith("/");
    const path = isDir ? rawPath.slice(0, -1) : rawPath;
    if (!path) continue;
    if (isDir) dirs.set(path, maxState(dirs.get(path), state));
    else fileMap.set(path, state);
    if (state === "deleted" && !isDir) deleted.push(path);
    for (let i = path.lastIndexOf("/"); i > 0; i = path.lastIndexOf("/", i - 1)) {
      const dir = path.slice(0, i);
      dirs.set(dir, maxState(dirs.get(dir), state));
    }
  }
  return { files: fileMap, dirs, deleted };
}

function maxState(a: CodeGitFileState | undefined, b: CodeGitFileState): CodeGitFileState {
  return a && RANK[a] >= RANK[b] ? a : b;
}

/** The sol color a state draws in, for names and dots. */
export const GIT_STATE_COLOR: Record<CodeGitFileState, string> = {
  modified: "var(--sol-yellow)",
  renamed: "var(--sol-blue)",
  added: "var(--sol-green)",
  untracked: "var(--sol-green)",
  deleted: "var(--sol-red)",
  conflicted: "var(--sol-magenta)",
};
