// The capability inventory's ride on the daemon heartbeat.
//
// Same shape as modelInventory.ts, and deliberately so: a background collection
// kicked from the beat (never awaited on it — a slow disk scan must not delay
// device presence), a hash gate so the payload rides only when something
// actually changed, and a mark-sent on ack so it stops riding. The one addition
// is a liveness floor: a machine whose inventory never changes still re-sends
// once an hour with an unchanged hash, so the server can tell "unchanged" from
// "stopped reporting" — the fleet page's `unknown` column depends on that
// difference being real.

import * as crypto from "crypto";
import * as os from "os";
import { readInventory, readInventoryAsync, type Inventory } from "./inventory.js";

export interface CapabilityHeartbeatPayload {
  hash: string;
  collected_at: number;
  items: Inventory["items"];
  marketplaces: Inventory["marketplaces"];
}

// Rescan cadence. The scan is tens of file reads, not free; ten minutes keeps
// the mirror honest without the daemon grinding disks on every 30s beat.
const REFRESH_MS = 10 * 60 * 1000;
// The liveness floor: resend even an unchanged inventory this often.
const RESEND_MS = 60 * 60 * 1000;

let cached: CapabilityHeartbeatPayload | undefined;
let lastCollectedAt = 0;
let lastSentHash: string | undefined;
let lastSentAt = 0;
let inFlight = false;
let collectionHome: string | undefined;
let collectionGeneration = 0;

/** Scan now, synchronously. Exported for tests and `cast doctor`. */
export function collectCapabilityInventory(home = os.homedir(), projectPath?: string): CapabilityHeartbeatPayload {
  return payloadFrom(readInventory(home, projectPath), Date.now());
}

/** The daemon's scan: yields between directory reads, so the heartbeat's
 *  background collection never holds the loop for the whole tree. */
export async function collectCapabilityInventoryAsync(home = os.homedir(), projectPath?: string): Promise<CapabilityHeartbeatPayload> {
  const started = Date.now();
  const inventory = await readInventoryAsync(home, projectPath);
  if (inventory.unreadable.length) throw new Error("capability inventory unavailable");
  return payloadFrom(inventory, started);
}

function payloadFrom(inv: Inventory, started: number): CapabilityHeartbeatPayload {
  const hash = crypto
    .createHash("sha1")
    .update(JSON.stringify({ items: inv.items, marketplaces: inv.marketplaces }))
    .digest("hex")
    .slice(0, 16);
  const elapsed = Date.now() - started;
  // A log line rather than a metric: a slow machine should be diagnosable from
  // a log tail. Only worth a line when it is actually slow.
  if (elapsed > 250) {
    console.log(`[perf] capability scan: ${inv.items.length} items in ${elapsed}ms`);
  }
  return { hash, collected_at: Date.now(), items: inv.items, marketplaces: inv.marketplaces };
}

/** Kick a background rescan when stale. Called per beat; the result rides the
 *  NEXT beat. Never awaited — presence must not wait on a disk scan. */
export function ensureCapabilityInventoryFresh(home = os.homedir()): void {
  if (collectionHome !== home) {
    resetCapabilityHeartbeatState();
    collectionHome = home;
  }
  const generation = collectionGeneration;
  if (inFlight || Date.now() - lastCollectedAt < REFRESH_MS) return;
  inFlight = true;
  void collectCapabilityInventoryAsync(home)
    .then((payload) => {
      if (generation !== collectionGeneration) return;
      cached = payload;
      lastCollectedAt = Date.now();
    })
    .catch(() => {
      // A failed scan leaves the previous cache in place; the next window retries.
    })
    .finally(() => {
      if (generation === collectionGeneration) inFlight = false;
    });
}

/** The payload to attach to this beat, or undefined to ride nothing.
 *  Rides when the hash changed, and once an hour regardless (the floor). */
export function pendingCapabilityPayload(): CapabilityHeartbeatPayload | undefined {
  if (!cached) return undefined;
  if (cached.hash !== lastSentHash) return cached;
  if (Date.now() - lastSentAt >= RESEND_MS) return cached;
  return undefined;
}

/** Record a delivered beat so the payload stops riding until it changes again
 *  (or the hourly floor comes due). */
export function markCapabilityPayloadSent(hash: string): void {
  lastSentHash = hash;
  lastSentAt = Date.now();
}

/** Test seam: reset module state between cases. */
export function resetCapabilityHeartbeatState(): void {
  collectionGeneration++;
  collectionHome = undefined;
  cached = undefined;
  lastCollectedAt = 0;
  lastSentHash = undefined;
  lastSentAt = 0;
  inFlight = false;
}

/* ==========================================================================
 * Convergence signals from the heartbeat response (ct-42847/48)
 * ========================================================================== */

export type CapabilitiesMode = "off" | "dry" | "on";

let lastMode: CapabilitiesMode = "dry";
let desiredRevision = 0;
let appliedRevision = 0;

/** Called by the daemon with each heartbeat response. Cheap by design: the
 *  common case (nothing changed, mode unchanged) is two field writes. */
export function recordConvergenceSignals(payload: { capabilities_mode?: unknown; capability_desired_revision?: unknown }): void {
  const mode = payload.capabilities_mode;
  if (mode === "off" || mode === "dry" || mode === "on") lastMode = mode;
  const rev = payload.capability_desired_revision;
  if (typeof rev === "number" && Number.isFinite(rev) && rev >= desiredRevision) {
    desiredRevision = rev;
  }
}

/**
 * Does the reconciler have anything to do?
 *
 * Mode is read BEFORE the revision compare so `off` costs one field read and
 * nothing else — that is the kill switch's whole contract: a broken reconciler
 * is stopped server-side without shipping a CLI. In steady state (`on`, equal
 * revisions) this is one integer compare, zero syscalls.
 */
export function reconcileNeeded(): { mode: CapabilitiesMode; behind: boolean } {
  if (lastMode === "off") return { mode: "off", behind: false };
  return { mode: lastMode, behind: appliedRevision < desiredRevision };
}

/** The reconciler reports back after a successful plan+apply pass. */
export function markRevisionApplied(revision: number): void {
  if (revision > appliedRevision) appliedRevision = revision;
}

export function convergenceState(): { mode: CapabilitiesMode; desired: number; applied: number } {
  return { mode: lastMode, desired: desiredRevision, applied: appliedRevision };
}

/** Test seam. */
export function resetConvergenceState(): void {
  lastMode = "dry";
  desiredRevision = 0;
  appliedRevision = 0;
}
