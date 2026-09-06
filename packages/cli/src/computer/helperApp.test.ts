/**
 * The fixed path, and the crash window the fixed path costs.
 *
 * Replacing a bundle in place is two renames, and between them the fixed path
 * holds nothing. A kill there — an update during a reboot, a `timeout` around
 * a command, an OOM — would leave the user with no helper at all and a stamp
 * claiming one is installed. `repairHalfSwap` closes that window, and these
 * tests drive the REAL swap (via its `betweenRenames` seam) rather than a
 * re-creation of the state it leaves behind.
 */

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  HELPER_APP_BASENAME,
  computerHome,
  helperAppPath,
  helperExecutablePath,
  readInstallStamp,
  repairHalfSwap,
  sweepOldBundles,
  swapIntoPlace,
} from "./helperApp.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

function isolatedHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cast-helperapp-test-"));
  const prev = process.env.CODECAST_DIR;
  process.env.CODECAST_DIR = dir;
  cleanups.push(() => {
    if (prev === undefined) delete process.env.CODECAST_DIR;
    else process.env.CODECAST_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  fs.mkdirSync(computerHome(), { recursive: true, mode: 0o700 });
  return dir;
}

/** A bundle shaped enough for `looksLikeBundle`, with an identifiable body. */
function makeBundle(at: string, body: string): string {
  fs.mkdirSync(path.join(at, "Contents", "MacOS"), { recursive: true });
  fs.writeFileSync(helperExecutablePath(at), body);
  return at;
}

function stage(body: string): { stagingDir: string; stagedApp: string } {
  const stagingDir = path.join(computerHome(), `.staging-${body}`);
  fs.mkdirSync(stagingDir, { recursive: true, mode: 0o700 });
  return { stagingDir, stagedApp: makeBundle(path.join(stagingDir, HELPER_APP_BASENAME), body) };
}

function liveBody(): string | null {
  try {
    return fs.readFileSync(helperExecutablePath(), "utf-8");
  } catch {
    return null;
  }
}

describe("the fixed helper path", () => {
  test("never carries a version, a hash or anything else that moves", () => {
    const home = isolatedHome();
    expect(helperAppPath()).toBe(path.join(home, "computer", "codecast computer.app"));
    // A path component that changes between releases is what makes macOS read
    // every update as a brand new app and re-prompt for both grants.
    expect(path.relative(home, helperAppPath())).toBe(path.join("computer", HELPER_APP_BASENAME));
  });
});

describe("swapIntoPlace", () => {
  test("publishes the staged bundle, stamps it, and clears the journal", () => {
    isolatedHome();
    makeBundle(helperAppPath(), "old-release");
    const { stagingDir, stagedApp } = stage("new-release");

    swapIntoPlace(stagedApp, stagingDir, { sha256: "abc123", version: "1.2.3" });

    expect(liveBody()).toBe("new-release");
    expect(readInstallStamp()).toMatchObject({ sha256: "abc123", version: "1.2.3" });
    expect(fs.existsSync(path.join(computerHome(), "swap.json"))).toBe(false);
    // The displaced bundle is kept, not deleted: a helper from the previous
    // release may still be running off those bytes.
    const kept = fs.readdirSync(path.join(computerHome(), "old"));
    expect(kept).toHaveLength(1);
    expect(fs.readFileSync(helperExecutablePath(path.join(computerHome(), "old", kept[0])), "utf-8")).toBe("old-release");
  });
});

describe("repairHalfSwap", () => {
  test("does nothing when no swap was in flight", () => {
    isolatedHome();
    makeBundle(helperAppPath(), "installed");
    expect(repairHalfSwap()).toBe("none");
    expect(liveBody()).toBe("installed");
  });

  test("finishes a swap killed between the two renames", () => {
    isolatedHome();
    makeBundle(helperAppPath(), "old-release");
    const { stagingDir, stagedApp } = stage("new-release");
    expect(() => swapIntoPlace(stagedApp, stagingDir, { sha256: "abc", betweenRenames: killHere })).toThrow("killed");
    // The state a crash actually leaves: nothing at the fixed path.
    expect(fs.existsSync(helperAppPath())).toBe(false);

    expect(repairHalfSwap()).toBe("completed");
    // Forward, because the staged copy is the one that already passed
    // signature verification.
    expect(liveBody()).toBe("new-release");
    // No stamp is claimed for a bundle this process never hashed.
    expect(readInstallStamp()).toBeNull();
    expect(fs.existsSync(stagingDir)).toBe(false);
  });

  test("puts the previous bundle back when the staged copy did not survive", () => {
    isolatedHome();
    makeBundle(helperAppPath(), "old-release");
    const { stagingDir, stagedApp } = stage("new-release");
    expect(() =>
      swapIntoPlace(stagedApp, stagingDir, {
        sha256: "abc",
        // A crash whose cleanup ran, or a staging directory swept by the OS.
        betweenRenames: () => {
          fs.rmSync(stagingDir, { recursive: true, force: true });
          killHere();
        },
      }),
    ).toThrow("killed");

    expect(repairHalfSwap()).toBe("rolled-back");
    expect(liveBody()).toBe("old-release");
    expect(readInstallStamp()).toBeNull();
  });

  test("drops the journal when the second rename had already landed", () => {
    isolatedHome();
    const { stagingDir, stagedApp } = stage("new-release");
    swapIntoPlace(stagedApp, stagingDir, { sha256: "abc" });
    // A kill after the rename but before the journal was removed.
    fs.writeFileSync(path.join(computerHome(), "swap.json"), JSON.stringify({ stagingDir, stagedApp, oldApp: "/nowhere" }));

    expect(repairHalfSwap()).toBe("completed");
    expect(liveBody()).toBe("new-release");
    expect(fs.existsSync(path.join(computerHome(), "swap.json"))).toBe(false);
  });

  test("clears the stamp when neither half is left, so the next run reinstalls", () => {
    isolatedHome();
    fs.writeFileSync(path.join(computerHome(), "installed.json"), JSON.stringify({ sha256: "abc", version: "1", installedAt: 1 }));
    fs.writeFileSync(path.join(computerHome(), "swap.json"), JSON.stringify({ stagingDir: "/nowhere", stagedApp: "/nowhere/a.app", oldApp: "/nowhere/b.app" }));

    expect(repairHalfSwap()).toBe("abandoned");
    // A stamp claiming an install that is not there would make the next
    // materialization a no-op, leaving the feature permanently broken.
    expect(readInstallStamp()).toBeNull();
  });
});

describe("sweepOldBundles", () => {
  test("removes a displaced bundle once no helper is running", () => {
    isolatedHome();
    const orphan = path.join(computerHome(), "old", "orphaned-bundle-for-test");
    makeBundle(orphan, "old-release");
    sweepOldBundles(() => false);
    expect(fs.existsSync(orphan)).toBe(false);
  });

  test("keeps every bundle while a helper could still be running from one", () => {
    isolatedHome();
    const orphan = path.join(computerHome(), "old", "orphaned-bundle-for-test");
    makeBundle(orphan, "old-release");
    // Fail open: the liveness read cannot say WHICH bundle a helper runs from,
    // and unlinking a running executable's bytes is a page-in fault. A stale
    // directory on disk is the cheaper mistake.
    sweepOldBundles(() => true);
    expect(fs.existsSync(orphan)).toBe(true);
  });
});

function killHere(): never {
  throw new Error("killed");
}
