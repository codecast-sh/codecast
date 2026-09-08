/**
 * `cast computer setup`, driven through commander with a fake Mac behind it
 * (ct-49790).
 *
 * The states are the whole specification: both grants missing, one missing,
 * both already there, a human who stops mid wait, and a run with nobody at the
 * keyboard. Each pins something a refactor could quietly undo — whether a
 * window opens, how many times it opens, and whether the command claims more
 * than it verified.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Command } from "commander";
import { registerComputerCommand } from "./cli.js";
import { ComputerError } from "./errors.js";
import { runComputerSetup, type ComputerSetupDeps } from "./setup.js";
import { GRANTED, NONE, setupHarness, type HarnessOptions } from "../test-helpers/computerSetupHarness.js";

let out: string[] = [];
let err: string[] = [];
const realLog = console.log;
const realError = console.error;

beforeEach(() => {
  out = [];
  err = [];
  console.log = (...args: unknown[]) => out.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => err.push(args.map(String).join(" "));
});

afterEach(() => {
  console.log = realLog;
  console.error = realError;
});

/** Same options as the harness, plus the Ctrl C handle a poll test needs: the
 *  handler only exists once the flow has registered it, which is inside the
 *  run these options configure. */
type RunOptions = Omit<HarnessOptions, "onWait"> & { onWait?: (n: number, cancel: () => void) => void };

async function run(argv: string[], opts: RunOptions) {
  let cancel = () => {};
  const harness = setupHarness({ ...opts, onWait: (n) => opts.onWait?.(n, cancel) });
  cancel = harness.cancel;
  // A holder rather than a bare let: the only writer is the exit callback, so
  // control flow analysis would otherwise narrow the variable to null and make
  // `toBe(1)` unwritable.
  const exited: { code: number | null } = { code: null };
  const program = new Command();
  program.exitOverride();
  registerComputerCommand(program, {
    permissions: harness.permissions,
    setup: harness.deps,
    exit: ((code: number) => {
      exited.code = code;
      throw new Error(`__exit ${code}`);
    }) as never,
  });
  try {
    await program.parseAsync(["node", "cast", "computer", ...argv]);
  } catch (e) {
    if (!(e instanceof Error) || !e.message.startsWith("__exit")) throw e;
  }
  return { harness, exit: exited.code, text: harness.lines.join("\n"), stderr: err.join("\n") };
}

describe("both grants missing", () => {
  test("explains each grant, asks once, then opens the panes in order", async () => {
    const r = await run(["setup"], {
      isTty: true,
      confirm: true,
      // Read 1 sees nothing granted; the human grants Accessibility, then
      // Screen Recording, one turn of the poll each.
      grants: [NONE, { accessibility: "granted", screenshots: "not-granted" }, GRANTED],
    });
    expect(r.harness.calls).toEqual([
      "materialize",
      "read",
      "confirm",
      "open:accessibility",
      "wait",
      "read",
      "open:screenshots",
      "wait",
      "read",
    ]);
    expect(r.text).toContain("Accessibility lets the helper read the window you name");
    expect(r.text).toContain("Screen Recording lets the helper take a picture");
    expect(r.text).toContain("Accessibility granted.");
    expect(r.text).toContain("Screen Recording granted.");
    expect(r.text).toContain("cast computer is ready.");
    expect(r.exit).toBe(null);
  });

  test("says why the helper holds the permission, not just what it allows", async () => {
    // The part a human cannot look up: an app they have never heard of is
    // asking, and the answer is that macOS attaches the grant to whoever asks.
    const r = await run(["setup"], { isTty: true, confirm: false, grants: [NONE] });
    expect(r.text).toContain("macOS attaches it to the program that asks");
    expect(r.text).toContain("a grant to your terminal would let anything you run there record your screen");
  });

  test("a human who declines gets no window and a way back", async () => {
    const r = await run(["setup"], { isTty: true, confirm: false, grants: [NONE] });
    expect(r.harness.calls).toEqual(["materialize", "read", "confirm"]);
    expect(r.text).toContain("Nothing was opened.");
    expect(r.text).toContain("Accessibility and Screen Recording");
  });
});

