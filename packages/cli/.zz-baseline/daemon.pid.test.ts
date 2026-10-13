import { afterEach, describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { releasePidFileIfOwned, tryAcquirePidFileLock } from "./daemon.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makePidFile(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  tempDirs.push(dir);
  return path.join(dir, "daemon.pid");
}

describe("tryAcquirePidFileLock", () => {
  test("acquires a fresh PID file atomically", () => {
    const pidFile = makePidFile("daemon-pid-fresh");
    expect(tryAcquirePidFileLock(pidFile, 1234, { nowMs: 10_000 })).toBe(true);
    expect(fs.readFileSync(pidFile, "utf-8")).toBe("1234\n");
  });

  test("refuses a live PID owner", () => {
    const pidFile = makePidFile("daemon-pid-live");
    fs.writeFileSync(pidFile, "2222\n");
    fs.utimesSync(pidFile, 1, 1);

    expect(
      tryAcquirePidFileLock(pidFile, 3333, {
        nowMs: 10_000,
        isProcessRunning: (pid) => pid === 2222,
      }),
    ).toBe(false);
    expect(fs.readFileSync(pidFile, "utf-8")).toBe("2222\n");
  });

  test("reclaims a stale PID file", () => {
    const pidFile = makePidFile("daemon-pid-stale");
    fs.writeFileSync(pidFile, "2222\n");
    fs.utimesSync(pidFile, 1, 1);

    expect(
      tryAcquirePidFileLock(pidFile, 3333, {
        nowMs: 10_000,
        isProcessRunning: () => false,
      }),
    ).toBe(true);
    expect(fs.readFileSync(pidFile, "utf-8")).toBe("3333\n");
  });

  test("does not reclaim a fresh unreadable PID file", () => {
    const pidFile = makePidFile("daemon-pid-fresh-invalid");
    fs.writeFileSync(pidFile, "");
    fs.utimesSync(pidFile, 9, 9);

    expect(
      tryAcquirePidFileLock(pidFile, 3333, {
        nowMs: 10_000,
        isProcessRunning: () => false,
      }),
    ).toBe(false);
    expect(fs.existsSync(pidFile)).toBe(true);
  });
});

describe("releasePidFileIfOwned", () => {
  test("only removes the PID file for the owning process", () => {
    const pidFile = makePidFile("daemon-pid-release");
    fs.writeFileSync(pidFile, "4444\n");

    expect(releasePidFileIfOwned(pidFile, 1111)).toBe(false);
    expect(fs.existsSync(pidFile)).toBe(true);

    expect(releasePidFileIfOwned(pidFile, 4444)).toBe(true);
    expect(fs.existsSync(pidFile)).toBe(false);
  });
});
