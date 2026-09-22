/**
 * The change ledger of one mirror build: every path the build looked at
 * (files it read, files it skipped, directories it listed) with the lstat
 * signature it had. "Did anything change since the last build" is then a
 * stat pass over the ledger instead of a full collect, transform and scan.
 *
 * A directory's mtime moves when an entry is added, removed or renamed, and a
 * file's when its content is written, so the ledger catches the edits the
 * mirror exists to ship. An edit that preserves every mtime (a `touch -r`)
 * waits for the periodic verify tick, which always builds.
 */

import * as fs from "node:fs";

export type MirrorLedger = Map<string, string>;

/** Paths one build touched. Shared between the phases of a build and, within a tick, between hosts. */
export class TouchLedger {
  readonly paths = new Set<string>();
  note(abs: string): void { this.paths.add(abs); }
}

const STAT_CONCURRENCY = 64;

export function statSignature(stat: fs.Stats | null | undefined): string {
  if (!stat) return "missing";
  const base = `${stat.ino}:${stat.mode}:${Math.floor(stat.mtimeMs)}`;
  return stat.isDirectory() ? `d:${base}` : `f:${base}:${stat.size}`;
}

async function lstatOrNull(abs: string): Promise<fs.Stats | null> {
  return fs.promises.lstat(abs).catch((err: NodeJS.ErrnoException) => {
    if (["ENOENT", "ENOTDIR", "ELOOP", "EACCES", "EPERM"].includes(err.code ?? "")) return null;
    throw err;
  });
}

async function eachPath<T>(paths: Iterable<T>, fn: (item: T) => Promise<boolean | void>): Promise<boolean> {
  const queue = [...paths];
  let index = 0;
  let halted = false;
  const worker = async () => {
    while (!halted && index < queue.length) {
      const item = queue[index++]!;
      if (await fn(item) === false) halted = true;
    }
  };
  await Promise.all(Array.from({ length: Math.min(STAT_CONCURRENCY, queue.length) }, worker));
  return !halted;
}

/** The current signature of every path. */
export async function signLedger(paths: Iterable<string>): Promise<MirrorLedger> {
  const ledger: MirrorLedger = new Map();
  await eachPath(paths, async (abs) => { ledger.set(abs, statSignature(await lstatOrNull(abs))); });
  return ledger;
}

/** True when every path still has the signature the ledger recorded. Stops at the first difference. */
export async function ledgerUnchanged(ledger: MirrorLedger): Promise<boolean> {
  return eachPath(ledger, async ([abs, signature]) => statSignature(await lstatOrNull(abs)) === signature);
}
