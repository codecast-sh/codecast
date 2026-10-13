// The two ways `kill(pid, 0)` can throw mean opposite things, and only one of
// them means the process is gone.

import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { pidGone, stillRunning } from "./processLiveness.js";

test("a live process this user cannot signal reads as running, not as gone", async () => {
  // pid 1 exists on every machine the suite runs on, and `kill(1, 0)` from an
  // ordinary user throws EPERM — the error that says the process IS there.
  // Reading that as absence is the one wrong answer a teardown check can give:
  // it would report a leaked process reaped. (As root the call simply
  // succeeds, so this holds in a container too.)
  expect(await pidGone(1)).toBe(false);
  expect(await stillRunning([1])).toEqual([1]);
});

test("a process that has exited and been reaped reads as gone", async () => {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid!;
  await new Promise<void>((resolve) => child.on("exit", () => resolve()));
  // The exit event fires when node has reaped it, so there is no zombie left
  // to hold the slot and ESRCH is the honest answer.
  expect(await pidGone(pid)).toBe(true);
});

test("order is preserved and the gone ones are dropped", async () => {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const gone = child.pid!;
  await new Promise<void>((resolve) => child.on("exit", () => resolve()));
  expect(await stillRunning([1, gone, process.pid])).toEqual([1, process.pid]);
});
