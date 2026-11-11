/**
 * Which browser the reaper reaches for a session's tab, whose session a key
 * names, and what a reap does to a real session whose agent is gone: its tab
 * is closed on the bridge (a FakeExtension sees the close) and its daemon
 * files are removed, while a live owner and the caller's own session, in
 * either mode, are untouched. File-backed state lives under a per-test
 * CODECAST_DIR; daemon files under a per-test state dir.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { closeSessionTab, closeTargetLater, detachSessionDaemon, ownerState, reapEngineOrphans, sessionEndpoint, sessionPinnedTabs, withEndedSession, type LiveOwners } from "./engineReap.js";
import type { LivenessVerdict } from "@codecast/shared/contracts";
import { writeBridgeState } from "./bridge/host.js";
import { FakeExtension, testBridgeHost } from "./bridge/host.testutil.js";
import { targetIdOfTab } from "./bridge/protocol.js";
import { engineSessionKey, engineStateDir, realSessionKey, withTabName } from "./engine.js";
import { writeBoundTarget } from "./pinnedTab.js";

let dir: string;
let prevEnv: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cast-reap-test-"));
  prevEnv = process.env.CODECAST_DIR;
  process.env.CODECAST_DIR = dir;
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env.CODECAST_DIR;
  else process.env.CODECAST_DIR = prevEnv;
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A proven bridge host with a fake Chrome behind it holding `tabs`. */
async function bridgeWithTabs(...tabIds: number[]) {
  const host = await testBridgeHost();
  const ext = await new FakeExtension(tabIds.map((id) => FakeExtension.tab(id))).connect(host.port);
  return { host, ext, closes: () => ext.seen.filter((m) => m.op === "tabs.close").map((m) => m.tabId as number) };
}

describe("closeTargetLater", () => {
  test("closes the tab behind a bridge target id and resolves once it is gone", async () => {
    const { host, ext, closes } = await bridgeWithTabs(7);
    try {
      await closeTargetLater(targetIdOfTab(7), { port: host.port, token: host.token });
      expect(closes()).toEqual([7]);
      expect(ext.tabs).toEqual([]);
    } finally {
      await host.close();
    }
  });

  test("nothing to reach (no endpoint, or a port with no host) resolves without throwing", async () => {
    await closeTargetLater(targetIdOfTab(7), null);
    await closeTargetLater(targetIdOfTab(7), 1);
  });
});

