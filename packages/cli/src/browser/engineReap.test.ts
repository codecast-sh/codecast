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
import { closeSessionTab, closeTargetLater, ownerState, reapEngineOrphans, sessionEndpoint, type LiveOwners } from "./engineReap.js";
import { writeBridgeState } from "./bridge/host.js";
import { FakeExtension, testBridgeHost } from "./bridge/host.testutil.js";
import { targetIdOfTab } from "./bridge/protocol.js";
import { engineStateDir, realSessionKey } from "./engine.js";
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

  const owners = (state: "alive" | "dead" | "unknown"): LiveOwners => ({ panes: new Set(), session: () => state });
  const files = () => fs.readdirSync(stateDir).sort();

  test("a dead -real session with no daemon has its tab closed on the bridge and its files removed", async () => {
    const { host, closes } = await bridgeWithTabs(7, 8);
    try {
      const key = realSessionKey("env-gone");
      writeBoundTarget(key, targetIdOfTab(7), stateDir);
      fs.writeFileSync(path.join(stateDir, `${key}.config`), "{}");
      const report = await reapEngineOrphans({ force: true, stateDir, keep: null, live: owners("dead") });
      expect(closes()).toEqual([7]);
      expect(files()).toEqual([]);
      expect(report.cleaned).toEqual([key]);
      // A tab the reaper was not told about is the human's, and stays.
      expect(closes()).not.toContain(8);
    } finally {
      await host.close();
    }
  });

  test("a live owner is left alone, files and tab", async () => {
    const { host, closes } = await bridgeWithTabs(7);
    try {
      const key = realSessionKey("env-busy");
      writeBoundTarget(key, targetIdOfTab(7), stateDir);
      const report = await reapEngineOrphans({ force: true, stateDir, keep: null, live: owners("alive") });
      expect(closes()).toEqual([]);
      expect(files()).toEqual([`${key}.target`]);
      expect(report.cleaned).toEqual([]);
    } finally {
      await host.close();
    }
  });

  test("keep protects both twins: the caller's clone key spares its dead -real session, and the reverse", async () => {
    const { host, closes } = await bridgeWithTabs(7, 8);
    try {
      writeBoundTarget(realSessionKey("env-me"), targetIdOfTab(7), stateDir);
      writeBoundTarget("env-me", targetIdOfTab(8), stateDir);
      await reapEngineOrphans({ force: true, stateDir, keep: "env-me", live: owners("dead") });
      expect(closes()).toEqual([]);
      expect(files()).toEqual(["env-me-real.target", "env-me.target"]);
      await reapEngineOrphans({ force: true, stateDir, keep: realSessionKey("env-me"), live: owners("dead") });
      expect(closes()).toEqual([]);
      // With nothing kept, both go.
      await reapEngineOrphans({ force: true, stateDir, keep: null, live: owners("dead") });
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
    session: (id) => (id === "abc" ? "alive" : "unknown"),
  };

  test("the same session id owns both its clone and its real session", () => {
    expect(ownerState("env-abc", live)).toBe("alive");
    expect(ownerState("env-abc-real", live)).toBe("alive");
    expect(ownerState("env-other-real", live)).toBe("unknown");
  });

  test("a pane key keeps working with the suffix", () => {
    expect(ownerState("pane--12", live)).toBe("alive");
    expect(ownerState("pane--12-real", live)).toBe("alive");
    expect(ownerState("pane--13-real", live)).toBe("dead");
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
