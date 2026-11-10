import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { isPidAlive } from "./pidAlive.js";

describe("isPidAlive", () => {
  test("this process is alive, and pid 1 (another user's) counts as alive", () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(1)).toBe(true);
  });

  test("a process that has exited is not", () => {
    const child = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    expect(child.pid).toBeGreaterThan(0);
    expect(isPidAlive(child.pid)).toBe(false);
  });

  test("values that are not a pid are not alive, and never signal a process group", () => {
    for (const pid of [0, -1, -process.pid, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31, null, undefined]) {
      expect(isPidAlive(pid as number)).toBe(false);
    }
  });
});
