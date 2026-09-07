/**
 * Where a `cast computer` screenshot goes, and why it never goes into `--json`.
 *
 * A window capture is hundreds of kilobytes; base64 makes it a third larger
 * again. Inlined in a JSON result it lands in the agent's context whole, costs
 * a fortune in tokens, and is unreadable to the human reading the transcript.
 * So `--json` gets a path and the bytes go to a file: 0600, inside a 0700
 * directory this uid owns, swept after 24 hours.
 *
 * The directory checks are not ceremony. `$TMPDIR` is world-writable on some
 * systems, and a symlink planted at the directory name would redirect every
 * screenshot an agent takes to a path someone else chose. A violation refuses
 * to write rather than following the link.
 *
 * The `.last-cleanup` marker keeps the sweep off the hot path: an agent in a
 * tight observe/act loop would otherwise stat the whole directory on every
 * single command.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ComputerScreenshotData, ComputerSnapshotResult } from "./types.js";

export const SCREENSHOT_TTL_MS = 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const CLEANUP_MARKER = ".last-cleanup";
const SUFFIX = "-screenshot.png";

export function screenshotDir(): string {
  return path.join(os.tmpdir(), "codecast-computer");
}

/**
 * The screenshot directory, created 0700 and proven to be ours.
 *
 * `lstat`, not `stat`: the point is to reject a symlink standing where the
 * directory should be, and `stat` would follow it and report the target.
 */
export function ensureScreenshotDir(dir = screenshotDir()): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  if (!st.isDirectory()) throw new Error(`${dir} is not a directory`);
  const uid = process.getuid?.();
  if (typeof uid === "number" && st.uid !== uid) throw new Error(`${dir} is owned by uid ${st.uid}, not ${uid}`);
  // mkdir's mode is masked by umask, so set it explicitly afterwards.
  fs.chmodSync(dir, 0o700);
  return dir;
}

/** A snapshot id is helper-supplied, so it is sanitized before it becomes a
 *  file name — nothing may traverse out of the directory. */
export function screenshotFileName(requestId: string): string {
  const safe = requestId.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^\.+/, "").slice(0, 96);
  return `${safe || "snapshot"}${SUFFIX}`;
}

/** Delete captures older than the TTL, at most once an hour. */
export function sweepScreenshots(dir = screenshotDir(), now = Date.now()): void {
  const marker = path.join(dir, CLEANUP_MARKER);
  try {
    if (now - fs.statSync(marker).mtimeMs < CLEANUP_INTERVAL_MS) return;
  } catch {
    /* no marker yet: this is the first sweep */
  }
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(SUFFIX)) continue;
      const file = path.join(dir, name);
      try {
        if (now - fs.statSync(file).mtimeMs > SCREENSHOT_TTL_MS) fs.rmSync(file, { force: true });
      } catch {
        /* raced with another agent's sweep */
      }
    }
    fs.writeFileSync(marker, new Date(now).toISOString(), { mode: 0o600 });
  } catch {
    /* a sweep that cannot run costs disk, never a command */
  }
}

/** Write the capture and return what replaces `data` in the JSON result. */
export function writeScreenshotFile(
  requestId: string,
  data: string,
  opts: { dir?: string; now?: number } = {},
): { path: string; expiresAt: string } {
  const dir = ensureScreenshotDir(opts.dir ?? screenshotDir());
  const now = opts.now ?? Date.now();
  sweepScreenshots(dir, now);
  const file = path.join(dir, screenshotFileName(requestId));
  fs.writeFileSync(file, Buffer.from(data, "base64"), { mode: 0o600 });
  // writeFileSync's mode applies only when it creates the file; an existing one
  // (same snapshot id, second command) keeps whatever mode it had.
  fs.chmodSync(file, 0o600);
  return { path: file, expiresAt: new Date(now + SCREENSHOT_TTL_MS).toISOString() };
}

/**
 * The `--json` rewrite: base64 out, path in.
 *
 * A write that fails does not fail the command — the tree is still the answer —
 * but the bytes are dropped either way and the status says the pixels are not
 * available. Keeping the base64 as a fallback would defeat the rule this
 * module exists to enforce, and an agent that reads `screenshot_failed` has a
 * recovery (`--no-screenshot`, or grant Screen Recording) either way.
 */
export function rewriteScreenshotForJson<T extends ComputerSnapshotResult>(result: T, opts: { dir?: string; now?: number } = {}): T {
  const shot = result.screenshot;
  if (!shot?.data) return result;
  const { data: _dropped, ...rest } = shot;
  try {
    const written = writeScreenshotFile(result.snapshot?.id ?? "snapshot", shot.data, opts);
    const screenshot: ComputerScreenshotData = { ...rest, path: written.path, dataOmitted: true, expiresAt: written.expiresAt };
    return { ...result, screenshot };
  } catch (err) {
    const message = `the capture could not be written to ${opts.dir ?? screenshotDir()}: ${err instanceof Error ? err.message : String(err)}`;
    return {
      ...result,
      screenshot: { ...rest, dataOmitted: true },
      screenshotStatus: { state: "failed", code: "screenshot_failed", message },
    };
  }
}
