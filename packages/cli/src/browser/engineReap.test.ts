/**
 * Which browser the reaper reaches for a session's tab, and whose session a
 * key names. File-backed state lives under a per-test CODECAST_DIR.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ownerState, sessionEndpoint, type LiveOwners } from "./engineReap.js";
import { writeBridgeState } from "./bridge/host.js";
import { engineStateDir, realSessionKey } from "./engine.js";

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

describe("sessionEndpoint", () => {
  test("a -real key closes its tab on the bridge, with the token the host demands", () => {
    writeBridgeState({ port: 47123, token: "tok" });
    expect(sessionEndpoint(realSessionKey("env-abc"))).toEqual({ port: 47123, token: "tok" });
  });

  test("a -real key with no bridge configured has nowhere to close a tab", () => {
    expect(sessionEndpoint("env-abc-real")).toBeNull();
  });

  test("a plain key never reaches the bridge, even when one is configured", () => {
    writeBridgeState({ port: 47123, token: "tok" });
    const ep = sessionEndpoint("env-abc");
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
