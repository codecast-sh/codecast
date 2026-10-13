/**
 * Permission status is read from a file the helper writes about ITSELF.
 *
 * The launch route is injected here so the test drives the polling, the
 * timeout and the reporting without LaunchServices; which of the two real
 * routes is used is a property of the machine, and A7 proves it there.
 */

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  formatPermissionsReport,
  getPermissionStatus,
  nextPermissionStep,
  openPermissionSettings,
  readPermissionStatus,
  STATUS_POLL_TIMEOUT_MS,
} from "./permissions.js";
import { computerHome, helperAppPath, helperExecutablePath } from "./helperApp.js";
import { spawnObserved } from "./launchObserver.js";
import { ComputerError } from "./errors.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

function isolatedHome(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cast-computer-perm-test-"));
  const prev = process.env.CODECAST_DIR;
  process.env.CODECAST_DIR = dir;
  cleanups.push(() => {
    if (prev === undefined) delete process.env.CODECAST_DIR;
    else process.env.CODECAST_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  fs.mkdirSync(computerHome(), { recursive: true, mode: 0o700 });
}

function materializeFakeHelper(): void {
  fs.mkdirSync(path.join(helperAppPath(), "Contents", "MacOS"), { recursive: true });
  fs.writeFileSync(helperExecutablePath(), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
}

const darwinOnly = process.platform === "darwin" ? test : test.skip;

describe("getPermissionStatus", () => {
  darwinOnly("reports what the helper wrote about itself", async () => {
    isolatedHome();
    materializeFakeHelper();
    const status = await getPermissionStatus({
      launch: (_app, statusPath) => fs.writeFileSync(statusPath, JSON.stringify({ accessibility: "granted", screenshots: "not-granted" })),
    });
    expect(status.helperUnavailableReason).toBeNull();
    expect(status.permissions).toEqual([
      { id: "accessibility", status: "granted" },
      { id: "screenshots", status: "not-granted" },
    ]);
    expect(nextPermissionStep(status)).toContain("Screen Recording");
  });

  darwinOnly("anything that is not a known status reads as not-granted", async () => {
    isolatedHome();
    materializeFakeHelper();
    const status = await getPermissionStatus({
      launch: (_app, statusPath) => fs.writeFileSync(statusPath, JSON.stringify({ accessibility: "maybe" })),
    });
    // A grant we cannot read is a grant we do not have; guessing the other way
    // sends the agent into a verb that fails with permission_denied.
    expect(status.permissions.every((p) => p.status === "not-granted")).toBe(true);
  });

  darwinOnly("a missing helper is reported, not probed", async () => {
    isolatedHome();
    let launched = false;
    const status = await getPermissionStatus({ launch: () => void (launched = true) });
    expect(launched).toBe(false);
    expect(status.helperUnavailableReason).toContain("was not found");
    expect(status.permissions.every((p) => p.status === "not-granted")).toBe(true);
  });

  darwinOnly("a probe that dies is reported by its exit and its stderr, not as a timeout", async () => {
    // Why: this used to be five seconds of waiting and then "timed out
    // checking permissions", for a child that was already dead. A missing
    // bundle, a refused signature and a crash all read the same (ct-49674).
    isolatedHome();
    materializeFakeHelper();
    const started = Date.now();
    const err = (await getPermissionStatus({
      launch: (_app, _statusPath, logFile) =>
        spawnObserved("/bin/sh", ["-c", 'echo "codecast-computer: bad CPU type" >&2; exit 86'], logFile),
    }).catch((e) => e)) as ComputerError;
    expect(err.code).toBe("accessibility_error");
    expect(err.message).toContain("exited with code 86");
    expect(err.message).toContain("bad CPU type");
    // Fast, not five seconds: the point is that the death is the answer.
    expect(Date.now() - started).toBeLessThan(3_000);
  }, 20_000);

  darwinOnly("a probe that answers just as it exits is still believed", async () => {
    // The helper writes the file and exits, so the exit and the answer race by
    // design. An exit must never overtake a status that is already on disk.
    isolatedHome();
    materializeFakeHelper();
    const status = await getPermissionStatus({
      launch: (_app, statusPath, logFile) =>
        spawnObserved("/bin/sh", ["-c", `printf '%s' '{"accessibility":"granted","screenshots":"granted"}' > ${JSON.stringify(statusPath)}`], logFile),
    });
    expect(status.permissions.every((p) => p.status === "granted")).toBe(true);
  }, 20_000);

  darwinOnly("an answer that arrives after the old 5s budget is still an answer", async () => {
    // Why: the budget was 50 polls at 100 ms and the helper took 3.4-25.7 s on
    // a Mac with no TCC row for it, so the first command a new user ran
    // reported a timeout more often than a state (ct-49671). The helper is
    // faster now, but the launch wrapper alone costs up to 6.5 s from source,
    // so the ceiling has to sit well past five seconds.
    isolatedHome();
    materializeFakeHelper();
    const status = await getPermissionStatus({
      launch: (_app, statusPath) => {
        const late = setTimeout(() => fs.writeFileSync(statusPath, JSON.stringify({ accessibility: "granted", screenshots: "granted" })), 6_000);
        late.unref?.();
      },
    });
    expect(status.permissions.every((p) => p.status === "granted")).toBe(true);
  }, 30_000);

  test("the poll ceiling stays above the measured worst case", () => {
    // A ratchet on a measured decision, not a style preference: end to end runs
    // took 3.8-8.8 s, and the helper alone reached 25.7 s before its settle
    // loop was fixed. Shrinking this back toward 5 s brings the bug back.
    expect(STATUS_POLL_TIMEOUT_MS).toBeGreaterThanOrEqual(20_000);
  });

  darwinOnly("a probe that never writes the file times out and cleans up after itself", async () => {
    isolatedHome();
    materializeFakeHelper();
    const before = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("codecast-computer-permissions-")).length;
    const err = (await getPermissionStatus({ launch: () => {}, timeoutMs: 400 }).catch((e) => e)) as ComputerError;
    expect(err.code).toBe("accessibility_error");
    expect(err.message).toBe("timed out checking permissions");
    const after = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("codecast-computer-permissions-")).length;
    expect(after).toBe(before);
  }, 20_000);

  test("off macOS both grants report as unsupported", async () => {
    if (process.platform === "darwin") return;
    const status = await getPermissionStatus();
    expect(status.permissions.every((p) => p.status === "unsupported")).toBe(true);
  });
});

describe("readPermissionStatus", () => {
  darwinOnly("reports a missing grant and its next step without spawning `open`", async () => {
    // Why: `open -n <app> --args --permissions` activates a window. The status
    // read must reach the same verdict from the probe file alone, or every
    // error recovery that names this command steals the screen (ct-49667).
    isolatedHome();
    materializeFakeHelper();
    const result = await readPermissionStatus(undefined, {
      launch: (_app, statusPath) => fs.writeFileSync(statusPath, JSON.stringify({ accessibility: "not-granted", screenshots: "granted" })),
    });
    expect(result.launchedHelper).toBe(false);
    expect(result.helperUnavailableReason).toBeNull();
    expect(result.nextStep).toContain("Grant Accessibility");
  });

  darwinOnly("refuses an id that is not one of the two grants", async () => {
    const err = (await readPermissionStatus("camera" as never).catch((e) => e)) as ComputerError;
    expect(err.code).toBe("invalid_argument");
    expect(err.message).toContain("accessibility");
  });
});

describe("openPermissionSettings", () => {
  darwinOnly("refuses an id that is not one of the two grants", async () => {
    const err = (await openPermissionSettings("camera" as never).catch((e) => e)) as ComputerError;
    expect(err.code).toBe("invalid_argument");
    expect(err.message).toContain("accessibility");
  });

  darwinOnly("refuses to launch when the helper is not materialized", async () => {
    isolatedHome();
    const err = (await openPermissionSettings().catch((e) => e)) as ComputerError;
    expect(err.code).toBe("accessibility_error");
    expect(err.message).toContain("was not found");
  });
});

describe("formatPermissionsReport", () => {
  test("names the helper, both grants and the one next step", () => {
    const lines = formatPermissionsReport({
      platform: "darwin",
      helperAppPath: "/Users/x/.codecast/computer/codecast computer.app",
      helperUnavailableReason: null,
      permissions: [
        { id: "accessibility", status: "granted" },
        { id: "screenshots", status: "not-granted" },
      ],
    });
    expect(lines[0]).toBe("Computer permissions checked.");
    expect(lines.join("\n")).toContain("accessibility=granted, screenshots=not-granted");
    expect(lines.at(-1)).toContain("Grant Screen Recording to codecast computer");
  });

  test("says nothing about a next step when both grants are in place", () => {
    const lines = formatPermissionsReport({
      platform: "darwin",
      helperAppPath: "/x/codecast computer.app",
      helperUnavailableReason: null,
      permissions: [
        { id: "accessibility", status: "granted" },
        { id: "screenshots", status: "granted" },
      ],
    });
    expect(lines.some((l) => l.includes("Next:"))).toBe(false);
  });
});
