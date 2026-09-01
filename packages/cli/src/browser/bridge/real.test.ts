/**
 * Real-mode policy: sticky target precedence, tab ownership, and which tab a
 * caller may act on. File-backed, so each test runs against its own
 * CODECAST_DIR.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  bridgeEndpointIfConfigured, engineBrowserFor, isRealMode, ownedRealTab, pruneRealTabs, realTabOwnership, rememberRealTab,
  resolveRealTarget, setStickyTarget, splitTargetFlags, stickyTarget,
} from "./real.js";
import { writeBridgeState } from "./host.js";
import { isRealSession, realSessionKey } from "../engine.js";
import { tabIdOfTarget, targetIdOfTab } from "./protocol.js";

let dir: string;
let prevEnv: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cast-real-test-"));
  prevEnv = process.env.CODECAST_DIR;
  process.env.CODECAST_DIR = dir;
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env.CODECAST_DIR;
  else process.env.CODECAST_DIR = prevEnv;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("target id minting", () => {
  test("round-trips any 32-bit tab id through 8 hex chars", () => {
    for (const id of [0, 1, 255, 4096, 1234567890, 2147483647, 4294967295]) {
      const t = targetIdOfTab(id);
      expect(t).toMatch(/^[0-9A-F]{8}$/);
      expect(tabIdOfTarget(t)).toBe(id);
    }
    expect(tabIdOfTarget("not-a-target")).toBeNull();
    expect(tabIdOfTarget("0123456789ABCDEF")).toBeNull();
  });
});

describe("sticky target", () => {
  test("defaults to clone", () => {
    expect(stickyTarget("session:a")).toBe("clone");
    expect(isRealMode({}, "session:a")).toBe(false);
  });

  test("is per session, and a flag beats it in both directions", () => {
    setStickyTarget("session:a", "real");
    expect(isRealMode({}, "session:a")).toBe(true);
    expect(isRealMode({}, "session:b")).toBe(false);
    expect(isRealMode({ clone: true }, "session:a")).toBe(false);
    expect(isRealMode({ real: true }, "session:b")).toBe(true);
  });

  test("a keyless caller gets its own shared slot", () => {
    setStickyTarget(null, "real");
    expect(isRealMode({}, null)).toBe(true);
    expect(isRealMode({}, "session:a")).toBe(false);
  });
});

describe("real tab ownership", () => {
  const A = targetIdOfTab(11);
  const B = targetIdOfTab(22);

  test("remembers a tab per session and prunes dead ones", () => {
    rememberRealTab("session:a", A);
    rememberRealTab("session:b", B);
    expect(ownedRealTab("session:a")).toBe(A);
    expect(ownedRealTab("session:b")).toBe(B);

    pruneRealTabs(new Set([B]));
    expect(ownedRealTab("session:a")).toBeUndefined();
    expect(ownedRealTab("session:b")).toBe(B);
  });

  test("ownership marks mine vs another session's", () => {
    rememberRealTab("session:a", A);
    rememberRealTab("session:b", B);
    const { mine, others } = realTabOwnership("session:a");
    expect(mine).toBe(A);
    expect(others.has(B)).toBe(true);
    expect(others.has(A)).toBe(false);
  });
});

describe("resolveRealTarget", () => {
  const targets = [
    { targetId: targetIdOfTab(1), type: "page", title: "Human's mail", url: "https://mail.example/inbox" },
    { targetId: targetIdOfTab(2), type: "page", title: "Agent's page", url: "https://app.example/" },
  ];

  test("an agent session gets its own tab, never someone else's", () => {
    rememberRealTab("session:a", targetIdOfTab(2));
    expect(resolveRealTarget(targets, undefined, "session:a").targetId).toBe(targetIdOfTab(2));
    expect(() => resolveRealTarget(targets, undefined, "session:b")).toThrow(/no tab of its own/);
  });

  test("a keyless human gets the most recent tab", () => {
    expect(resolveRealTarget(targets, undefined, null).targetId).toBe(targetIdOfTab(2));
  });

  test("--tab matches id prefix (case-insensitive), url substring, then title", () => {
    expect(resolveRealTarget(targets, targetIdOfTab(1).slice(0, 4).toLowerCase(), "session:x").targetId).toBe(targetIdOfTab(1));
    expect(resolveRealTarget(targets, "app.example", "session:x").targetId).toBe(targetIdOfTab(2));
    expect(resolveRealTarget(targets, "human's mail", "session:x").targetId).toBe(targetIdOfTab(1));
    expect(() => resolveRealTarget(targets, "nope", "session:x")).toThrow(/no real-browser tab/);
  });
});

describe("target flags on a raw argument line", () => {
  test("--real and --clone come off the line, everything else stays in order", () => {
    expect(splitTargetFlags(["https://x", "--real", "--new-tab"])).toEqual({ real: true, clone: undefined, args: ["https://x", "--new-tab"] });
    expect(splitTargetFlags(["--clone", "snapshot", "-i"])).toEqual({ real: undefined, clone: true, args: ["snapshot", "-i"] });
    expect(splitTargetFlags(["tab", "list"])).toEqual({ real: undefined, clone: undefined, args: ["tab", "list"] });
  });

  test("what comes off the line is what isRealMode reads", () => {
    setStickyTarget("session:a", "real");
    expect(isRealMode(splitTargetFlags(["--clone"]), "session:a")).toBe(false);
    expect(isRealMode(splitTargetFlags([]), "session:a")).toBe(true);
    expect(isRealMode(splitTargetFlags(["--real"]), "session:b")).toBe(true);
  });
});

describe("the browser behind an engine session key", () => {
  test("a plain key drives the managed Chrome: no port, no socket", () => {
    expect(engineBrowserFor("env-abc")).toEqual({ session: "env-abc" });
  });

  test("a -real key drives the bridge: its port, and its socket URL carrying the token", () => {
    writeBridgeState({ port: 47123, token: "tok" });
    expect(engineBrowserFor(realSessionKey("env-abc"))).toEqual({
      session: "env-abc-real",
      port: 47123,
      cdp: "ws://127.0.0.1:47123/devtools/browser/tok",
    });
    expect(bridgeEndpointIfConfigured()).toEqual({ port: 47123, token: "tok" });
  });

  test("a -real key with no bridge set up is refused, never routed to the clone", () => {
    expect(() => engineBrowserFor("env-abc-real")).toThrow(/extension setup/);
    expect(bridgeEndpointIfConfigured()).toBeNull();
  });
});

describe("real session keys", () => {
  test("suffix once, never twice, and the key stays within the engine's length", () => {
    expect(realSessionKey("env-abc")).toBe("env-abc-real");
    expect(realSessionKey("env-abc-real")).toBe("env-abc-real");
    expect(isRealSession("env-abc-real")).toBe(true);
    expect(isRealSession("env-abc")).toBe(false);
    const long = realSessionKey("x".repeat(60));
    expect(long.length).toBe(60);
    expect(isRealSession(long)).toBe(true);
  });
});