describe("one grant missing", () => {
  test("opens only the pane that is missing", async () => {
    const r = await run(["setup"], {
      isTty: true,
      confirm: true,
      grants: [{ accessibility: "granted", screenshots: "not-granted" }, GRANTED],
    });
    expect(r.harness.calls).toEqual(["materialize", "read", "confirm", "open:screenshots", "wait", "read"]);
    expect(r.text).not.toContain("Accessibility lets the helper");
    expect(r.text).toContain("Screen Recording lets the helper");
  });
});

describe("both grants present", () => {
  test("prints the state and exits without opening anything", async () => {
    const r = await run(["setup"], { isTty: true, confirm: true, grants: [GRANTED] });
    expect(r.harness.calls).toEqual(["materialize", "read"]);
    expect(r.text).toContain("accessibility=granted, screenshots=granted");
    expect(r.text).toContain("Both permissions were already granted.");
    expect(r.exit).toBe(null);
  });

  test("running it again costs one read and still opens nothing", async () => {
    const first = await run(["setup"], { isTty: true, confirm: true, grants: [GRANTED] });
    const second = await run(["setup"], { isTty: true, confirm: true, grants: [GRANTED] });
    expect(second.harness.calls).toEqual(first.harness.calls);
    expect(second.harness.calls.filter((c) => c.startsWith("open:"))).toEqual([]);
  });
});

describe("the human stops the wait", () => {
  test("Ctrl C ends the run at 0 with what is actually granted", async () => {
    const r = await run(["setup"], {
      isTty: true,
      confirm: true,
      grants: [NONE],
      onWait: (n, cancel) => {
        if (n === 1) cancel();
      },
    });
    expect(r.harness.calls).toEqual(["materialize", "read", "confirm", "open:accessibility", "wait"]);
    expect(r.text).toContain("Stopped.");
    expect(r.text).toContain("accessibility=not-granted");
    expect(r.text).toContain("Still missing: Accessibility and Screen Recording.");
    expect(r.exit).toBe(null);
  });

  test("a grant that landed before the stop is kept and reported", async () => {
    const r = await run(["setup"], {
      isTty: true,
      confirm: true,
      grants: [NONE, { accessibility: "granted", screenshots: "not-granted" }],
      onWait: (n, cancel) => {
        if (n === 2) cancel();
      },
    });
    expect(r.text).toContain("Accessibility granted.");
    expect(r.text).toContain("Still missing: Screen Recording.");
    expect(r.harness.calls.filter((c) => c.startsWith("open:"))).toEqual(["open:accessibility", "open:screenshots"]);
  });
});

describe("nobody at the keyboard", () => {
  test("no tty and no --yes refuses to raise, and says which two ways in exist", async () => {
    const r = await run(["setup"], { isTty: false, confirm: true, grants: [NONE] });
    expect(r.harness.calls).toEqual(["materialize", "read"]);
    expect(r.text).toContain("This is not a terminal");
    expect(r.text).toContain("pass --yes");
  });

  test("--yes opens without asking, which is the only thing it changes", async () => {
    const r = await run(["setup", "--yes"], { isTty: false, grants: [NONE, GRANTED] });
    expect(r.harness.calls).toEqual(["materialize", "read", "open:accessibility", "wait", "read"]);
    expect(r.text).toContain("cast computer is ready.");
  });

  test("--yes gives up rather than waiting forever for a human who is not there", async () => {
    // Ctrl C is the human's way out, and a script has no human. Without a
    // ceiling `--yes` on a build server would wait on a switch nobody will
    // ever click.
    const harness = setupHarness({ isTty: false, grants: [NONE] });
    await runComputerSetup({ yes: true }, { ...(harness.deps as ComputerSetupDeps), pollTimeoutMs: -1 });
    expect(harness.calls).toEqual(["materialize", "read", "open:accessibility"]);
    expect(harness.lines.join("\n")).toContain("Stopped waiting for Accessibility.");
  });
});

describe("a machine the helper cannot run on", () => {
  test("a materialize failure is the computer error shape, not a half-run flow", async () => {
    const r = await run(["setup"], {
      isTty: true,
      grants: [NONE],
      materialize: async () => {
        throw new ComputerError("unsupported_capability", "cast computer runs on macOS only");
      },
    });
    expect(r.exit).toBe(1);
    expect(r.stderr).toContain("cast computer runs on macOS only");
    expect(r.harness.calls).toEqual([]);
  });
});
