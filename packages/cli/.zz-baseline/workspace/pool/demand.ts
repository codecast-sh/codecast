/**
 * How big the warm pool for a repo should be, decided by recent demand.
 *
 * A warm slot is a whole checkout plus a full `bun install`: minutes of CPU
 * and a gigabyte of disk. Warming one for every repo the daemon has ever seen
 * spends that on repos nobody is spawning in, so the pool sizes itself from
 * what actually happened: every real workspace create appends a timestamp
 * here, and the target is the number of creates in the burst window minus the
 * one that is being served right now. An isolated create therefore earns no
 * replacement; the second create inside five minutes earns one, and a burst of
 * parallel spawns walks the pool up to the cap.
 *
 * The history lives in its own small file rather than in the pool state,
 * because the maintainer WATCHES it: a `cast ws acquire` in some other process
 * records its create here and the daemon's maintainer wakes on the change and
 * re-arms immediately, with no IPC between them. Folding it into the pool
 * state would make the maintainer's own writes wake itself forever.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { atomicWriteFile } from "../../atomicWrite.js";
import { POOL_DIR } from "./state.js";

/** Hard ceiling on warm slots per repo, whatever the demand. */
export const POOL_MAX_SLOTS = 3;

/** Two creates this close together mean more are coming. */
export const POOL_BURST_WINDOW_MS = 5 * 60_000;

/** Never keep more stamps than the largest pool the window can justify. */
const MAX_STAMPS = 16;

export function demandFile(repoRoot: string): string {
  return path.join(repoRoot, POOL_DIR, "demand.json");
}

/** Epoch-ms stamps of recent workspace creates, oldest first. */
export function readDemand(repoRoot: string): number[] {
  try {
    const raw = JSON.parse(fs.readFileSync(demandFile(repoRoot), "utf-8")) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter((n): n is number => typeof n === "number" && Number.isFinite(n));
  } catch {
    return [];
  }
}

/**
 * Record one real workspace create and return the pruned history. Called from
 * the acquire path before it tries to claim, so the slot it is about to
 * consume is already accounted for when the maintainer re-arms.
 */
export async function recordWorkspaceCreate(
  repoRoot: string,
  now = Date.now(),
): Promise<number[]> {
  const kept = [...readDemand(repoRoot), now]
    .filter((t) => now - t <= POOL_BURST_WINDOW_MS)
    .slice(-MAX_STAMPS);
  const file = demandFile(repoRoot);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  atomicWriteFile(file, JSON.stringify(kept));
  return kept;
}

/**
 * Target slot count for a repo. `creates - 1` because one of those creates is
 * the one being served: the first create of a session pays for itself and
 * leaves nothing behind, and only a repo in a burst holds warm slots.
 */
export function desiredPoolSize(
  creates: number[],
  now = Date.now(),
  cap = POOL_MAX_SLOTS,
): number {
  const inWindow = creates.filter((t) => now - t <= POOL_BURST_WINDOW_MS).length;
  return Math.max(0, Math.min(cap, inWindow - 1));
}

/** Convenience: read the history and size the pool in one call. */
export function desiredPoolSizeForRepo(
  repoRoot: string,
  now = Date.now(),
  cap = POOL_MAX_SLOTS,
): number {
  return desiredPoolSize(readDemand(repoRoot), now, cap);
}

export function clearDemand(repoRoot: string): void {
  try {
    fs.rmSync(demandFile(repoRoot), { force: true });
  } catch {
    /* nothing to clear */
  }
}
