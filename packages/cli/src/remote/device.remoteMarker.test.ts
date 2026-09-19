import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { REMOTE_DEVICE_MARKER, isRemoteDevice, resetRemoteDeviceForTests } from "./device.js";

// A Mac remote has no launch environment of its own (supervision.ts generates
// the LaunchAgent without one), so the marker file is the only durable way to
// declare it. The environment variable stays honored for the Linux provisioner.
describe("isRemoteDevice", () => {
  let dir: string;
  const savedDir = process.env.CODECAST_DIR;
  const savedEnv = process.env.CODECAST_REMOTE_DEVICE;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-remote-marker-"));
    process.env.CODECAST_DIR = dir;
    delete process.env.CODECAST_REMOTE_DEVICE;
    resetRemoteDeviceForTests();
  });

  afterEach(() => {
    if (savedDir === undefined) delete process.env.CODECAST_DIR; else process.env.CODECAST_DIR = savedDir;
    if (savedEnv === undefined) delete process.env.CODECAST_REMOTE_DEVICE; else process.env.CODECAST_REMOTE_DEVICE = savedEnv;
    resetRemoteDeviceForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("a bare machine is a primary", () => {
    expect(isRemoteDevice()).toBe(false);
  });

  test("the marker file in the config dir makes it a remote", () => {
    fs.writeFileSync(path.join(dir, REMOTE_DEVICE_MARKER), "");
    resetRemoteDeviceForTests();
    expect(isRemoteDevice()).toBe(true);
  });

  test("the provisioner's environment variable still wins without a marker", () => {
    process.env.CODECAST_REMOTE_DEVICE = "1";
    expect(isRemoteDevice()).toBe(true);
  });
});
