// Owning a few keys inside a JSON file somebody else also edits.
//
// The capability materializer writes into files it does not own: Claude Code's
// `settings.json` (`enabledPlugins`, `extraKnownMarketplaces`), a project's
// `.mcp.json` (`mcpServers`), and eventually a Cursor or Codex equivalent. The
// user edits those files by hand, Claude Code rewrites them, and git may carry
// them. So the rule is the same one the markdown installer follows: touch only
// what we put there, and prove we put it there before touching it.
//
// Markdown could mark ownership inline, with a heading and an end marker.
// JSON cannot — `"enabledPlugins": {"x@y": true}` has nowhere to hide a marker,
// and inventing one would corrupt a schema another tool validates. So ownership
// lives in a sidecar LEDGER recording the exact value we last wrote at each
// path. The target file stays pristine; what we own is derived by comparison.
//
// That gives an honest answer to the case that matters — the user hand-edits a
// value we own:
//
//   owned, still wanted, unchanged since we wrote it  → update it
//   owned, still wanted, CHANGED by the user          → leave theirs, report a conflict
//   owned, no longer wanted, unchanged                → remove it
//   owned, no longer wanted, changed by the user      → leave it, and stop claiming it
//   never owned                                       → never touched, whatever it says
//
// The fourth rule is the subtle one: once someone edits a value, it is theirs.
// Removing it later because we happened to add it first would delete work.

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

/** One key we intend to own, addressed by a path of literal object keys.
 *  Keys are given as a segment array rather than a dotted string because real
 *  ones contain dots and at-signs (`enabledPlugins` → `frontend-design@mkt`). */
export interface OwnedKey {
  keyPath: string[];
  value: unknown;
}

/** What we last wrote, keyed by the encoded key path. */
export type OwnershipLedger = Record<string, unknown>;

export interface MergeConflict {
  keyPath: string[];
  /** The value we wrote and expected to find. */
  ours: unknown;
  /** What is actually there now. */
  theirs: unknown;
  /** Whether we wanted to update this key or remove it. */
  intent: "update" | "remove";
}

export interface MergePlan {
  /** The document to write. Structurally shared with `current` where possible,
   *  but never mutates it — callers may still need the original for a diff. */
  next: unknown;
  /** Key paths this plan sets. */
  writes: string[][];
  /** Key paths this plan deletes. */
  removals: string[][];
  /** Keys the user has taken over. Left exactly as they are. */
  conflicts: MergeConflict[];
  /** The ledger to persist alongside the write. */
  ledger: OwnershipLedger;
  /** False when the document is already correct — skip the write entirely so a
   *  reconcile loop cannot cause a file-watcher storm. */
  changed: boolean;
}

/** Encode a key path for the ledger. U+0000 cannot occur in a JSON key read
 *  from a file, so it is a safe separator where `.` and `/` are not. */
export function encodeKeyPath(keyPath: string[]): string {
  return keyPath.join("\u0000");
}

export function decodeKeyPath(encoded: string): string[] {
  return encoded.split("\u0000");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Deep structural equality, enough for config values (JSON only). */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => sameValue(x, b[i]));
  }
  if (isRecord(a) && isRecord(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && sameValue(a[k], b[k]));
  }
  return false;
}

function getAt(doc: unknown, keyPath: string[]): { found: boolean; value: unknown } {
  let node: unknown = doc;
  for (const key of keyPath) {
    if (!isRecord(node) || !Object.prototype.hasOwnProperty.call(node, key)) {
      return { found: false, value: undefined };
    }
    node = node[key];
  }
  return { found: true, value: node };
}

/** Set a value, cloning only the objects along the path. A non-object standing
 *  where a container belongs is replaced — a malformed file should not stop the
 *  reconcile, and the ledger records nothing about a value we never wrote. */
function setAt(doc: unknown, keyPath: string[], value: unknown): Record<string, unknown> {
  const [head, ...rest] = keyPath;
  const base: Record<string, unknown> = isRecord(doc) ? { ...doc } : {};
  base[head] = rest.length === 0 ? value : setAt(base[head], rest, value);
  return base;
}

/** Delete a value, pruning containers we emptied — but never the root, and
 *  never a container that still holds anything of the user's. */
function deleteAt(doc: Record<string, unknown>, keyPath: string[]): Record<string, unknown> {
  const [head, ...rest] = keyPath;
  if (!Object.prototype.hasOwnProperty.call(doc, head)) return doc;
  const base: Record<string, unknown> = { ...doc };
  if (rest.length === 0) {
    delete base[head];
    return base;
  }
  const child = base[head];
  if (!isRecord(child)) return doc; // the path no longer leads anywhere
  const pruned = deleteAt(child, rest);
  if (Object.keys(pruned).length === 0) delete base[head];
  else base[head] = pruned;
  return base;
}

