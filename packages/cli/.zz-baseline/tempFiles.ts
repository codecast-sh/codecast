/**
 * Where the CLI puts the scratch files it hands back to an agent.
 *
 * A screenshot used to land in `os.tmpdir()/cast-shot-<ts>.png` at the default
 * umask, and nothing ever deleted it. On a shared machine that means every
 * other account can read whatever the page was showing — the human's mail,
 * their dashboards, a signed-in admin panel — and the pile grows for as long
 * as the machine lives. Shots go into a 0700 directory under the CLI state
 * directory, each file at 0600, and a write sweeps entries older than a day.
 *
 * The sweep hides behind a marker file: agents take screenshots in loops, and
 * a directory scan per shot would be a synchronous cost on the hot path.
 *
 * Shared on purpose — `cast browser shot` and `cast computer` write the same
 * kind of file and must not disagree about who can read it (ct-49556).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { codecastDir } from "./codecastDir.js";

/** How long a scratch file survives before a sweep removes it. */
export const TEMP_TTL_MS = 24 * 60 * 60 * 1000;

/** How often a sweep is worth running, however many files are written. */
export const TEMP_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/** The marker whose mtime says when this directory was last swept. */
export const TEMP_SWEEP_MARKER = ".last-sweep";

/** Mode for a scratch file: readable by its owner and nobody else. */
export const TEMP_FILE_MODE = 0o600;

/**
 * The 0700 directory for one kind of scratch file ("shots", "computer", …),
 * created if it is missing and verified to be ours before anything is written
 * into it. Throws when the path is a symlink or belongs to another user —
 * both are how a shared /tmp turns a screenshot into somebody else's file.
 */
export function agentTempDir(kind: string): string {
  const dir = path.join(codecastDir(), "tmp", kind);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  if (!st.isDirectory()) throw new Error(`the scratch path ${dir} is not a directory`);
  if (process.getuid && st.uid !== process.getuid()) {
    throw new Error(`the scratch directory ${dir} belongs to another user`);
  }
  fs.chmodSync(dir, 0o700);
  return dir;
}

/**
 * Delete scratch files older than the TTL, at most once per interval.
 *
 * Returns how many files went, so a caller (or a test) can tell a real sweep
 * from a skipped one — a skip returns 0 the same way an empty directory does,
 * which is why the marker is checked separately in tests.
 */
export function sweepTempDir(
  dir: string,
  o: { now?: number; ttlMs?: number; intervalMs?: number } = {},
): number {
  const now = o.now ?? Date.now();
  const ttl = o.ttlMs ?? TEMP_TTL_MS;
  const marker = path.join(dir, TEMP_SWEEP_MARKER);
  try {
    if (fs.statSync(marker).mtimeMs > now - (o.intervalMs ?? TEMP_SWEEP_INTERVAL_MS)) return 0;
  } catch {
    // No marker, or one we cannot read: this process should sweep.
  }

  let removed = 0;
  const cutoff = now - ttl;
  for (const entry of fs.readdirSync(dir)) {
    if (entry === TEMP_SWEEP_MARKER) continue;
    const file = path.join(dir, entry);
    try {
      if (fs.statSync(file).mtimeMs >= cutoff) continue;
      fs.rmSync(file, { force: true, recursive: true });
      removed++;
    } catch {
      // Best effort: a file another process just took is not our problem, and
      // a screenshot must never fail because the cleanup raced.
    }
  }
  try {
    fs.writeFileSync(marker, `${now}\n`, { mode: TEMP_FILE_MODE });
    fs.utimesSync(marker, new Date(now), new Date(now));
  } catch {
    // Best effort: a marker we could not write only costs an extra scan.
  }
  return removed;
}

/**
 * A path for a new scratch file of this kind, with the directory prepared and
 * swept. `stem` names what the file is; the extension comes with it.
 */
export function agentTempPath(kind: string, stem: string): string {
  const dir = agentTempDir(kind);
  sweepTempDir(dir);
  return path.join(dir, stem.replace(/[^A-Za-z0-9._-]/g, "_"));
}

/**
 * Make a file owner-only. Used after a helper we do not control writes it —
 * the browser engine writes its own screenshots, so the mode has to be set
 * afterwards rather than at creation.
 */
export function secureTempFile(file: string): void {
  try {
    fs.chmodSync(file, TEMP_FILE_MODE);
  } catch {
    // Best effort: a file on a filesystem without modes still gets written.
  }
}
