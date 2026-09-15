import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { computeLocalProjectRoots, invalidateLocalProjectRoots, refreshLocalProjectRoots } from "./daemon.js";

// The heartbeat reads project roots every 30s from a snapshot that a
// background walk refreshes. The read itself never touches the filesystem:
// a dozen synchronous stats held the event loop for 6 to 11 seconds under
// load (2026-09-15) and, running inside the heartbeat body after its abort
// timer had started, made every beat time out.
describe("computeLocalProjectRoots snapshot", () => {
  const realHome = process.env.HOME;
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "cc-roots-"));
    process.env.HOME = home;
    invalidateLocalProjectRoots();
  });
  afterEach(() => {
    process.env.HOME = realHome;
    invalidateLocalProjectRoots();
    fs.rmSync(home, { recursive: true, force: true });
  });

  test("answers from the snapshot; a refresh picks up a new project", async () => {
    fs.mkdirSync(path.join(home, "src", "a"), { recursive: true });
    await refreshLocalProjectRoots();
    const first = computeLocalProjectRoots();
    expect(first).toContain(path.join(home, "src", "a"));
    // A repeat read is the same array: no walk, no stat.
    expect(computeLocalProjectRoots()).toBe(first);
    fs.mkdirSync(path.join(home, "src", "b"));
    // The snapshot is stale-tolerant until it is refreshed.
    expect(computeLocalProjectRoots()).toBe(first);
    invalidateLocalProjectRoots();
    await refreshLocalProjectRoots();
    const next = computeLocalProjectRoots();
    expect(next).not.toBe(first);
    expect(next).toContain(path.join(home, "src", "b"));
  });

  test("the read is synchronous and stat-free even before the first refresh", () => {
    fs.mkdirSync(path.join(home, "src", "a"), { recursive: true });
    const statSpy = spyOn(fs, "statSync");
    const readdirSpy = spyOn(fs, "readdirSync");
    try {
      computeLocalProjectRoots();
      expect(statSpy).not.toHaveBeenCalled();
      expect(readdirSpy).not.toHaveBeenCalled();
    } finally {
      statSpy.mockRestore();
      readdirSpy.mockRestore();
    }
  });
});