/**
 * Work out what to write, given the file as it stands, the keys we want to own
 * now, and the ledger of what we owned before. Pure: no filesystem, no clock.
 */
export function planJsonMerge(
  current: unknown,
  desired: OwnedKey[],
  previousLedger: OwnershipLedger = {},
): MergePlan {
  let next: Record<string, unknown> = isRecord(current) ? current : {};
  const writes: string[][] = [];
  const removals: string[][] = [];
  const conflicts: MergeConflict[] = [];
  const ledger: OwnershipLedger = {};

  const desiredByKey = new Map(desired.map((d) => [encodeKeyPath(d.keyPath), d]));

  for (const [encoded, want] of desiredByKey) {
    const { keyPath, value } = want;
    const existing = getAt(next, keyPath);
    const wasOwned = Object.prototype.hasOwnProperty.call(previousLedger, encoded);

    if (existing.found && !wasOwned) {
      // Somebody else's key that happens to be one we now want. Adopting it
      // silently would let a later removal delete their setting, so report it
      // and leave the file alone.
      if (!sameValue(existing.value, value)) {
        conflicts.push({ keyPath, ours: value, theirs: existing.value, intent: "update" });
        continue;
      }
      // Already exactly what we wanted. Claim it without writing anything.
      ledger[encoded] = value;
      continue;
    }

    if (existing.found && wasOwned && !sameValue(existing.value, previousLedger[encoded])) {
      // We wrote it, then the user changed it. Their edit wins.
      conflicts.push({
        keyPath,
        ours: previousLedger[encoded],
        theirs: existing.value,
        intent: "update",
      });
      continue;
    }

    ledger[encoded] = value;
    if (existing.found && sameValue(existing.value, value)) continue; // already right
    next = setAt(next, keyPath, value);
    writes.push(keyPath);
  }

  for (const [encoded, wroteValue] of Object.entries(previousLedger)) {
    if (desiredByKey.has(encoded)) continue;
    const keyPath = decodeKeyPath(encoded);
    const existing = getAt(next, keyPath);
    if (!existing.found) continue; // already gone
    if (!sameValue(existing.value, wroteValue)) {
      // Changed since we wrote it — the user has adopted this key. Leave it and
      // stop claiming it, so we never delete an edit we did not make.
      conflicts.push({ keyPath, ours: wroteValue, theirs: existing.value, intent: "remove" });
      continue;
    }
    next = deleteAt(next, keyPath);
    removals.push(keyPath);
  }

  return {
    next,
    writes,
    removals,
    conflicts,
    ledger,
    changed: writes.length > 0 || removals.length > 0,
  };
}

// ------------------------------------------------------------------ the disk

/** Where the ledger for `target` lives: a dotfile beside it, named for the
 *  file it tracks, so one directory can hold several without collision. */
export function ledgerPathFor(target: string): string {
  return path.join(path.dirname(target), `.codecast-owned.${path.basename(target)}`);
}

/**
 * The on-disk envelope, versioned and MACed.
 *
 * `schema_version` is the whole-tree-clobber lesson applied to the filesystem:
 * machines run different CLI versions for weeks, and an older binary that
 * cannot fully read a newer ledger must write NOTHING and remove NOTHING —
 * deleting what a newer binary manages is the same failure as a stale tree
 * deploying over prod, and this repo has paid for that three times.
 *
 * The MAC (HMAC-SHA256 over the entries, keyed off the machine key) is a
 * TAMPER DETECTOR, not protection: the daemon and any agent run as the same
 * user, so anything that can read the key can re-MAC — machineKey.ts says the
 * same about hardware binding. What it buys is real but narrower: a hand-edited
 * or tool-mangled ledger is refused as authority for DELETION instead of
 * silently trusted, and the refusal names itself.
 */
export const LEDGER_SCHEMA_VERSION = 1;

interface LedgerEnvelope {
  schema_version: number;
  entries: OwnershipLedger;
  mac?: string;
}

function ledgerMac(entries: OwnershipLedger): string | undefined {
  try {
    const { getMachineKey } = require("../machineKey.js");
    const key = getMachineKey().secret;
    return crypto.createHmac("sha256", key).update(JSON.stringify(entries)).digest("hex").slice(0, 32);
  } catch {
    // No machine key (fresh install, exotic platform): the ledger still works,
    // unverified — refusing to function without a MAC would break the feature
    // the MAC only audits.
    return undefined;
  }
}

export interface LedgerReadResult {
  entries: OwnershipLedger;
  /** The envelope's version was newer than this binary understands: treat
   *  every key as unowned, write nothing, remove nothing, say "needs upgrade". */
  needsUpgrade: boolean;
  /** Entries present but the MAC did not verify: usable for ADDING our own
   *  keys, never as authority for deleting anything. */
  tampered: boolean;
}

