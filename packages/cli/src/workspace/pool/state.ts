/**
 * Warm pool state model and persistence.
 *
 * The pool is a small set of pre-built worktrees the daemon maintains so
 * acquireWorkspace can hand out a fully-prepared workspace in ~milliseconds
 * instead of waiting on git worktree + bun install per spawn.
 *
 * State lives at <repoRoot>/.codecast/workspaces/_pool/state.json.
 *
 * Slot states (left-to-right is forward progress):
 *   - empty:    slot exists in state but no worktree yet
 *   - warming:  worktree+setup in progress
 *   - ready:    fully prepared, available to claim
 *   - claimed:  has been handed out via acquireWorkspace; not eligible
 *   - stale:    headSha or lockfile changed; slot will be replaced
 *
 * Transitions allowed:
 *   empty   → warming
 *   warming → ready | stale
 *   ready   → claimed | stale
 *   claimed → (slot gone, fresh slot recreated separately)
 *   stale   → empty (slot recycled)
 */

import * as fs from "node:fs";
import * as path from "node:path";

export type PoolSlotState =
  | "empty"
  | "warming"
  | "ready"
  | "claimed"
  | "stale";

export interface PoolSlot {
  /** Stable slot id, e.g., "pool-0". */
  slotId: string;
  /** When state="warming"|"ready"|"claimed", the workspace name on disk. */
  workspaceName?: string;
  /** Git HEAD sha at the time the slot was warmed. Detects staleness. */
  headSha?: string;
  /** Lockfile hash at warm time. Detects staleness across dep changes. */
  lockHash?: string;
  /** Current state. */
  state: PoolSlotState;
  /** ISO timestamp of last state transition. */
  updatedAt: string;
  /** Last error if warming failed. Cleared on next attempt. */
  lastError?: string;
}

export interface PoolState {
  /** Configured pool size (target N of ready+warming slots). */
  size: number;
  slots: PoolSlot[];
  /** ISO timestamp of last state mutation. */
  updatedAt: string;
}

/** Conventional location of the pool state file. */
export const POOL_DIR = ".codecast/workspaces/_pool";

function poolStateFile(repoRoot: string): string {
  return path.join(repoRoot, POOL_DIR, "state.json");
}

export function readPoolState(repoRoot: string): PoolState | null {
  const p = poolStateFile(repoRoot);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as PoolState;
  } catch {
    return null;
  }
}

export function writePoolState(repoRoot: string, state: PoolState): void {
  const p = poolStateFile(repoRoot);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  state.updatedAt = new Date().toISOString();
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, p);
}

export function deletePoolState(repoRoot: string): void {
  const dir = path.dirname(poolStateFile(repoRoot));
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

/** Allowed transitions, expressed as a sparse map for clarity. */
const TRANSITIONS: Record<PoolSlotState, PoolSlotState[]> = {
  empty: ["warming"],
  warming: ["ready", "stale", "empty"], // empty allowed when wiping a failed attempt
  ready: ["claimed", "stale"],
  claimed: ["empty"], // post-release, slot recycled
  stale: ["empty"],
};

export class PoolTransitionError extends Error {
  constructor(public readonly from: PoolSlotState, public readonly to: PoolSlotState) {
    super(`pool slot transition not allowed: ${from} → ${to}`);
    this.name = "PoolTransitionError";
  }
}

/** Transition one slot; throws on illegal transition. */
export function transitionSlot(
  state: PoolState,
  slotId: string,
  to: PoolSlotState,
  patch?: Partial<PoolSlot>,
): PoolState {
  const slot = state.slots.find((s) => s.slotId === slotId);
  if (!slot) {
    throw new Error(`pool slot '${slotId}' not found`);
  }
  if (!TRANSITIONS[slot.state].includes(to)) {
    throw new PoolTransitionError(slot.state, to);
  }
  slot.state = to;
  slot.updatedAt = new Date().toISOString();
  if (patch) Object.assign(slot, patch);
  if (to === "empty") {
    slot.workspaceName = undefined;
    slot.headSha = undefined;
    slot.lockHash = undefined;
    slot.lastError = undefined;
  }
  state.updatedAt = slot.updatedAt;
  return state;
}

/** Mark slots stale based on a head/lock mismatch. Returns the modified state. */
export function markStaleByHead(
  state: PoolState,
  expectedHeadSha: string,
  expectedLockHash: string,
): PoolState {
  for (const slot of state.slots) {
    if (slot.state !== "ready" && slot.state !== "warming") continue;
    const headMismatch = slot.headSha && slot.headSha !== expectedHeadSha;
    const lockMismatch = slot.lockHash && slot.lockHash !== expectedLockHash;
    if (headMismatch || lockMismatch) {
      slot.state = "stale";
      slot.updatedAt = new Date().toISOString();
    }
  }
  state.updatedAt = new Date().toISOString();
  return state;
}

/** Initialize an empty pool with `size` slots. */
export function initPool(size: number): PoolState {
  const now = new Date().toISOString();
  const slots: PoolSlot[] = [];
  for (let i = 0; i < size; i++) {
    slots.push({
      slotId: `pool-${i}`,
      state: "empty",
      updatedAt: now,
    });
  }
  return { size, slots, updatedAt: now };
}
