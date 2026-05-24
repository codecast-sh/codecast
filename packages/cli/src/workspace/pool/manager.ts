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
 */

import { execSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  attachBrowserToWorkspace,
  acquireWorkspace,
} from "../lifecycle.js";
import { deleteState, readState, writeState } from "../contract.js";
import {
  initPool,
  markStaleByHead,
  readPoolState,
  transitionSlot,
  writePoolState,
  type PoolSlot,
  type PoolState,
} from "./state.js";
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

// --------------------------------------------------------------------------
// Public API
// --------------------------------------------------------------------------

export interface MaintainOptions {
  /** Skip in-flight warming if true; useful for tests that want a snapshot. */
  skipIfWarming?: boolean;
}

/**
 * Bring the pool to the configured size. Slots in `empty` or `stale` get
 * recycled into `warming`. The function returns once all slots are at
 * least in `warming` state; actual `warming → ready` completion happens
 * via separate `warmSlot()` invocations the manager spawns.
 */
export async function maintainPool(
  repoRoot: string,
  size: number,
  opts: MaintainOptions = {},
): Promise<PoolState> {
  let state = readPoolState(repoRoot);
  if (!state || state.size !== size) {
    state = initPool(size);
    writePoolState(repoRoot, state);
  }

  // Refresh stale-by-head info before scheduling new warming work.
  const { headSha, lockHash } = currentRepoFingerprint(repoRoot);
  markStaleByHead(state, headSha, lockHash);

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
    if (wsState && wsState.state === "ready" && fs.existsSync(wsState.path)) {
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

  // Recycle stale slots back to empty.
  for (const slot of state.slots) {
    if (slot.state === "stale") {
      await teardownSlotArtifacts(repoRoot, slot);
      transitionSlot(state, slot.slotId, "empty");
    }
  }
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
  const { headSha, lockHash } = currentRepoFingerprint(repoRoot);
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

export function currentRepoFingerprint(repoRoot: string): RepoFingerprint {
  let headSha = "";
  try {
    headSha = execSync("git rev-parse HEAD", {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    /* leave empty */
  }

  // Hash the contents of the first lockfile we find.
  const lockCandidates = [
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
  ];
  let lockHash = "";
  for (const c of lockCandidates) {
    const p = path.join(repoRoot, c);
    if (fs.existsSync(p)) {
      try {
        lockHash = crypto
          .createHash("sha256")
          .update(fs.readFileSync(p))
          .digest("hex")
          .slice(0, 16);
        break;
      } catch {
        /* skip */
      }
    }
  }
  return { headSha, lockHash };
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

  if (fs.existsSync(toPath)) {
    throw new Error(`target worktree path already exists: ${toPath}`);
  }

  // 1. Move the worktree
  execSync(`git worktree move ${JSON.stringify(fromPath)} ${JSON.stringify(toPath)}`, {
    cwd: repoRoot,
    stdio: ["ignore", "ignore", "pipe"],
  });

  // 2. Rename the branch (inside the new worktree)
  const fromBranch = fromState.branch;
  const toBranch = `codecast/${toName}`;
  if (fromBranch !== toBranch) {
    execSync(`git branch -m ${fromBranch} ${toBranch}`, {
      cwd: toPath,
      stdio: ["ignore", "ignore", "pipe"],
    });
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
    execSync(`git worktree remove --force ${JSON.stringify(state.path)}`, {
      cwd: repoRoot,
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch {
    if (fs.existsSync(state.path)) {
      fs.rmSync(state.path, { recursive: true, force: true });
    }
  }
  deleteState(repoRoot, slot.workspaceName);
}
