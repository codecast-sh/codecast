import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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
    const kill = spyOn(process, "kill").mockImplementation(() => {
      throw new Error("invalid PID was probed");
    });
    try {
      for (const pid of [0, -1, NaN, Infinity, 1.5, 2 ** 31, Number.MAX_SAFE_INTEGER]) {
        expect(isPidAlive(pid)).toBe(false);
      }
      expect(kill).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
    }
  });
  test("returns false for an unused pid", () => {
    // PID 999999999 is well above typical max; safe assumption.
    expect(isPidAlive(999999999)).toBe(false);
  });
});

describe("stopChrome exit confirmation", () => {
  const pid = 999999998;

  function stubKill(handler: (signal: string | number) => true) {
    const original = process.kill.bind(process);
    return spyOn(process, "kill").mockImplementation((target, signal = "SIGTERM") =>
      target === pid ? handler(signal) : original(target, signal),
    );
  }

  test.each(["EPERM", "EACCES"])("treats a signal-0 %s probe as alive", async (code) => {
    const denied = Object.assign(new Error("permission denied"), { code });
    const kill = stubKill(() => { throw denied; });
    try {
      expect(isPidAlive(pid)).toBe(true);
      await expect(stopChrome(pid)).rejects.toBe(denied);
    } finally {
      kill.mockRestore();
    }
  });

  test.each(["EIO", undefined])("propagates an unexpected signal-0 error (%s)", async (code) => {
    const unexpected = Object.assign(new Error("probe failed"), { code });
    const kill = stubKill(() => { throw unexpected; });
    try {
      expect(() => isPidAlive(pid)).toThrow(unexpected);
      await expect(stopChrome(pid)).rejects.toBe(unexpected);
    } finally {
      kill.mockRestore();
    }
  });

  test("does not mistake a failed post-SIGKILL probe for exit", async () => {
    let killed = false;
    const unexpected = Object.assign(new Error("probe failed"), { code: "EIO" });
    const kill = stubKill((signal) => {
      if (signal === "SIGKILL") killed = true;
      if (signal === 0 && killed) throw unexpected;
      return true;
    });
    try {
      await expect(stopChrome(pid, { timeoutMs: 0 })).rejects.toBe(unexpected);
      expect(killed).toBe(true);
    } finally {
      kill.mockRestore();
    }
  });

  test("accepts ESRCH as proof that the process is gone", async () => {
    const kill = stubKill(() => {
      throw Object.assign(new Error("process exited"), { code: "ESRCH" });
    });
    try {
      expect(isPidAlive(pid)).toBe(false);
      await stopChrome(pid);
    } finally {
      kill.mockRestore();
    }
  });

  test("waits for exit after SIGKILL before resolving", async () => {
    let alive = true;
    let finished = false;
    const signals: Array<string | number> = [];
    const kill = stubKill((signal) => {
      if (!alive) throw Object.assign(new Error("process exited"), { code: "ESRCH" });
      if (signal !== 0) signals.push(signal);
      return true;
    });
    const stopping = stopChrome(pid, { timeoutMs: 0 }).then(() => { finished = true; });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
      expect(finished).toBe(false);
      alive = false;
      await stopping;
      expect(finished).toBe(true);
      expect(isPidAlive(pid)).toBe(false);
    } finally {
      alive = false;
      kill.mockRestore();
      await stopping;
    }
  });

  test("rejects when the process survives the final deadline", async () => {
    const signals: Array<string | number> = [];
    const kill = stubKill((signal) => {
      if (signal !== 0) signals.push(signal);
      return true;
    });
    try {
      await expect(stopChrome(pid, { timeoutMs: 0, killTimeoutMs: 0 })).rejects.toMatchObject({
        name: "ChromeStopError",
        pid,
      });
      expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    } finally {
      kill.mockRestore();
    }
  });

  test.each(["SIGTERM", "SIGKILL"] as const)("rejects a %s permission failure", async (deniedSignal) => {
    const denied = Object.assign(new Error("permission denied"), { code: "EPERM" });
    const kill = stubKill((signal) => {
      if (signal === deniedSignal) throw denied;
      return true;
    });
    try {
      await expect(stopChrome(pid, { timeoutMs: 0 })).rejects.toBe(denied);
    } finally {
      kill.mockRestore();
    }
  });

  test.each(["SIGTERM", "SIGKILL"] as const)("accepts exit just before %s", async (exitSignal) => {
    const signals: Array<string | number> = [];
    const kill = stubKill((signal) => {
      if (signal !== 0) {
        signals.push(signal);
        if (signal === exitSignal) throw Object.assign(new Error("process exited"), { code: "ESRCH" });
      }
      return true;
    });
    try {
      await stopChrome(pid, { timeoutMs: 0 });
      expect(signals).toEqual(exitSignal === "SIGTERM" ? ["SIGTERM"] : ["SIGTERM", "SIGKILL"]);
    } finally {
      kill.mockRestore();
    }
  });

  test("does not escalate after a graceful exit", async () => {
    let alive = true;
    const signals: Array<string | number> = [];
    const kill = stubKill((signal) => {
      if (!alive) throw Object.assign(new Error("process exited"), { code: "ESRCH" });
      if (signal !== 0) {
        signals.push(signal);
        alive = false;
      }
      return true;
    });
    try {
      await stopChrome(pid);
      expect(signals).toEqual(["SIGTERM"]);
      expect(isPidAlive(pid)).toBe(false);
    } finally {
      kill.mockRestore();
    }
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

  test.each([3000, 0])("stopChrome terminates the process with a %ims grace period", async (timeoutMs) => {
    const port = await pickPort(39800);
    const inst = await launchChrome({
      cdpPort: port,
      userDataDir: path.join(tmpDir, "stoptest"),
    });
    launched.push(inst);

    expect(isPidAlive(inst.pid)).toBe(true);
    await stopChrome(inst.pid, { timeoutMs });
    expect(isPidAlive(inst.pid)).toBe(false);
    // CDP port released.
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
