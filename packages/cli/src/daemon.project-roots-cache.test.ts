import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { computeLocalProjectRoots, invalidateLocalProjectRoots } from "./daemon.js";

// The heartbeat reads project roots every 30s. The list is cached on the
// mtimes of the conventional parents (and a TTL for paths only a started
// session names), so a beat costs a dozen stats instead of a readdir of
// every parent.
describe("computeLocalProjectRoots cache", () => {
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

  test("answers from the cache until a parent directory changes", async () => {
    fs.mkdirSync(path.join(home, "src", "a"), { recursive: true });
    const first = computeLocalProjectRoots();
    expect(first).toContain(path.join(home, "src", "a"));
    expect(computeLocalProjectRoots()).toBe(first);
    // A new project under a conventional parent moves that parent's mtime.
    await new Promise((r) => setTimeout(r, 20));
    fs.mkdirSync(path.join(home, "src", "b"));
    const next = computeLocalProjectRoots();
    expect(next).not.toBe(first);
    expect(next).toContain(path.join(home, "src", "b"));
    // An explicit invalidate (the config path allow list on a miss)
    // recomputes even though nothing moved.
    invalidateLocalProjectRoots();
    const fresh = computeLocalProjectRoots();
    expect(fresh).not.toBe(next);
    expect(fresh).toEqual(next);
  });
});
