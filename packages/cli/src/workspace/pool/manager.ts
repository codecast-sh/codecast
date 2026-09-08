/**
 * Pool manager: pre-warms worktrees and atomically hands them out.
 *
 * The model:
 *   - `maintainPool(repoRoot, size)` ensures `size` slots are in
 *     ready+warming. Empty slots are warmed in the background. Stale slots
 *     are recycled. Called on a timer by the daemon AND on demand.
 *   - `claimFromPool(repoRoot, desiredName)` atomically selects a ready
 *     slot, renames its worktree to `desiredName`, launches Chrome (if
 *     manifest.browser.enabled), and returns a fully-prepared Workspace.
 *   - Pre-warmed slots intentionally SKIP the browser launch so that we
 *     don't have to migrate a running Chrome's user-data-dir across the
 *     post-claim rename. Chrome attaches at claim time.
 *
 * Concurrency: claim mutates pool state under a simple in-process lock
 * (suitable for single-daemon use). For multi-daemon coordination we'd
 * need a file-based lock; out of scope for v1.
 *
 * Nothing here may block the event loop. The maintainer runs these functions
 * on a timer inside the daemon, where one synchronous `git worktree add` on a
 * large repo freezes delivery, injection and the heartbeat for its whole
 * duration (daemon.loopBudget.guard.test.ts). Every child process and every
 * file read below is async for that reason.
 */

import { execFileAsync } from "../../proc.js";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  attachBrowserToWorkspace,
  acquireWorkspace,
} from "../lifecycle.js";
import { deleteState, readState, writeState } from "../contract.js";
import {
  POOL_MAX_AGE_MS,
  initPool,
  markStaleByAge,
  markStaleByHead,
  readPoolState,
  resizePool,
  transitionSlot,
  writePoolState,
  type PoolSlot,
  type PoolState,
} from "./state.js";
import { POOL_MAX_SLOTS, clearDemand } from "./demand.js";
import type { Workspace, WorkspaceState } from "../types.js";

const WORKTREES_DIR = ".codecast/worktrees";

let claimMutex: Promise<void> = Promise.resolve();

