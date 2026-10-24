import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { diskFullFailReason, diskFullHold, isDiskFullError, requeueAfterDiskFull } from "./diskFull";

const GB = 1024 ** 3;
// A Union line host's 290 GB disk with `free` GB left.
const host = (free: number) => ({ free: free * GB, size: 290 * GB });

// The Start failure on Union's full line hosts (2026-10-24).
const START_ERROR = "git worktree add -b codecast/agentwatch-ct-61002: error: unable to write file packages/app/src/index.ts";

let saved: string | undefined;
let dir: string;
beforeEach(() => {
  saved = process.env.CODECAST_DIR;
  process.env.CODECAST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "diskfull-home-"));
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "diskfull-repo-"));
});
afterEach(() => {
  fs.rmSync(process.env.CODECAST_DIR!, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
  if (saved === undefined) delete process.env.CODECAST_DIR;
  else process.env.CODECAST_DIR = saved;
});

describe("disk full", () => {
  test("a write failure counts only on a disk that is in fact full; ENOSPC words on a nearly full one", () => {
    expect(isDiskFullError(START_ERROR, host(0))).toBe(true);
    expect(isDiskFullError(START_ERROR, host(100))).toBe(false);
    expect(isDiskFullError("ENOSPC: no space left on device, write", host(20))).toBe(true);
    expect(isDiskFullError("ENOSPC: no space left on device, write", host(100))).toBe(false);
    expect(isDiskFullError("fatal: a branch named x already exists", host(0))).toBe(false);
    // 5% of a 3.6 TB laptop is 180 GB: a big disk is full by bytes, not by share.
    expect(isDiskFullError(START_ERROR, { free: 100 * GB, size: 3600 * GB })).toBe(false);
    expect(isDiskFullError(START_ERROR, null)).toBe(false);
  });

  test("a disk below the floor holds; a latched disk holds until it has the resume share free", () => {
    expect(diskFullHold(dir, host(1))).toBe("disk 100% full, 1.0 GB free");
    expect(diskFullHold(dir, host(100))).toBeNull();
    fs.writeFileSync(path.join(process.env.CODECAST_DIR!, "disk-full.json"), JSON.stringify({ at: 1, dir, error: START_ERROR }));
    expect(diskFullHold(dir, host(20))).toContain("disk 93% full, 20.0 GB free (a run failed on it: git worktree add");
    expect(diskFullHold(dir, host(40))).toBeNull();
    expect(fs.existsSync(path.join(process.env.CODECAST_DIR!, "disk-full.json"))).toBe(false);
    expect(diskFullHold(dir, host(20))).toBeNull();
  });

  test("a failure that is not the disk is left alone", () => {
    expect(diskFullFailReason(dir, "fatal: a branch named x already exists", "ct-1")).toBeNull();
    expect(fs.existsSync(path.join(process.env.CODECAST_DIR!, "disk-full.json"))).toBe(false);
  });

  test("the problem goes back to the line's queue through cast line requeue", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    expect(await requeueAfterDiskFull(async (route, body) => { calls.push([route, body]); return { task: "ct-1", queued: "ct-1 is back in the line's queue" }; }, "ct-1")).toEqual({ queued: true, text: "ct-1 is back in the line's queue" });
    expect(calls).toEqual([["/cli/line/requeue", { task: "ct-1" }]]);
    expect(await requeueAfterDiskFull(async () => null, "ct-1")).toEqual({ queued: false, text: "could not put ct-1 back in the queue" });
  });
});
