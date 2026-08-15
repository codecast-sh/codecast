/**
 * Which way a command reaches the browser, and how a wedge is classified.
 *
 * The resident (daemon-hosted) path is dormant: it must be chosen only on an
 * explicit opt-in, and any failure to reach it must fall through to the
 * direct path rather than surface. The direct path must keep the three-state
 * verdict — "gone" is the only one that permits a relaunch.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { chooseDriver, openDriver, RESIDENT_ENV } from "./driver.js";
import { writeState, type InstanceState } from "./instance.js";
import { BrowserNotLive, enablePageDomains, isTabUnresponsive, reviveError, TabUnresponsive } from "./recovery.js";
import { CdpTimeout, type CdpClient, type CdpEvent } from "./cdp.js";

describe("chooseDriver", () => {
  test("direct unless the resident path is opted into AND a daemon port exists", () => {
    expect(chooseDriver({ residentOptIn: false, hookPort: 1234 })).toBe("direct");
    expect(chooseDriver({ residentOptIn: true, hookPort: null })).toBe("direct");
    expect(chooseDriver({ residentOptIn: true, hookPort: 1234 })).toBe("resident");
    expect(chooseDriver({ residentOptIn: false, hookPort: null })).toBe("direct");
  });
});

describe("openDriver fallback", () => {
  let home: string;
  const saved = { HOME: process.env.HOME, CODECAST_DIR: process.env.CODECAST_DIR, RESIDENT: process.env[RESIDENT_ENV] };
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "cast-driver-"));
    process.env.HOME = home;
    process.env.CODECAST_DIR = path.join(home, ".codecast");
    fs.mkdirSync(process.env.CODECAST_DIR, { recursive: true });
  });
  afterEach(() => {
    process.env.HOME = saved.HOME;
    if (saved.CODECAST_DIR === undefined) delete process.env.CODECAST_DIR;
    else process.env.CODECAST_DIR = saved.CODECAST_DIR;
    if (saved.RESIDENT === undefined) delete process.env[RESIDENT_ENV];
    else process.env[RESIDENT_ENV] = saved.RESIDENT;
    fs.rmSync(home, { recursive: true, force: true });
  });

  test("no browser at all → BrowserNotLive('dead'), the verdict that permits a relaunch", async () => {
    await expect(openDriver()).rejects.toBeInstanceOf(BrowserNotLive);
    await expect(openDriver()).rejects.toMatchObject({ liveness: "dead" });
  });

  test("an unreachable daemon port under opt-in falls through to the direct verdict", async () => {
    // A hook-port file naming a port nobody listens on: the resident connect
    // fails, and that must NOT be what the agent hears — the direct path's
    // honest "no managed browser is running" is.
    process.env[RESIDENT_ENV] = "1";
    fs.writeFileSync(path.join(process.env.CODECAST_DIR!, "hook-port"), "1");
    const err = await openDriver().catch((e) => e);
    expect(err).toBeInstanceOf(BrowserNotLive);
    expect(err.liveness).toBe("dead");
    expect(err.problem.message).toMatch(/no managed browser is running/);
  });

  test("a recorded browser whose process is gone is 'dead' without any network wait", async () => {
    const state: InstanceState = {
      pid: 999_999_999, port: 1, wsUrl: "ws://127.0.0.1:1/devtools/browser/x", userDataDir: "/tmp/none",
      headless: true, sourceProfile: null, channel: "chrome", startedAt: 0, activeTargetId: null,
    };
    writeState(state);
    const started = Date.now();
    const err = await openDriver().catch((e) => e);
    expect(err.liveness).toBe("dead");
    expect(Date.now() - started).toBeLessThan(3000);
  });

  test("a live process that does not answer is 'unresponsive', never 'dead'", async () => {
    // Our own pid is alive; port 1 answers nothing. This is the verdict that
    // must never be confused with "gone", because "gone" invites a restart.
    const state: InstanceState = {
      pid: process.pid, port: 1, userDataDir: "/tmp/none",
      headless: true, sourceProfile: null, channel: "chrome", startedAt: 0, activeTargetId: null,
    };
    writeState(state);
    const err = await openDriver({ patienceMs: 600 }).catch((e) => e);
    expect(err).toBeInstanceOf(BrowserNotLive);
    expect(err.liveness).toBe("unresponsive");
    expect(err.problem.hint).toMatch(/Do not stop\/start/);
  });
});

/** A CdpClient whose enables never answer for one target. */
function wedgedClient(wedgedSession: string): CdpClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    send(method: string, _params?: Record<string, unknown>, sessionId?: string, timeoutMs = 30_000) {
      calls.push(`${sessionId}:${method}`);
      if (sessionId === wedgedSession && method.endsWith(".enable")) {
        return new Promise((_, reject) => setTimeout(() => reject(new CdpTimeout(method, timeoutMs)), timeoutMs));
      }
      return Promise.resolve({} as any);
    },
    on: () => () => {},
    waitFor: (_p: (ev: CdpEvent) => boolean) => Promise.reject(new Error("unused")),
    close() {},
  };
}

describe("wedge classification (recovery.ts)", () => {
  test("enables that never answer twice → TabUnresponsive with the way out", async () => {
    const conn = wedgedClient("S1");
    const err = await enablePageDomains(conn, "S1", "TARGET1234", { attemptsMs: [30, 40], pauseMs: 5 }).catch((e) => e);
    expect(err).toBeInstanceOf(TabUnresponsive);
    expect(isTabUnresponsive(err)).toBe(true);
    expect(err.message).toMatch(/did not respond/);
    expect(err.message).toMatch(/cast browser close --tab TARGET12/);
    // Both attempts were made: a single slow answer is not proof of a wedge.
    expect(conn.calls.filter((c) => c === "S1:Page.enable").length).toBe(2);
  });

  test("a healthy tab enables all five domains in one round (in parallel)", async () => {
    const conn = wedgedClient("other");
    await enablePageDomains(conn, "S2", "T", { attemptsMs: [30, 40], pauseMs: 5 });
    expect(conn.calls.filter((c) => c.startsWith("S2:")).length).toBe(5);
  });

  test("the classification survives a trip through the wire", () => {
    const wire = { name: "TabUnresponsive", message: new TabUnresponsive("ABCDEFGH", "x").message };
    const revived = reviveError(wire);
    expect(revived).not.toBeInstanceOf(TabUnresponsive);
    expect(isTabUnresponsive(revived)).toBe(true);
    expect(isTabUnresponsive(new Error("nope"))).toBe(false);
  });
});
