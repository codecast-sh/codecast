import { describe, expect, test } from "bun:test";
import { checkRatchet } from "./index";
import { join } from "node:path";

// MAX LINES BASELINE.
//
// A file nobody can hold in their head is where the expensive bugs live:
// daemon.ts is 25k lines and index.ts 18k, and every guard test in this repo
// exists because something got lost inside one of them. Splitting them is its
// own work. What this stops is the tree getting worse while that work waits.
//
// The cap is 800 lines. A file that is over it today is listed with a pinned
// size in 100-line steps, so a listed file may keep being edited but may not
// grow another step; a file NOT on the list may not cross 800 at all. The
// steps exist because a dozen sessions edit these files in parallel and an
// exact pin would fail whichever branch merged second.
//
// The only sanctioned edit is downward. Split the file; then prune.

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const ALLOWLIST = join(import.meta.dir, "max-lines-baseline.txt");

const CAP = 800;
const STEP = 100;

/** The pinned size of an oversized file: its line count rounded up to the
 *  next 100. Zero for a file within the cap, which is not an offender. */
function pinnedSize(source: string): number {
  // Trailing newline dropped first, so this agrees with `wc -l`.
  const lines = source === "" ? 0 : source.replace(/\n$/, "").split("\n").length;
  return lines > CAP ? Math.ceil(lines / STEP) * STEP : 0;
}

/** How many files are over the cap today. May only fall. */
const PIN = 128;

const result = checkRatchet({
  name: "max lines",
  root: REPO_ROOT,
  dirs: ["packages"],
  // ios/ and android/ are Expo prebuild output, not ours to split. The Convex
  // codegen under _generated is ignored by the walker already.
  ignoreDirs: ["ios", "android"],
  count: pinnedSize,
  allowlist: ALLOWLIST,
  pin: PIN,
  fix: `Split it. A file over ${CAP} lines is not allowed to be new, and a listed one may not grow another ${STEP} lines.`,
  pruneCommand: "cd packages/shared && RATCHET_WRITE=prune bun test ratchet/maxLines.ratchet.test.ts",
  minScanned: 1500,
});

describe("max lines ratchet", () => {
  test("no new oversized file, and no listed file grew past its pin", () => {
    expect(result.problems).toEqual([]);
  }, 120_000);
});
