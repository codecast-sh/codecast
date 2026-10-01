import { describe, expect, test } from "bun:test";
import { checkRatchet } from "./index";
import { join } from "node:path";

// MAX LINES BASELINE. The one file size ratchet for every package.
//
// A file nobody can hold in their head is where the expensive bugs live:
// daemon.ts and index.ts run to tens of thousands of lines, and every guard
// test in this repo exists because something got lost inside one of them.
// Splitting them is its own work. What this stops is the tree getting worse
// while that work waits.
//
// The cap is 800 lines in every package, tests included. A file that is over
// it today is listed with a pinned size in 50-line steps, so a listed file may
// keep being edited but may not grow past its step; a file NOT on the list may
// not cross 800 at all. The steps exist because a dozen sessions edit these
// files in parallel and an exact pin would fail whichever branch merged second;
// a coarser step would hand every listed file room to grow by a hundred lines.
// A listed file that comes down by more than a tenth must be pruned, so a split
// keeps the ground it took instead of leaving room to grow back. Smaller
// shrinks are left alone because every prune is an edit to this shared list,
// and a session that trims a few dozen lines from a 3000-line file should not
// have to make one.
//
// Pins are measured on committed content plus the change that lands them, never
// on a working tree that holds other sessions' unfinished edits: a pin taken
// from someone's uncommitted growth hands them room they never earned, and one
// taken from their uncommitted split turns CI red if this list lands first.
// Measure in an archive of HEAD with your change copied in (git archive HEAD
// packages | tar -x -C <dir>, then run this test there), not in the shared
// checkout.
//
// The only sanctioned edit is downward. Split the file; then prune.
//
// One exception is on record. The baseline of 2026-09-30 (7ff3ea794) reset an
// unenforced ratchet: CI had never run packages/shared/ratchet before the
// test-shared job, and the old list was red on 59 entries, so 74 pins and PIN
// were raised to the committed sizes of that day. It is not a precedent for
// raising a pin. The largest absorptions (daemon.ts, ccAccounts.ts, schema.ts,
// conversations.ts, inboxStore.ts) are split work owed, not allowances.

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const ALLOWLIST = join(import.meta.dir, "max-lines-baseline.txt");

const CAP = 800;
const STEP = 50;

/** The pinned size of an oversized file: its line count rounded up to the
 *  next step. Zero for a file within the cap, which is not an offender. */
function pinnedSize(source: string): number {
  // Trailing newline dropped first, so this agrees with `wc -l`.
  const lines = source === "" ? 0 : source.replace(/\n$/, "").split("\n").length;
  return lines > CAP ? Math.ceil(lines / STEP) * STEP : 0;
}

/** How many files are over the cap today. May only fall. */
const PIN = 200;

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
  fix: `Split it. A file over ${CAP} lines is not allowed to be new, and a listed one may not grow past its ${STEP}-line step.`,
  pruneCommand: "cd packages/shared && RATCHET_WRITE=prune bun test ratchet/maxLines.ratchet.test.ts",
  minScanned: 1500,
  shrinkFloor: 0.9,
});

describe("max lines ratchet", () => {
  test("no new oversized file, no listed file grew past its pin, and no shrink left unpruned", () => {
    expect(result.problems).toEqual([]);
  }, 120_000);
});
