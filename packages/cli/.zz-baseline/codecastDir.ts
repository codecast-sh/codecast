/**
 * The one place that answers "where does the CLI keep its state?".
 *
 * Every reader and writer of CLI state used to spell this out for itself, and
 * about half of those spellings ignored CODECAST_DIR — so a test that redirected
 * the variable still wrote the human's real files. positionTracker was one of
 * them: running the CLI suite rewrote ~/.codecast/positions.json and could drop
 * a position the live daemon had just written (ct-49597, same class as the
 * browser pairing loss in ct-49576).
 *
 * Import this instead of joining a home directory with ".codecast";
 * codecastDir.guard.test.ts fails any source file that builds the path itself.
 *
 * Keep this module dependency-free: the claude wrapper and the stable-context
 * hook import it on their hot path and must stay off index.ts's import graph.
 */

import * as os from "node:os";
import * as path from "node:path";
import { defaultConfigDir } from "./config/configDir.js";

/**
 * $HOME first: bun's os.homedir() caches at startup and ignores later env
 * changes, which breaks tests that sandbox the home directory.
 */
export function homeDir(): string {
  return process.env.HOME || os.homedir();
}

/** The CLI state directory — CODECAST_DIR when set, else ~/.codecast. */
export function codecastDir(): string {
  return defaultConfigDir();
}

/** A path inside the CLI state directory, e.g. codecastPath("positions.json"). */
export function codecastPath(...segments: string[]): string {
  return path.join(codecastDir(), ...segments);
}
