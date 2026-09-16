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
import * as fs from "fs";
import * as os from "os";
import { RecursiveWatcher } from "../recursiveWatcher.js";
import { capabilityWatchDirs, readInventory, readInventoryAsync, type Inventory, type InventoryItem } from "./inventory.js";

export interface CapabilityHeartbeatPayload {
  hash: string;
  collected_at: number;
  items: Inventory["items"];
  marketplaces: Inventory["marketplaces"];
}

/** One markdown body, hashed so an unchanged skill stops riding. */
export interface CapabilityContentItem {
  kind: string;
  name: string;
  hash: string;
  body: string;
}

// Rescan cadence. The scan is tens of file reads, not free; ten minutes keeps
// the mirror honest without the daemon grinding disks on every 30s beat.
const REFRESH_MS = 10 * 60 * 1000;
// The liveness floor: resend even an unchanged inventory this often.
const RESEND_MS = 60 * 60 * 1000;
/** Longest body we will ship. The biggest skill on a loaded machine is ~36KB;
 *  past this the reader still opens, it just says the rest was cut. */
export const MAX_CONTENT_BODY_CHARS = 64 * 1024;
/** Bytes of bodies one beat will carry. A 5MB skills tree cannot ride at once,
 *  and the heartbeat is presence — it must stay small. */
export const CONTENT_BATCH_CHARS = 96 * 1024;

let cached: CapabilityHeartbeatPayload | undefined;
let lastCollectedAt = 0;
let lastSentHash: string | undefined;
let lastSentAt = 0;
let inFlight = false;
let collectionHome: string | undefined;
let collectionGeneration = 0;
let cachedContents: CapabilityContentItem[] = [];
let sentContentHashes = new Set<string>();
let sourceWatchers: RecursiveWatcher[] = [];

const MARKDOWN_KINDS = new Set(["skill", "command", "subagent", "snippet"]);

function attachMissingBodiesSync(items: InventoryItem[]): void {
  for (const item of items) {
    if (item.body || !item.source || !MARKDOWN_KINDS.has(item.kind)) continue;
    try {
      item.body = fs.readFileSync(item.source, "utf-8");
    } catch {
      // Same rule as the scanner: an unreadable file is not a body.
    }
  }
}

/** Scan now, synchronously. Exported for tests and `cast doctor`. */
export function collectCapabilityInventory(home = os.homedir(), projectPath?: string): CapabilityHeartbeatPayload {
  const inventory = readInventory(home, projectPath);
  attachMissingBodiesSync(inventory.items);
  return payloadFrom(inventory, Date.now());
}

/** The daemon's scan: yields between directory reads, so the heartbeat's
 *  background collection never holds the loop for the whole tree. */
