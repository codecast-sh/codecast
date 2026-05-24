import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  chromeBinaryProbes,
  ChromeNotFoundError,
  findChromeBinary,
  isPidAlive,
  launchChrome,
  stopChrome,
  type ChromeInstance,
} from "./chrome.js";
import { isPortFree } from "./ports.js";

const CHROME_PATH = findChromeBinary();
const HAVE_CHROME = CHROME_PATH !== null;

/** Reserve a high port that's currently free for use as a CDP port. */
async function pickPort(start = 39600): Promise<number> {
  for (let p = start; p < start + 200; p++) {
    if (await isPortFree(p)) return p;
  }
  throw new Error("could not find a free port for test");
}

let tmpDir: string;
const launched: ChromeInstance[] = [];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-chrome-test-"));
});

afterEach(async () => {
  for (const inst of launched.splice(0)) {
    await stopChrome(inst.pid, { timeoutMs: 2000 });
  }
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

describe("findChromeBinary / probes", () => {
  test("probes include user override env var when set", () => {
    const oldEnv = process.env.CODECAST_CHROMIUM;
    process.env.CODECAST_CHROMIUM = "/custom/path/chromium";
    try {
      const probes = chromeBinaryProbes();
      expect(probes[0]).toBe("/custom/path/chromium");
    } finally {
      if (oldEnv === undefined) delete process.env.CODECAST_CHROMIUM;
      else process.env.CODECAST_CHROMIUM = oldEnv;
    }
  });

  test("probes contain expected macOS + Linux paths", () => {
    const probes = chromeBinaryProbes();
    expect(probes).toContain(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    );
    expect(probes).toContain("/usr/bin/chromium");
  });

  test("findChromeBinary returns null when none exist (env override)", () => {
    const oldEnv = process.env.CODECAST_CHROMIUM;
    process.env.CODECAST_CHROMIUM = "/definitely/not/exist/xyzzy";
    try {
      // On dev machines this'll still find system Chrome via fallback paths;
      // we can only assert the env override doesn't accidentally short-circuit
      // to true.
      const found = findChromeBinary();
      // If system has Chrome, found is non-null; else null. Either way the env
      // override pointing at a nonexistent path didn't trick us.
      if (found !== null) expect(found).not.toBe("/definitely/not/exist/xyzzy");
    } finally {
      if (oldEnv === undefined) delete process.env.CODECAST_CHROMIUM;
      else process.env.CODECAST_CHROMIUM = oldEnv;
    }
  });
});

// ---------------------------------------------------------------------------
// isPidAlive (cheap helper, no Chrome needed)
// ---------------------------------------------------------------------------

describe("isPidAlive", () => {
  test("returns true for own process", () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });
  test("returns false for invalid pid", () => {
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
  });
  test("returns false for an unused pid", () => {
    // PID 999999999 is well above typical max; safe assumption.
    expect(isPidAlive(999999999)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Launch / stop — gated on having Chrome installed
// ---------------------------------------------------------------------------

describe.if(!HAVE_CHROME)("launchChrome without Chrome installed", () => {
  test("throws ChromeNotFoundError", async () => {
    const oldEnv = process.env.CODECAST_CHROMIUM;
    process.env.CODECAST_CHROMIUM = "/definitely/not/exist/xyzzy";
    try {
      await expect(
        launchChrome({ cdpPort: 39999, userDataDir: tmpDir }),
      ).rejects.toBeInstanceOf(ChromeNotFoundError);
    } finally {
      if (oldEnv === undefined) delete process.env.CODECAST_CHROMIUM;
      else process.env.CODECAST_CHROMIUM = oldEnv;
    }
  });
});

describe.if(HAVE_CHROME)("launchChrome — real Chrome", () => {
  test("spawns Chrome and exposes a listening CDP port", async () => {
    const port = await pickPort();
    const inst = await launchChrome({
      cdpPort: port,
      userDataDir: path.join(tmpDir, "single"),
    });
    launched.push(inst);

    expect(inst.pid).toBeGreaterThan(0);
    expect(inst.cdpPort).toBe(port);
    expect(inst.headless).toBe(true);
    expect(fs.existsSync(inst.userDataDir)).toBe(true);
    expect(isPidAlive(inst.pid)).toBe(true);

    // CDP /json/version handshake is the canonical readiness check.
    const res = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) =>
      r.json(),
    );
    expect(typeof (res as { Browser?: string }).Browser).toBe("string");
    expect((res as { Browser: string }).Browser).toMatch(/Chrome|Chromium/i);
  }, 20000);

  test("two simultaneous instances get distinct ports and PIDs", async () => {
    const portA = await pickPort(39700);
    const portB = await pickPort(portA + 1);
    const a = await launchChrome({
      cdpPort: portA,
      userDataDir: path.join(tmpDir, "a"),
    });
    launched.push(a);
    const b = await launchChrome({
      cdpPort: portB,
      userDataDir: path.join(tmpDir, "b"),
    });
    launched.push(b);

    expect(a.pid).not.toBe(b.pid);
    expect(a.cdpPort).not.toBe(b.cdpPort);
    expect(a.userDataDir).not.toBe(b.userDataDir);
    expect(isPidAlive(a.pid)).toBe(true);
    expect(isPidAlive(b.pid)).toBe(true);

    // Both expose CDP endpoints independently.
    const verA = (await fetch(`http://127.0.0.1:${portA}/json/version`).then((r) =>
      r.json(),
    )) as { Browser?: string };
    const verB = (await fetch(`http://127.0.0.1:${portB}/json/version`).then((r) =>
      r.json(),
    )) as { Browser?: string };
    expect(verA.Browser).toBeTruthy();
    expect(verB.Browser).toBeTruthy();
  }, 25000);

  test("stopChrome cleanly terminates the process", async () => {
    const port = await pickPort(39800);
    const inst = await launchChrome({
      cdpPort: port,
      userDataDir: path.join(tmpDir, "stoptest"),
    });
    // NOT pushing to launched[] — we're stopping it here intentionally.

    expect(isPidAlive(inst.pid)).toBe(true);
    await stopChrome(inst.pid, { timeoutMs: 3000 });
    expect(isPidAlive(inst.pid)).toBe(false);
    // CDP port released.
    await sleep(200); // give socket a moment to fully release
    expect(await isPortFree(port)).toBe(true);
  }, 20000);

  test("launch errors with explicit bad binary path", async () => {
    await expect(
      launchChrome({
        cdpPort: 39900,
        userDataDir: tmpDir,
        binaryPath: "/definitely/not/exist/xyzzy/chromium",
        readyTimeoutSec: 2,
      }),
    ).rejects.toBeInstanceOf(Error);
  }, 10000);
});