async function withClaimLock<T>(fn: () => Promise<T>): Promise<T> {
  const prior = claimMutex;
  let release: () => void = () => {};
  claimMutex = new Promise<void>((r) => (release = r));
  try {
    await prior;
    return await fn();
  } finally {
    release();
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}

// --------------------------------------------------------------------------
// Public API
// --------------------------------------------------------------------------

export interface MaintainOptions {
  /** Skip in-flight warming if true; useful for tests that want a snapshot. */
  skipIfWarming?: boolean;
  /** Override the max-age staleness bar. Default POOL_MAX_AGE_MS. */
  maxAgeMs?: number;
}

/**
 * Bring the pool to the configured size. Slots in `empty` or `stale` get
 * recycled into `warming`. The function returns once all slots are at
 * least in `warming` state; actual `warming → ready` completion happens
 * via separate `warmSlot()` invocations the manager spawns.
 */
export async function maintainPool(
  repoRoot: string,
  requestedSize: number,
  opts: MaintainOptions = {},
): Promise<PoolState> {
  // Clamped here rather than only in the callers: every warm slot is a full
  // checkout of the repo, and this is the one function that builds them, so
  // the ceiling belongs where nothing can route around it (ct-49540).
  const size = Math.max(0, Math.min(Math.trunc(requestedSize) || 0, POOL_MAX_SLOTS));
  let state = readPoolState(repoRoot);
  if (!state) {
    state = initPool(0);
  }
  resizePool(state, size);
  writePoolState(repoRoot, state);

  // Refresh staleness before scheduling new warming work.
  const { headSha, lockHash } = await currentRepoFingerprint(repoRoot);
  markStaleByHead(state, headSha, lockHash);
  markStaleByAge(state, opts.maxAgeMs ?? POOL_MAX_AGE_MS);

  // Crash recovery: a slot left "warming" with no live worker is either
  // (a) actually complete on disk (workspace state ready) — promote to ready
  // (b) orphaned — recycle to stale.
  for (const slot of state.slots) {
    if (slot.state !== "warming") continue;
    if (!slot.workspaceName) {
      // Bizarre state — drop to stale and let recycle handle it.
      transitionSlot(state, slot.slotId, "stale");
      continue;
    }
    const wsState = readState(repoRoot, slot.workspaceName);
    if (wsState && wsState.state === "ready" && (await pathExists(wsState.path))) {
      // Resume — slot completed on a previous run; mark ready.
      transitionSlot(state, slot.slotId, "ready", {
        headSha,
        lockHash,
      });
    } else {
      // Orphan — drop to stale for recycle.
      transitionSlot(state, slot.slotId, "stale");
    }
  }

  // Recycle stale slots back to empty, then drop any the target no longer
  // wants (resizePool leaves surplus slots stale so they get torn down here
  // before they disappear from the state file).
  for (const slot of state.slots) {
    if (slot.state === "stale") {
      await teardownSlotArtifacts(repoRoot, slot);
      transitionSlot(state, slot.slotId, "empty");
    }
  }
  resizePool(state, size);
  writePoolState(repoRoot, state);

  // Schedule warming for empty slots, up to `size`.
  for (const slot of state.slots) {
    if (slot.state === "empty") {
      if (opts.skipIfWarming) continue;
      // Mark warming first (synchronous), then kick off the work.
      transitionSlot(state, slot.slotId, "warming", { workspaceName: slot.slotId });
      writePoolState(repoRoot, state);
      // Fire-and-forget; warmSlot writes its own state updates.
      void warmSlot(repoRoot, slot.slotId).catch((err) => {
        const s = readPoolState(repoRoot);
        if (s) {
          const target = s.slots.find((x) => x.slotId === slot.slotId);
          if (target && target.state === "warming") {
            target.lastError = err instanceof Error ? err.message : String(err);
            transitionSlot(s, slot.slotId, "stale");
            writePoolState(repoRoot, s);
          }
        }
      });
    }
  }
  return readPoolState(repoRoot) ?? state;
}

/**
 * Tear down every slot and forget the pool. `cast ws pool drain` and the
 * teardown path use this to give the disk back without waiting for staleness.
 */
export async function drainPool(repoRoot: string): Promise<number> {
  return withClaimLock(async () => {
    const state = readPoolState(repoRoot);
    if (!state) {
      clearDemand(repoRoot);
      return 0;
    }
    let removed = 0;
    for (const slot of state.slots) {
      if (!slot.workspaceName) continue;
      await teardownSlotArtifacts(repoRoot, slot);
      removed++;
    }
    const { deletePoolState } = await import("./state.js");
    deletePoolState(repoRoot);
    clearDemand(repoRoot);
    return removed;
  });
}

/**
 * Block until at least one slot reaches `ready` (or timeout). Used by tests
 * and by `claimFromPool` when configured to wait for a slot.
 */
export async function waitForReadySlot(
  repoRoot: string,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<PoolSlot | null> {
  const timeoutMs = opts.timeoutMs ?? 60000;
  const pollMs = opts.pollMs ?? 200;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = readPoolState(repoRoot);
    if (state) {
      const ready = state.slots.find((s) => s.state === "ready");
      if (ready) return ready;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return null;
}

export interface ClaimResult {
  workspace: Workspace;
  fromPool: true;
  slotId: string;
}

/**
 * Atomically claim a ready slot and rename its worktree to `desiredName`.
 * Returns null if no slot is ready (caller should fall through to fresh
 * acquireWorkspace).
 */
export async function claimFromPool(
  repoRoot: string,
  desiredName: string,
): Promise<ClaimResult | null> {
  return withClaimLock(async () => {
    const state = readPoolState(repoRoot);
    if (!state) return null;

    const ready = state.slots.find((s) => s.state === "ready");
    if (!ready || !ready.workspaceName) return null;

    // Mark claimed *first*, so concurrent maintainPool sees it as out of pool.
    transitionSlot(state, ready.slotId, "claimed");
    writePoolState(repoRoot, state);

    try {
      await renameWorkspace(repoRoot, ready.workspaceName, desiredName);
      // After rename, slot is no longer holding the workspace. Recycle.
      const s2 = readPoolState(repoRoot);
      if (s2) {
        transitionSlot(s2, ready.slotId, "empty");
        writePoolState(repoRoot, s2);
      }
      // Attach browser if manifest enables it.
      const finalWs = await attachBrowserToWorkspace(repoRoot, desiredName);
      return { workspace: finalWs, fromPool: true, slotId: ready.slotId };
    } catch (err) {
      // Rename failed — restore slot to stale so it's recycled, and rethrow.
      const s2 = readPoolState(repoRoot);
      if (s2) {
        const slot = s2.slots.find((x) => x.slotId === ready.slotId);
        if (slot) {
          slot.lastError = err instanceof Error ? err.message : String(err);
          // slot is currently 'claimed' — drive it through to empty.
          transitionSlot(s2, ready.slotId, "empty");
          writePoolState(repoRoot, s2);
        }
      }
      throw err;
    }
  });
}

// --------------------------------------------------------------------------
// Slot worker — does the actual pre-warm work
// --------------------------------------------------------------------------

/**
 * Pre-warm a single slot. Uses acquireWorkspace with skipBrowser=true so the
 * worktree+setup work happens but Chrome doesn't launch in the pool worktree.
 */
async function warmSlot(repoRoot: string, slotId: string): Promise<void> {
  const slotName = slotId; // we use the slotId as the workspace name
  const result = await acquireWorkspace(repoRoot, slotName, {
    skipBrowser: true,
    skipHooks: true, // hooks fire on real claim, not on pool pre-warm
    skipPool: true, // avoid infinite recursion: pool warming MUST be fresh
  });
  if (result.workspace.state !== "ready") {
    throw new Error(`pool slot ${slotId}: workspace not ready`);
  }
  // Record fingerprint and transition.
  const { headSha, lockHash } = await currentRepoFingerprint(repoRoot);
  const state = readPoolState(repoRoot);
  if (!state) return;
  const slot = state.slots.find((s) => s.slotId === slotId);
  if (!slot) return;
  if (slot.state !== "warming") return; // raced (stale / claimed / empty)
  transitionSlot(state, slotId, "ready", { headSha, lockHash, workspaceName: slotName });
  writePoolState(repoRoot, state);
}

// --------------------------------------------------------------------------
// Repo fingerprint (head sha + lockfile hash)
// --------------------------------------------------------------------------

interface RepoFingerprint {
  headSha: string;
  lockHash: string;
}

const LOCKFILE_CANDIDATES = [
  "bun.lock",
  "bun.lockb",
  "pnpm-lock.yaml",
  "yarn.lock",
  "package-lock.json",
  "uv.lock",
  "poetry.lock",
  "Pipfile.lock",
  "Cargo.lock",
  "go.sum",
] as const;

export async function currentRepoFingerprint(repoRoot: string): Promise<RepoFingerprint> {
  let headSha = "";
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf-8",
    });
    headSha = String(stdout).trim();
  } catch {
    /* leave empty */
  }

  // Hash the contents of the first lockfile we find.
  let lockHash = "";
  for (const candidate of LOCKFILE_CANDIDATES) {
    try {
      const body = await fs.promises.readFile(path.join(repoRoot, candidate));
      lockHash = crypto.createHash("sha256").update(body).digest("hex").slice(0, 16);
      break;
    } catch {
      /* absent or unreadable — try the next one */
    }
  }
  return { headSha, lockHash };
}

