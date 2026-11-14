/**
 * Where a `cast computer` screenshot goes, and why it never goes into `--json`.
 *
 * A window capture is hundreds of kilobytes. As base64 inside the helper's
 * reply it crossed the socket, was parsed, decoded and written out again, and
 * inlined in a JSON result it would land in the agent's context whole. So the
 * helper writes the picture itself, into the directory named here, and the
 * reply carries only its path: 0600, inside a 0700 directory this uid owns,
 * swept after 24 hours by the CLI. Both helpers apply the same directory
 * checks (macOS ScreenshotFile.swift, Linux helper.py), because `$TMPDIR` is
 * world-writable on some systems and a symlink planted at the directory name
 * would redirect every capture to a path someone else chose.
 *
 * The `.last-cleanup` marker keeps the sweep off the hot path: an agent in a
 * tight observe/act loop would otherwise stat the whole directory on every
 * single command.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ComputerSnapshotResult } from "./types.js";

export const SCREENSHOT_TTL_MS = 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const CLEANUP_MARKER = ".last-cleanup";
const SUFFIX = "-screenshot.png";

export function screenshotDir(): string {
  return path.join(os.tmpdir(), "codecast-computer");
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

/** The `--json` shape: the helper's path, and when the sweep may remove it. */
export function rewriteScreenshotForJson<T extends ComputerSnapshotResult>(result: T, now = Date.now()): T {
  if (!result.screenshot?.path) return result;
  return { ...result, screenshot: { ...result.screenshot, expiresAt: new Date(now + SCREENSHOT_TTL_MS).toISOString() } };
}