async function attachMissingBodies(items: InventoryItem[]): Promise<void> {
  for (const item of items) {
    if (item.body || !item.source || !MARKDOWN_KINDS.has(item.kind)) continue;
    try {
      item.body = fs.readFileSync(item.source, "utf-8");
    } catch {
      // Same rule as the scanner: an unreadable file is not a body.
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
}

export async function collectCapabilityInventoryAsync(home = os.homedir(), projectPath?: string): Promise<CapabilityHeartbeatPayload> {
  const started = Date.now();
  const inventory = await readInventoryAsync(home, projectPath);
  if (inventory.unreadable.length) throw new Error("capability inventory unavailable");
  // The worker path strips bodies so pages stay small. Fill them from
  // `source` here, one file per loop turn.
  await attachMissingBodies(inventory.items);
  return payloadFrom(inventory, started);
}

function hashBody(body: string): string {
  return crypto.createHash("sha1").update(body).digest("hex").slice(0, 16);
}

function stripBody(item: InventoryItem): InventoryItem {
  if (item.body === undefined) return item;
  const { body: _body, ...rest } = item;
  return rest;
}

function extractContents(items: InventoryItem[]): { items: InventoryItem[]; contents: CapabilityContentItem[] } {
  const stripped: InventoryItem[] = [];
  const contents: CapabilityContentItem[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (item.body) {
      const key = `${item.kind}\0${item.name}`;
      if (!seen.has(key)) {
        seen.add(key);
        const body =
          item.body.length > MAX_CONTENT_BODY_CHARS
            ? item.body.slice(0, MAX_CONTENT_BODY_CHARS - 1) + "…"
            : item.body;
        // Hash later, when the body actually rides — hashing hundreds of
        // skills in the scan's last tick would hold the daemon loop.
        contents.push({ kind: item.kind, name: item.name, hash: "", body });
      }
    }
    stripped.push(item.body === undefined ? item : stripBody(item));
  }
  return { items: stripped, contents };
}

function payloadFrom(inv: Inventory, started: number): CapabilityHeartbeatPayload {
  const { items, contents } = extractContents(inv.items);
  cachedContents = contents;
  const hash = crypto
    .createHash("sha1")
    .update(JSON.stringify({ items, marketplaces: inv.marketplaces }))
    .digest("hex")
    .slice(0, 16);
  const elapsed = Date.now() - started;
  // A log line rather than a metric: a slow machine should be diagnosable from
  // a log tail. Only worth a line when it is actually slow.
  if (elapsed > 250) {
    console.log(`[perf] capability scan: ${inv.items.length} items in ${elapsed}ms`);
  }
  return { hash, collected_at: Date.now(), items, marketplaces: inv.marketplaces };
}

/** Watch user-scope skill/command/agent dirs. A new SKILL.md then shows up
 *  on the next beat instead of after the 10-minute fallback. Called once
 *  from daemon boot — not from the per-beat ensure, so tests that scan a
 *  temp tree do not pay for a watcher.
 *
 *  One RecursiveWatcher per root, never a watch per file: these trees hold
 *  ~3000 entries on a machine with a few skill collections, and under bun on
 *  macOS every fs.watch rebuilds the process's single FSEvents stream while
 *  holding the lock the JS thread needs — 200ms each when fseventsd is busy,
 *  so a per-file watcher froze the daemon for minutes at boot (2026-09-15).
 *  The kick is idempotent, so the safety-net rescan can be rare. */
export function startCapabilitySourceWatcher(home = os.homedir()): void {
  if (sourceWatchers.length > 0) return;
  const dirs = capabilityWatchDirs(home).filter((dir) => {
    try {
      return fs.statSync(dir).isDirectory();
    } catch {
      return false;
    }
  });
  const kick = () => {
    lastCollectedAt = 0;
    ensureCapabilityInventoryFresh(home);
  };
  sourceWatchers = dirs.map((dir) => {
    const watcher = new RecursiveWatcher({
      path: dir,
      filter: () => true,
      // chokidar's depth 3 counted directories; a file three dirs down has
      // four path segments.
      maxDepth: 4,
      debounceMs: 200,
      rescanIntervalMs: 60_000,
      callback: kick,
    });
    watcher.on("error", () => {});
    watcher.start();
    return watcher;
  });
}

export function stopCapabilitySourceWatcher(): void {
  for (const watcher of sourceWatchers) watcher.stop();
  sourceWatchers = [];
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

/** Bodies that have not been acked yet, up to the per-beat budget.
 *  Independent of the inventory hash: a body-only edit still ships, and a
 *  first scan's 5MB of skills fills across a handful of beats rather than
 *  one giant payload. */
export function pendingCapabilityContents(): CapabilityContentItem[] | undefined {
  if (cachedContents.length === 0) return undefined;
  const batch: CapabilityContentItem[] = [];
  let used = 0;
  for (const item of cachedContents) {
    if (!item.hash) item.hash = hashBody(item.body);
    if (sentContentHashes.has(item.hash)) continue;
    if (used + item.body.length > CONTENT_BATCH_CHARS && batch.length > 0) break;
    batch.push(item);
    used += item.body.length;
  }
  return batch.length > 0 ? batch : undefined;
}

export function markCapabilityContentsSent(hashes: string[]): void {
  for (const hash of hashes) sentContentHashes.add(hash);
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
  cachedContents = [];
  sentContentHashes = new Set();
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