/** Lockfiles worth watching for change. Shared with the maintainer's watcher. */
export function lockfileNames(): readonly string[] {
  return LOCKFILE_CANDIDATES;
}

// --------------------------------------------------------------------------
// Workspace rename — atomic transition pool-N → user-chosen name
// --------------------------------------------------------------------------

async function renameWorkspace(
  repoRoot: string,
  fromName: string,
  toName: string,
): Promise<void> {
  const fromState = readState(repoRoot, fromName);
  if (!fromState) throw new Error(`workspace '${fromName}' has no state to rename`);

  const fromPath = fromState.path;
  const toPath = path.join(repoRoot, WORKTREES_DIR, toName);

  if (await pathExists(toPath)) {
    throw new Error(`target worktree path already exists: ${toPath}`);
  }

  // 1. Move the worktree
  await execFileAsync("git", ["worktree", "move", fromPath, toPath], { cwd: repoRoot });

  // 2. Rename the branch (inside the new worktree)
  const fromBranch = fromState.branch;
  const toBranch = `codecast/${toName}`;
  if (fromBranch !== toBranch) {
    await execFileAsync("git", ["branch", "-m", fromBranch, toBranch], { cwd: toPath });
  }

  // 3. Move the state directory and update its contents
  const newState = {
    ...fromState,
    name: toName,
    path: toPath,
    branch: toBranch,
    state: "ready" as WorkspaceState,
    updatedAt: new Date().toISOString(),
  };
  writeState(repoRoot, newState);
  // Remove old state dir (after writing new one, so we never lose state).
  if (fromName !== toName) {
    deleteState(repoRoot, fromName);
  }
}

// --------------------------------------------------------------------------
// Teardown for stale slots
// --------------------------------------------------------------------------

async function teardownSlotArtifacts(
  repoRoot: string,
  slot: PoolSlot,
): Promise<void> {
  if (!slot.workspaceName) return;
  const state = readState(repoRoot, slot.workspaceName);
  if (!state) return;
  try {
    await execFileAsync("git", ["worktree", "remove", "--force", state.path], {
      cwd: repoRoot,
    });
  } catch {
    await fs.promises.rm(state.path, { recursive: true, force: true });
  }
  // Why the branch goes too: slot ids repeat (pool-0 is warmed again and
  // again), and `git worktree remove` keeps the branch. The next warm would
  // then fail to create codecast/pool-0, fall back to attaching the surviving
  // branch, and check the slot out at the OLD tip — while the pool records the
  // repo's CURRENT head as its fingerprint. That is a stale tree the staleness
  // check cannot see, handed to an agent as fresh (ct-49540).
  await execFileAsync("git", ["branch", "-D", state.branch], { cwd: repoRoot })
    .catch(() => {});
  deleteState(repoRoot, slot.workspaceName);
}
