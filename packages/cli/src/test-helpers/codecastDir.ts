/**
 * Keep a test's state writes out of the human's ~/.codecast.
 *
 * Every reader and writer of CLI state resolves its directory as
 * `process.env.CODECAST_DIR || ~/.codecast`, so a test that does not set that
 * variable writes the real files. That is not a stale fixture, it is damage:
 * on 2026-09-06 one run of the browser suite replaced
 * ~/.codecast/browser/bridge.json with a test token and unpaired the human's
 * Chrome extension for good, because the extension still held the old token
 * (ct-49576).
 *
 * `isolateCodecastDir` points CODECAST_DIR at a fresh temp directory and hands
 * back the undo. A test file that already redirected keeps its own directory —
 * the call is then a no-op, so a helper can protect itself without stealing the
 * directory the test writes its fixtures into.
 */

import { afterEach, beforeEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface IsolatedCodecastDir {
  /** The directory CODECAST_DIR points at for the caller's lifetime. */
  dir: string;
  /** Restore the previous CODECAST_DIR and remove the temp directory. */
  restore(): void;
}

/** The directory the CLI uses when CODECAST_DIR is unset: the human's real state. */
export function realCodecastDir(): string {
  return path.join(os.homedir(), ".codecast");
}

export function isolateCodecastDir(prefix = "cast-test-home-"): IsolatedCodecastDir {
  const previous = process.env.CODECAST_DIR;
  if (previous && path.resolve(previous) !== realCodecastDir()) {
    return { dir: previous, restore: () => {} };
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.CODECAST_DIR = dir;
  return {
    dir,
    restore: () => {
      if (previous === undefined) delete process.env.CODECAST_DIR;
      else process.env.CODECAST_DIR = previous;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Point CODECAST_DIR at `dir`, for a harness that builds one world per test inside its own sandbox. */
export function pointCodecastDir(dir: string): void {
  process.env.CODECAST_DIR = dir;
}

/**
 * Isolate every test in the calling file: a fresh CODECAST_DIR before each, the
 * undo after. For files whose code writes CLI state on every test, such as a
 * workflow run's pid file (one runner per run id), which parallel test files
 * would otherwise fight over in a shared directory.
 */
export function isolateCodecastDirEachTest(prefix?: string): void {
  let state: IsolatedCodecastDir | undefined;
  beforeEach(() => { state = isolateCodecastDir(prefix); });
  afterEach(() => state?.restore());
}