describe("closeSessionTab", () => {
  test("an unbound session does not start an engine just to close a tab", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cast-reap-empty-"));
    const prev = process.env.AGENT_BROWSER_SOCKET_DIR;
    process.env.AGENT_BROWSER_SOCKET_DIR = stateDir;
    try {
      expect(await closeSessionTab("env-unbound-real", "/must-not-execute")).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.AGENT_BROWSER_SOCKET_DIR;
      else process.env.AGENT_BROWSER_SOCKET_DIR = prev;
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test("with no engine, a -real session's tab is closed by its bound target id over the bridge", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cast-reap-state-"));
    const prev = process.env.AGENT_BROWSER_SOCKET_DIR;
    process.env.AGENT_BROWSER_SOCKET_DIR = stateDir;
    const { host, closes } = await bridgeWithTabs(7, 8);
    try {
      const key = realSessionKey("env-abc");
      writeBoundTarget(key, targetIdOfTab(8), stateDir);
      await closeSessionTab(key, null);
      expect(closes()).toEqual([8]);
    } finally {
      await host.close();
      if (prev === undefined) delete process.env.AGENT_BROWSER_SOCKET_DIR;
      else process.env.AGENT_BROWSER_SOCKET_DIR = prev;
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

describe("reapEngineOrphans in real mode", () => {
  let stateDir: string;
  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cast-reap-state-"));
  });
  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  const owners = (state: LivenessVerdict): LiveOwners => ({ panes: new Set(), session: () => state });
  const files = () => fs.readdirSync(stateDir).sort();

  test("a dead -real session with no daemon has its tab closed on the bridge and its files removed", async () => {
    const { host, closes } = await bridgeWithTabs(7, 8);
    try {
      const key = realSessionKey("env-gone");
      writeBoundTarget(key, targetIdOfTab(7), stateDir);
      fs.writeFileSync(path.join(stateDir, `${key}.config`), "{}");
      const report = await reapEngineOrphans({ force: true, stateDir, keep: null, live: owners("exited") });
      expect(closes()).toEqual([7]);
      expect(files()).toEqual([]);
      expect(report.cleaned).toEqual([key]);
      // A tab the reaper was not told about is the human's, and stays.
      expect(closes()).not.toContain(8);
    } finally {
      await host.close();
    }
  });

  test.each(["env-busy", engineSessionKey("pane:%12")])("a live owner %s is left alone, files and tab", async (session) => {
    const { host, closes } = await bridgeWithTabs(7);
    try {
      const key = realSessionKey(session);
      writeBoundTarget(key, targetIdOfTab(7), stateDir);
      const report = await reapEngineOrphans({ force: true, stateDir, keep: null, live: { ...owners("live"), panes: new Set(["%12"]) } });
      expect(closes()).toEqual([]);
      expect(files()).toEqual([`${key}.target`]);
      expect(report.cleaned).toEqual([]);
    } finally {
      await host.close();
    }
  });

  test("a live owner's tab undriven past the tab idle window is closed once, and its binding kept", async () => {
    const { host, closes } = await bridgeWithTabs(7, 8);
    try {
      const key = realSessionKey("env-busy");
      writeBoundTarget(key, targetIdOfTab(7), stateDir);
      const old = new Date(Date.now() - 31 * 60_000);
      fs.utimesSync(path.join(stateDir, `${key}.target`), old, old);
      const report = await reapEngineOrphans({ force: true, stateDir, keep: null, live: owners("live") });
      expect(closes()).toEqual([7]);
      expect(report.idled).toEqual([key]);
      // The binding stays, so the agent's next verb is told its tab is gone.
      expect(files()).toEqual([`${key}.target`]);
      expect(report.cleaned).toEqual([]);
      // Nothing left to close: a later pass reports nothing.
      expect((await reapEngineOrphans({ force: true, stateDir, keep: null, live: owners("live") })).idled).toEqual([]);
      expect(closes()).toEqual([7]);
    } finally {
      await host.close();
    }
  });

  test("a session the daemon just killed loses its tab and files at once, however recently it drove them", async () => {
    const { host, closes } = await bridgeWithTabs(7, 8);
    try {
      writeBoundTarget(realSessionKey("env-killed"), targetIdOfTab(7), stateDir);
      writeBoundTarget(realSessionKey("env-other"), targetIdOfTab(8), stateDir);
      const report = await reapEngineOrphans({ force: true, stateDir, keep: null, live: withEndedSession(owners("live"), "killed") });
      expect(closes()).toEqual([7]);
      expect(report.cleaned).toEqual([realSessionKey("env-killed")]);
      expect(files()).toEqual([`${realSessionKey("env-other")}.target`]);
    } finally {
      await host.close();
    }
  });

  test("keep protects both twins: the caller's clone key spares its dead -real session, and the reverse", async () => {
    const { host, closes } = await bridgeWithTabs(7, 8);
    try {
      writeBoundTarget(realSessionKey("env-me"), targetIdOfTab(7), stateDir);
      writeBoundTarget("env-me", targetIdOfTab(8), stateDir);
      await reapEngineOrphans({ force: true, stateDir, keep: "env-me", live: owners("exited") });
      expect(closes()).toEqual([]);
      expect(files()).toEqual(["env-me-real.target", "env-me.target"]);
      await reapEngineOrphans({ force: true, stateDir, keep: realSessionKey("env-me"), live: owners("exited") });
      expect(closes()).toEqual([]);
      // With nothing kept, both go.
      await reapEngineOrphans({ force: true, stateDir, keep: null, live: owners("exited") });
      expect(closes().sort()).toEqual([7]);
      expect(files()).toEqual([]);
    } finally {
      await host.close();
    }
  });
});

describe("sessionEndpoint", () => {
  test("a -real key closes its tab on a proven bridge host, with the token the host demands", async () => {
    const host = await testBridgeHost();
    try {
      expect(await sessionEndpoint(realSessionKey("env-abc"))).toEqual({ port: host.port, token: host.token });
    } finally {
      await host.close();
    }
  });

  test("a -real key with no bridge configured, or no host answering, has nowhere to close a tab", async () => {
    expect(await sessionEndpoint("env-abc-real")).toBeNull();
    writeBridgeState({ port: 1, token: "tok" });
    expect(await sessionEndpoint("env-abc-real")).toBeNull();
  });

  test("a plain key never reaches the bridge, even when one is configured", async () => {
    writeBridgeState({ port: 47123, token: "tok" });
    const ep = await sessionEndpoint("env-abc");
    // The managed browser's port from instance.json, or null when none runs
    // under this CODECAST_DIR; either way not the bridge.
    expect(ep === null || typeof ep === "number").toBe(true);
  });
});

describe("ownerState reads the agent off a -real key", () => {
  const live: LiveOwners = {
    panes: new Set(["%12"]),
    session: (id) => (id === "abc" ? "live" : "unverifiable"),
  };

  test("the same session id owns both its clone and its real session", () => {
    expect(ownerState("env-abc", live)).toBe("live");
    expect(ownerState("env-abc-real", live)).toBe("live");
    expect(ownerState("env-other-real", live)).toBe("unverifiable");
  });

  test("a pane key keeps working with the suffix", () => {
    expect(ownerState("pane--12", live)).toBe("live");
    expect(ownerState("pane--12-real", live)).toBe("live");
    expect(ownerState("pane--13-real", live)).toBe("exited");
  });

  test("the actual engine key of a live pane is never reaped", () => {
    const key = engineSessionKey("pane:%12");
    expect(key).toBe("pane-12");
    expect(ownerState(key, live)).toBe("live");
    expect(ownerState(realSessionKey(key), live)).toBe("live");
    expect(ownerState(realSessionKey(engineSessionKey("pane:%13")), live)).toBe("exited");
    expect(ownerState(realSessionKey(key), { ...live, panes: null })).toBe("unverifiable");
  });
});

describe("engineStateDir follows the engine's socket dir rule", () => {
  test("AGENT_BROWSER_SOCKET_DIR wins, then XDG_RUNTIME_DIR, then the home dir", () => {
    expect(engineStateDir({ AGENT_BROWSER_SOCKET_DIR: "/s", XDG_RUNTIME_DIR: "/x" })).toBe("/s");
    expect(engineStateDir({ AGENT_BROWSER_SOCKET_DIR: "", XDG_RUNTIME_DIR: "/x" })).toBe(path.join("/x", "agent-browser"));
    expect(engineStateDir({})).toBe(path.join(os.homedir(), ".agent-browser"));
  });
  test("AGENT_BROWSER_HOME is not a name the engine reads, so it must not move the state dir", () => {
    expect(engineStateDir({ AGENT_BROWSER_HOME: "/elsewhere" })).toBe(path.join(os.homedir(), ".agent-browser"));
  });
});

// `close` returns while the daemon is still exiting; a verb retried in that
// window dialled its removed socket ("Failed to connect: No such file or
// directory", soak ct-87421). The detach now returns only once the daemon is gone.
describe("detachSessionDaemon", () => {
  test("returns only after the daemon process has exited", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cast-detach-test-"));
    const prev = process.env.AGENT_BROWSER_SOCKET_DIR;
    process.env.AGENT_BROWSER_SOCKET_DIR = stateDir;
    try {
      // A daemon that is not our child (launchd reaps it), so a dead one is not a zombie we hold.
      const pid = Number(Bun.spawnSync(["sh", "-c", "sleep 30 >/dev/null 2>&1 & echo $!"]).stdout.toString().trim());
      fs.writeFileSync(path.join(stateDir, "env-detach-real.pid"), String(pid));
      // An engine whose `close` answers at once and lets the daemon exit a second later.
      const engine = path.join(stateDir, "fake-engine");
      fs.writeFileSync(engine, `#!/bin/sh\n[ "$1" = close ] || exit 1\n(sleep 1; kill $(cat "$AGENT_BROWSER_SOCKET_DIR/$AGENT_BROWSER_SESSION.pid")) >/dev/null 2>&1 &\nexit 0\n`, { mode: 0o755 });
      const started = Date.now();
      expect(detachSessionDaemon("env-detach-real", engine)).toBe(true);
      expect(Date.now() - started).toBeGreaterThanOrEqual(800);
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      if (prev === undefined) delete process.env.AGENT_BROWSER_SOCKET_DIR;
      else process.env.AGENT_BROWSER_SOCKET_DIR = prev;
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  }, 15_000);
});

// A session that works through named tabs keeps a default pin on a tab closed
// long ago; "open tab" for the session tries every pin, newest first.
describe("sessionPinnedTabs", () => {
  test("lists the session's default and named tabs in every browser, newest pin first, and nobody else's", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cast-pins-"));
    try {
      const mine = engineSessionKey("env:6e42ed88-c09b-42e6-929e-d7f61c3eb16c");
      const pin = (key: string, targetId: string, ageS: number) => {
        writeBoundTarget(key, targetId, stateDir);
        const at = new Date(Date.now() - ageS * 1000);
        fs.utimesSync(path.join(stateDir, `${key}.target`), at, at);
      };
      pin(realSessionKey(mine), "1E230A3E", 3000);
      pin(realSessionKey(withTabName(mine, "li")), "1E230F26", 2000);
      pin(realSessionKey(withTabName(mine, "litok")), "1E230F93", 1000);
      pin(mine, "CLONE0000000000000000000000000001", 4000);
      pin(realSessionKey(engineSessionKey("env:0fb19696-1663-4c95-be76-058e42af27fb")), "1E230000", 10);
      expect(sessionPinnedTabs(["session:6e42ed88-c09b-42e6-929e-d7f61c3eb16c", "env:6e42ed88-c09b-42e6-929e-d7f61c3eb16c"], stateDir)).toEqual([
        "1E230F93",
        "1E230F26",
        "1E230A3E",
        "CLONE0000000000000000000000000001",
      ]);
      expect(sessionPinnedTabs([], stateDir)).toEqual([]);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
