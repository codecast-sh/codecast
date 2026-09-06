/**
 * Where the helper bundle comes from, and the crash window the fixed path costs.
 *
 * Replacing a bundle in place is two renames, and between them the fixed path
 * holds nothing. A kill there — an update during a reboot, a `timeout` around
 * a command, an OOM — would leave the user with no helper at all and a stamp
 * claiming one is installed. `repairHalfSwap` closes that window, and these
 * tests drive the REAL swap (via its `betweenRenames` seam) rather than a
 * re-creation of the state it leaves behind.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

/**
 * The bytes the build embeds, under the test's control.
 *
 * `helper.tar` is an empty tracked file in a source checkout, so the real
 * reader answers null here and only the "not built into this CLI" branch could
 * ever run. Mocking the reader is what lets one test drive the whole
 * extract, verify, swap and stamp chain from a real tar.
 */
let payload: Buffer | null = null;
mock.module("./helperPayload.js", () => ({ computerHelperTar: () => payload }));

const {
  HELPER_APP_BASENAME,
  computerHome,
  helperAppPath,
  helperAvailability,
  helperExecutablePath,
  materializeHelperApp,
  readInstallStamp,
  repairHalfSwap,
  sweepOldBundles,
  swapIntoPlace,
} = await import("./helperApp.js");

const cleanups: Array<() => void> = [];
afterEach(() => {
  payload = null;
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

/** A bundle macOS will verify: a real Mach-O executable, an Info.plist, and an
 *  ad-hoc signature. Ad-hoc is what a from-source build produces, and what the
 *  helper accepts while refusing an invalid signature. */
function signedBundle(at: string): string {
  fs.mkdirSync(path.join(at, "Contents", "MacOS"), { recursive: true });
  fs.copyFileSync("/bin/echo", helperExecutablePath(at));
  fs.chmodSync(helperExecutablePath(at), 0o755);
  fs.writeFileSync(
    path.join(at, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>sh.codecast.computer</string>
  <key>CFBundleExecutable</key><string>codecast-computer</string>
</dict></plist>
`,
  );
  const sign = spawnSync("/usr/bin/codesign", ["--force", "--sign", "-", "--identifier", "sh.codecast.computer", at], { encoding: "utf8" });
  if (sign.status !== 0) throw new Error(`codesign failed: ${sign.stderr}`);
  return at;
}

/** Exactly the tar `scripts/build-with-native.ts` writes: the `.app` directory
 *  at the root, by its basename. */
function tarOf(app: string): Buffer {
  const output = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cast-helper-tar-")), "helper.tar");
  const tar = spawnSync("/usr/bin/tar", ["-cf", output, "-C", path.dirname(app), path.basename(app)], { encoding: "utf8" });
  if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr}`);
  const bytes = fs.readFileSync(output);
  fs.rmSync(path.dirname(output), { recursive: true, force: true });
  return bytes;
}

/**
 * The payload arrives as a bundled file asset, not as a `--define`.
 *
 * The design asked for base64 on the `bun build` argv, the way the browser icon
 * helper rides one. That route is closed: the app bundle tar is about 2.6 MB
 * once base64-encoded and the whole argv must fit in ARG_MAX, so `bun build`
 * dies with E2BIG (ct-49519). So `helperPayload.ts` embeds the tar as a file
 * asset and this module reads it from there.
 */
describe("the embedded payload", () => {
  test("a build without the helper says so instead of half-installing one", () => {
    isolatedHome();
    payload = null;
    expect(helperAvailability().embedded).toBe(false);
    // Off macOS `materializeHelperApp` stops one step earlier, on
    // `unsupported_capability`, so only the availability half is portable.
    if (process.platform !== "darwin") return;
    expect(() => materializeHelperApp()).toThrow("not built into this CLI");
    // Nothing is created on the way to that error: a Linux build and a Mac
    // built without swift both leave the fixed path untouched.
    expect(fs.existsSync(helperAppPath())).toBe(false);
    expect(readInstallStamp()).toBeNull();
  });

  test.skipIf(process.platform !== "darwin")("a real tar extracts, verifies, swaps into the fixed path and stamps", () => {
    isolatedHome();
    const source = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cast-helper-src-")), HELPER_APP_BASENAME);
    payload = tarOf(signedBundle(source));
    cleanups.push(() => fs.rmSync(path.dirname(source), { recursive: true, force: true }));

    expect(helperAvailability().embedded).toBe(true);
    const first = materializeHelperApp({ version: "9.9.9" });
    expect(first.installed).toBe(true);
    expect(first.appPath).toBe(helperAppPath());
    expect(fs.statSync(first.executablePath).isFile()).toBe(true);
    expect(readInstallStamp()).toMatchObject({ sha256: createHash("sha256").update(payload).digest("hex"), version: "9.9.9" });
    // Staging leaves nothing behind, and the extract lands the bundle itself
    // rather than the tar it came in.
    expect(fs.readdirSync(computerHome()).filter((e) => e.startsWith(".staging-"))).toEqual([]);

    // A matching stamp makes the next run one small read, so an unchanged CLI
    // never re-swaps a bundle a live helper may be running from.
    expect(materializeHelperApp({ version: "9.9.9" }).installed).toBe(false);
  });
});

describe("a CLI that carries no payload", () => {
  const darwin = test.skipIf(process.platform !== "darwin");

  darwin("uses the helper already installed at the fixed path", () => {
    // Why: this used to throw before it looked at the fixed path, so a machine
    // with a valid, signed and already granted helper installed could not run
    // one verb from a CLI built from source — and the granted half of the CLI's
    // end to end suite could not run at all (ct-49672).
    isolatedHome();
    payload = null;
    makeBundle(helperAppPath(), "installed-by-a-release");
    fs.writeFileSync(
      path.join(computerHome(), "installed.json"),
      JSON.stringify({ sha256: "deadbeef", version: "1.2.3", installedAt: Date.now() }),
      { mode: 0o600 },
    );

    const result = materializeHelperApp();
    expect(result.adopted).toBe(true);
    expect(result.installed).toBe(false);
    expect(result.appPath).toBe(helperAppPath());
    expect(liveBody()).toBe("installed-by-a-release");
    // Adopting installs nothing, so the stamp of whichever release put it there
    // is left exactly as it was.
    expect(readInstallStamp()).toMatchObject({ sha256: "deadbeef", version: "1.2.3" });
  });

  darwin("refuses an unstamped bundle codesign rejects", () => {
    // No stamp means nobody's release verified this bundle, so it gets the
    // check a staged bundle gets before a swap. A stamp is that record, which
    // is why the case above skips the two spawns.
    isolatedHome();
    payload = null;
    makeBundle(helperAppPath(), "put-here-by-hand");
    expect(() => materializeHelperApp()).toThrow("failed signature verification");
  });

  darwin("with nothing installed either, the error names both halves", () => {
    isolatedHome();
    payload = null;
    expect(() => materializeHelperApp()).toThrow("none is installed");
    expect(fs.existsSync(helperAppPath())).toBe(false);
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
