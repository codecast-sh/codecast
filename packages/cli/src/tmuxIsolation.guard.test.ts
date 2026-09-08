// The tests' private tmux server must exist before daemon.ts is evaluated.
//
// daemon.ts snapshots process.env into SAFE_ENV at module load, and every tmux
// client it spawns is addressed through that snapshot. The real-tmux suites
// move this process onto a tmux server of its own; if the move lands after the
// snapshot, the daemon spends the whole run talking to the machine's default
// server while the harness panes sit on the private one. Nothing errors — the
// two halves simply never meet — so the suites fail far from the cause:
// injection reports the panes deaf, and the hibernation pass finds no live pane
// to park and returns 0 (ct-49907).
//
// A first-line `import "./test-helpers/isolatedTmuxServer.js"` in each suite
// cannot impose that order. It orders the imports inside its own file, but
// `bun test src/` loads every file into one process with one module registry,
// and ~74 unit-test files import daemon.js for reasons unrelated to tmux —
// whichever bun loads first decides. The bunfig.toml preload is what imposes
// the order. This is the test that speaks up when it stops holding.

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

// Read before anything else in this file, and this file imports NOTHING from
// test-helpers on purpose: importing isolatedTmuxServer.ts would set the
// variable itself, and the second test below would then pass either way.
const TMUX_TMPDIR_AT_LOAD = process.env.TMUX_TMPDIR;

const PRELOAD = "./src/test-helpers/isolatedTmuxServer.ts";
const BUNFIG = path.join(path.resolve(import.meta.dir, ".."), "bunfig.toml");

describe("the real-tmux suites run on a private tmux server", () => {
  test("bunfig.toml preloads it, so it is established before any test module", () => {
    const bunfig = fs.existsSync(BUNFIG) ? fs.readFileSync(BUNFIG, "utf8") : "";
    expect(
      bunfig,
      `packages/cli/bunfig.toml must preload ${PRELOAD}. Without it the private ` +
      `tmux server is established by whichever suite imports it first, which is ` +
      `too late for any daemon.js already loaded.`,
    ).toContain(PRELOAD);
  });

  test("and it had already run when this file was loaded", () => {
    expect(
      TMUX_TMPDIR_AT_LOAD,
      `TMUX_TMPDIR was unset when this file loaded, so the preload did not run. ` +
      `The daemon will address the machine's default tmux server and every ` +
      `real-tmux suite will fail without saying why. Check that bun test runs ` +
      `from packages/cli, where bunfig.toml lives.`,
    ).toBeTruthy();
  });
});