export function readLedgerDetailed(target: string): LedgerReadResult {
  try {
    const doc = JSON.parse(fs.readFileSync(ledgerPathFor(target), "utf-8"));
    if (!isRecord(doc)) return { entries: {}, needsUpgrade: false, tampered: false };
    // Legacy (pre-envelope) ledgers are bare entry maps: readable, unversioned,
    // un-MACed. Preserved as-is; the next write upgrades them to the envelope.
    if (typeof (doc as unknown as LedgerEnvelope).schema_version !== "number") {
      return { entries: doc as OwnershipLedger, needsUpgrade: false, tampered: false };
    }
    const env = doc as unknown as LedgerEnvelope;
    if (env.schema_version > LEDGER_SCHEMA_VERSION) {
      // Unknown entries are always preserved — by not touching the file at all.
      return { entries: {}, needsUpgrade: true, tampered: false };
    }
    const entries = isRecord(env.entries) ? env.entries : {};
    if (env.mac !== undefined) {
      const expect = ledgerMac(entries);
      if (expect !== undefined && expect !== env.mac) {
        return { entries, needsUpgrade: false, tampered: true };
      }
    }
    return { entries, needsUpgrade: false, tampered: false };
  } catch {
    return { entries: {}, needsUpgrade: false, tampered: false };
  }
}

export function readLedger(target: string): OwnershipLedger {
  return readLedgerDetailed(target).entries;
}

export interface ApplyResult extends MergePlan {
  /** "needs_upgrade": the ledger was written by a newer CLI — nothing was
   *  written or removed; update codecast on this machine before changing the
   *  file here. */
  status: "applied" | "needs_upgrade";
  /** False in a dry run, or when nothing needed writing. */
  wrote: boolean;
}

/**
 * Apply `desired` to a JSON file, owning only what we previously wrote.
 *
 * With `dryRun`, nothing is touched and the returned plan is exactly what the
 * UI should preview — the same code path produces the preview and the write, so
 * a preview can never disagree with what happens next.
 */
export function applyOwnedJson(
  target: string,
  desired: OwnedKey[],
  opts: { dryRun?: boolean; indent?: number; mode?: number; adopt?: boolean } = {},
): ApplyResult {
  const raw = (() => {
    try {
      return JSON.parse(fs.readFileSync(target, "utf-8"));
    } catch {
      return undefined;
    }
  })();

  // `adopt` is for a key whose value is genuinely SHARED — a hooks array holding
  // the user's entries and ours. There the caller has already folded the existing
  // value into what it is asking for, so the default rule ("a key I do not own is
  // a conflict") would refuse to write the very merge it was handed. Anywhere the
  // value is wholly ours, the default is the safer answer and stays.
  const previous = readLedger(target);
  if (opts.adopt) {
    for (const want of desired) {
      const key = encodeKeyPath(want.keyPath);
      if (!(key in previous)) {
        const existing = getAt(raw, want.keyPath);
        if (existing.found) previous[key] = existing.value;
      }
    }
  }
  // A ledger from a NEWER binary: this one writes nothing and removes nothing.
  const detailed = readLedgerDetailed(target);
  if (detailed.needsUpgrade) {
    return {
      status: "needs_upgrade",
      next: raw,
      changed: false,
      ledger: {},
      writes: [],
      removals: [],
      conflicts: [],
      wrote: false,
    };
  }

  const plan = planJsonMerge(raw, desired, previous);

  // The ledger must be persisted even when the document is unchanged: claiming
  // a key that already held the right value, or releasing one the user took
  // over, changes what we may touch next time without changing the file.
  const ledgerFile = ledgerPathFor(target);
  const ledgerChanged = !sameValue(plan.ledger, readLedger(target));

  if (opts.dryRun || (!plan.changed && !ledgerChanged)) {
    return { ...plan, status: "applied", wrote: false };
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (plan.changed) {
    fs.writeFileSync(target, JSON.stringify(plan.next, null, opts.indent ?? 2) + "\n", { mode: opts.mode ?? 0o600 });
  }
  if (Object.keys(plan.ledger).length === 0) {
    try {
      fs.unlinkSync(ledgerFile);
    } catch {
      // Nothing left to track and no ledger to remove.
    }
  } else {
    const envelope: LedgerEnvelope = {
      schema_version: LEDGER_SCHEMA_VERSION,
      entries: plan.ledger,
      ...(ledgerMac(plan.ledger) !== undefined ? { mac: ledgerMac(plan.ledger) } : {}),
    };
    fs.writeFileSync(ledgerFile, JSON.stringify(envelope, null, 2) + "\n", { mode: 0o600 });
  }
  return { ...plan, status: "applied", wrote: plan.changed };
}
