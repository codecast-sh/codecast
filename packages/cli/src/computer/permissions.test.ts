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
import { formatPermissionsReport, getPermissionStatus, nextPermissionStep, openPermissionSettings } from "./permissions.js";
import { computerHome, helperAppPath, helperExecutablePath } from "./helperApp.js";
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
    const status = await getPermissionStatus({ launch: () => (launched = true) });
    expect(launched).toBe(false);
    expect(status.helperUnavailableReason).toContain("was not found");
    expect(status.permissions.every((p) => p.status === "not-granted")).toBe(true);
  });

  darwinOnly("a probe that never writes the file times out and cleans up after itself", async () => {
    isolatedHome();
    materializeFakeHelper();
    const before = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("codecast-computer-permissions-")).length;
    const err = (await getPermissionStatus({ launch: () => {} }).catch((e) => e)) as ComputerError;
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

describe("openPermissionSettings", () => {
  darwinOnly("refuses an id that is not one of the two grants", async () => {
    const err = (await openPermissionSettings("camera" as never).catch((e) => e)) as ComputerError;
    expect(err.code).toBe("invalid_argument");
    expect(err.message).toContain("accessibility");
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
