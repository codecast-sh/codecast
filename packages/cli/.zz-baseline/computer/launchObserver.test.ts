/**
 * A failed launch has to name itself.
 *
 * Before ct-49674 both helper launches were detached with `stdio: "ignore"`,
 * so a missing binary, a bundle macOS refuses to run and a crash on startup
 * all arrived as the same timeout seconds later. These tests pin the three
 * distinctions that matters: the child's exit, what the child said on its way
 * out, and an ENOENT that never produces a child at all.
 */

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { spawnObserved } from "./launchObserver.js";

let dir = "";
afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = "";
});

function scratch(): string {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cast-computer-observe-"));
  return dir;
}

/** Wait for the child to be finished, the way the poll loops do. */
async function settle(check: () => boolean, budgetMs = 5_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!check() && Date.now() < deadline) await sleep(20);
}

describe("spawnObserved", () => {
  test("a child that dies loudly is quoted, exit code and all", async () => {
    const log = path.join(scratch(), "helper.log");
    const observed = spawnObserved("/bin/sh", ["-c", 'echo "dyld: Library not loaded" >&2; exit 3'], log);
    await settle(() => observed.exitReason() !== null);
    expect(observed.exitReason()).toBe("exited with code 3");
    expect(observed.explain()).toContain("exited with code 3");
    expect(observed.explain()).toContain("dyld: Library not loaded");
    observed.cleanup();
  });

  test("a binary that is not there reports the launch failure, not a timeout", async () => {
    const log = path.join(scratch(), "helper.log");
    const observed = spawnObserved(path.join(dir, "no-such-helper"), ["--agent", "/tmp/x.sock"], log);
    await settle(() => observed.exitReason() !== null);
    expect(observed.exitReason()).toContain("could not be launched");
    expect(observed.explain()).toContain("ENOENT");
    observed.cleanup();
  });

  test("a child that is still running and silent says nothing at all", async () => {
    const log = path.join(scratch(), "helper.log");
    const observed = spawnObserved("/bin/sh", ["-c", "sleep 5"], log);
    expect(observed.exitReason()).toBeNull();
    expect(observed.explain()).toBe("");
    observed.cleanup();
    observed.child.kill("SIGKILL");
  });

  test("the tail is bounded and collapsed to one line", async () => {
    const log = path.join(scratch(), "helper.log");
    const observed = spawnObserved("/bin/sh", ["-c", 'i=0; while [ $i -lt 400 ]; do echo "line $i noise" >&2; i=$((i+1)); done; exit 1'], log);
    await settle(() => observed.exitReason() !== null);
    const said = observed.said();
    expect(said.length).toBeLessThanOrEqual(1_500);
    expect(said).not.toContain("\n");
    // The tail, not the head: the last thing a dying process says is the reason.
    expect(said).toContain("line 399 noise");
    observed.cleanup();
  });

  test("the log lands at 0600 inside the caller's private directory", async () => {
    const log = path.join(scratch(), "helper.log");
    const observed = spawnObserved("/bin/sh", ["-c", "echo hi >&2"], log);
    await settle(() => observed.exitReason() !== null);
    expect(fs.statSync(log).mode & 0o777).toBe(0o600);
    observed.cleanup();
  });
});
