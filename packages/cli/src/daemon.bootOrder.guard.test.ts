// The loopback server must listen at the very front of boot.
//
// It used to listen last, after the forced update network check, the warm
// restart tmux scan and the skills sweep. Everything before the listen is boot
// blackout: the terminal panel, the vault, the browser watch and the health
// probe are unreachable, and every hook status falls back to a polled file.
// Measured blackouts ran 5 to 30 seconds on a loaded laptop, and 1168 seconds
// once (2026-08-31).
//
// So the order is an invariant, not a preference, and a source guard is the
// cheapest way to hold it. Put a network call, a tmux scan or a tree walk back
// in front of the listen and this fails by name. The loop budget guard
// (daemon.loopBudget.guard.test.ts) covers what may run inside that window;
// this one covers where the window ends.

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { codeLines, sliceBetween } from "./test-helpers/sourceRegion.js";

const SRC = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(SRC, "daemon.ts"), "utf8");
const MAIN = "async function main(";
const mainAt = src.indexOf(MAIN);

// In boot order. Each must appear inside main() after the one before it.
const SEQUENCE: Array<{ anchor: string; why: string }> = [
  { anchor: 'logLifecycle("daemon_start"', why: "boot starts here" },
  { anchor: "hookServer = startHookServer(", why: "the loopback server listens" },
  { anchor: "await checkForForcedUpdate(", why: "the first network call" },
  { anchor: "readAvailableSkills()", why: "the boot skills sweep" },
  { anchor: "setHookStatusSink(", why: "the hook status handler registers" },
];

describe("daemon boot order", () => {
  test("the listener comes up before the network check, the skills sweep and the status handler", () => {
    expect(mainAt).toBeGreaterThan(0);
    let at = mainAt;
    const found: Array<{ anchor: string; index: number }> = [];
    for (const { anchor, why } of SEQUENCE) {
      const i = src.indexOf(anchor, at);
      expect(i, `${anchor} (${why}) not found in main() after the previous step`).toBeGreaterThan(-1);
      found.push({ anchor, index: i });
      at = i + anchor.length;
    }
    // Redundant with the walk above, and it is the assertion that reads.
    expect(found.map((f) => f.anchor)).toEqual(SEQUENCE.map((s) => s.anchor));
  });

  test("the window before the listen stays short", () => {
    const slice = sliceBetween(src, 'logLifecycle("daemon_start"', "hookServer = startHookServer(", mainAt);
    const lines = codeLines(slice.text).length;
    expect(lines, `${lines} code lines run before the loopback server listens`).toBeLessThan(80);
  });
});
