import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readBoundTarget, sessionDaemonPid, writeBoundTarget } from "./pinnedTab.js";

const TARGET = "2BE86883491FD502B8D986C164423006";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pinned-tab-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("writeBoundTarget", () => {
  test("writes the shape tab_binding.rs reads: targetId, url, pinned", () => {
    writeBoundTarget("env-abc", TARGET, dir);
    const raw = JSON.parse(fs.readFileSync(path.join(dir, "env-abc.target"), "utf-8"));
    expect(raw).toEqual({ targetId: TARGET, url: "about:blank", pinned: true });
  });

  test("replaces a stale binding in place, leaving no temp file", () => {
    writeBoundTarget("env-abc", "OLD", dir);
    writeBoundTarget("env-abc", TARGET, dir);
    expect(readBoundTarget("env-abc", dir)).toBe(TARGET);
    expect(fs.readdirSync(dir)).toEqual(["env-abc.target"]);
  });
});

describe("readBoundTarget", () => {
  test("round-trips what writeBoundTarget wrote", () => {
    writeBoundTarget("env-abc", TARGET, dir);
    expect(readBoundTarget("env-abc", dir)).toBe(TARGET);
  });

  test("null for a missing, corrupt, or empty-id binding", () => {
    expect(readBoundTarget("nope", dir)).toBeNull();
    fs.writeFileSync(path.join(dir, "bad.target"), "not json");
    expect(readBoundTarget("bad", dir)).toBeNull();
    fs.writeFileSync(path.join(dir, "empty.target"), JSON.stringify({ targetId: "" }));
    expect(readBoundTarget("empty", dir)).toBeNull();
  });
});

describe("sessionDaemonPid", () => {
  test("a live pid is reported, a dead or missing one is null", () => {
    fs.writeFileSync(path.join(dir, "live.pid"), String(process.pid));
    expect(sessionDaemonPid("live", dir)).toBe(process.pid);
    // Pid 1 is launchd/init: alive but not ours — EPERM still counts as alive,
    // which is the isPidAlive contract, so use an impossible pid for "dead".
    fs.writeFileSync(path.join(dir, "dead.pid"), "999999999");
    expect(sessionDaemonPid("dead", dir)).toBeNull();
    expect(sessionDaemonPid("missing", dir)).toBeNull();
  });
});
