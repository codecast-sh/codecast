import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { acquire, heldByCaller, ownerPid, parsePoolEnv, poolStatus, readLock, releaseLock, type ProcInfo } from "./pool.js";
import { deviceBusy, etimeSecs, reapDecision } from "./reap.js";
import { pickIphone, type SimRuntime } from "./simctl.js";
import { findElements, flattenUi, screenPoints } from "./ui.js";

describe("ownerPid", () => {
  const tree = (procs: Record<number, ProcInfo>) => (pid: number) => procs[pid] ?? null;

  test("walks past shells to the agent", () => {
    const info = tree({ 30: { comm: "bash", ppid: 20 }, 20: { comm: "/bin/zsh", ppid: 10 }, 10: { comm: "claude", ppid: 1 } });
    expect(ownerPid(30, info)).toBe(10);
  });

  test("a human shell under tmux owns its own lock", () => {
    const info = tree({ 30: { comm: "bash", ppid: 20 }, 20: { comm: "-zsh", ppid: 5 }, 5: { comm: "tmux: server", ppid: 1 } });
    expect(ownerPid(30, info)).toBe(20);
  });
});

describe("pool locks", () => {
  let dir: string;
  const pool = parsePoolEnv("AAA=iPhone A:BBB=iPhone B");
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "sim-locks-")); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test("parses the SIM_POOL format the scripts use", () => {
    expect(parsePoolEnv("X:Y=Name with = sign")).toEqual([{ udid: "X", name: "X" }, { udid: "Y", name: "Name with = sign" }]);
  });

  test("acquire writes the scripts' lock format and skips held devices", () => {
    const a = acquire({ pool, dir, owner: process.pid, session: "sess-1" });
    expect(a?.device.udid).toBe("AAA");
    expect(fs.readFileSync(path.join(dir, "AAA.lock", "pid"), "utf-8").trim()).toBe(String(process.pid));
    expect(fs.readFileSync(path.join(dir, "AAA.lock", "session"), "utf-8").trim()).toBe("sess-1");
    const b = acquire({ pool, dir, owner: process.pid, session: null });
    expect(b?.device.udid).toBe("BBB");
    expect(acquire({ pool, dir, owner: process.pid, session: null })).toBeNull();
  });

  test("a lock whose owner exited is stale and taken over", () => {
    fs.mkdirSync(path.join(dir, "AAA.lock"));
    fs.writeFileSync(path.join(dir, "AAA.lock", "pid"), "999999\n");
    expect(readLock("AAA", dir).state).toBe("stale");
    const a = acquire({ pool, dir, owner: process.pid, session: null, preferred: 0 });
    expect(a).toMatchObject({ device: { udid: "AAA" }, reclaimed: 999999 });
  });

  test("the caller's simulator is found by owner or by session", () => {
    acquire({ pool, dir, owner: process.pid, session: "sess-2" });
    const status = poolStatus(pool, dir);
    expect(heldByCaller(status, process.pid, null)?.udid).toBe("AAA");
    expect(heldByCaller(status, 1, "sess-2")?.udid).toBe("AAA");
    expect(heldByCaller(status, 1, "other")).toBeUndefined();
    expect(releaseLock("AAA", dir)).toBe(true);
    expect(releaseLock("AAA", dir)).toBe(false);
  });
});

describe("reap", () => {
  test("etime parses every ps shape", () => {
    expect(etimeSecs("05:07")).toBe(307);
    expect(etimeSecs("01:00:00")).toBe(3600);
    expect(etimeSecs("2-03:04:05")).toBe(2 * 86400 + 3 * 3600 + 4 * 60 + 5);
  });

  test("an app launched recently or using CPU keeps the device busy", () => {
    const line = (pcpu: string, etime: string) => `123 ${pcpu} ${etime} /Users/x/Library/Developer/CoreSimulator/Devices/AAA/data/Containers/Bundle/Application/Z/App.app/App`;
    expect(deviceBusy(line("0.5", "1:00:00"), "AAA", 600)).toBe(false);
    expect(deviceBusy(line("12.0", "1:00:00"), "AAA", 600)).toBe(true);
    expect(deviceBusy(line("0.5", "02:00"), "AAA", 600)).toBe(true);
    expect(deviceBusy(line("12.0", "02:00"), "BBB", 600)).toBe(false);
  });

  test("two strikes, never a held, watched or busy device", () => {
    const base = { state: "free" as const, booted: true, watched: false, busy: false };
    expect(reapDecision(base, 1000)).toBe("strike");
    expect(reapDecision({ ...base, seenAt: 900 }, 1000)).toBe("skip");
    expect(reapDecision({ ...base, seenAt: 300 }, 1000)).toBe("reap");
    expect(reapDecision({ ...base, state: "held", seenAt: 0 }, 1000)).toBe("skip");
    expect(reapDecision({ ...base, watched: true, seenAt: 0 }, 1000)).toBe("skip");
    expect(reapDecision({ ...base, busy: true, seenAt: 0 }, 1000)).toBe("skip");
    expect(reapDecision({ ...base, state: "stale", booted: false }, 1000)).toBe("clear-stale");
  });
});

describe("simulator choice", () => {
  test("the newest iOS runtime's newest plain Pro iPhone", () => {
    const rt = (version: string, names: string[], available = true): SimRuntime => ({
      identifier: `ios-${version}`, name: `iOS ${version}`, platform: "iOS", version, available,
      deviceTypes: names.map((n) => ({ identifier: n, name: n })),
    });
    const pick = pickIphone([rt("18.6", ["iPhone 16 Pro"]), rt("26.5", ["iPhone 17", "iPhone 17 Pro", "iPhone 17 Pro Max", "iPad Air"]), rt("27.0", ["iPhone 18 Pro"], false)]);
    expect(pick?.runtime.version).toBe("26.5");
    expect(pick?.deviceType.name).toBe("iPhone 17 Pro");
  });
});

describe("ui", () => {
  const raw = [{
    type: "Application", AXLabel: "Codecast", frame: { x: 0, y: 0, width: 402, height: 874 },
    children: [
      { type: "Button", AXLabel: "Sign in", frame: { x: 100, y: 600, width: 200, height: 50 }, children: [] },
      { type: "TextField", AXLabel: "Email", AXValue: "", frame: { x: 20, y: 300, width: 360, height: 44 } },
      { type: "Button", AXLabel: "Sign in with Apple", frame: { x: 100, y: 700, width: 200, height: 50 } },
    ],
  }];

  test("flattens with tap points and the screen size in points", () => {
    const els = flattenUi(raw);
    expect(els).toHaveLength(4);
    expect(els[1]).toMatchObject({ type: "Button", label: "Sign in", center: { x: 200, y: 625 }, depth: 1 });
    expect(screenPoints(els)).toEqual({ width: 402, height: 874 });
  });

  test("an exact label beats a substring; the app root never matches", () => {
    const els = flattenUi(raw);
    expect(findElements(els, "sign in").map((e) => e.label)).toEqual(["Sign in"]);
    expect(findElements(els, "apple").map((e) => e.label)).toEqual(["Sign in with Apple"]);
    expect(findElements(els, "codecast")).toEqual([]);
  });
});
