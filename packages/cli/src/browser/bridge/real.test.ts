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
  bridgeEndpointIfConfigured, engineBrowserFor, explicitTarget, extensionReady, isRealMode, ownedRealTab, pruneRealTabs, realModeHint, realTabOwnership, rememberRealTab,
  resolveRealTarget, setStickyTarget, splitTargetFlags, stickyTarget,
} from "./real.js";
import * as http from "node:http";
import { writeBridgeState } from "./host.js";
import { testBridgeHost } from "./host.testutil.js";
import { freePort } from "../instance.js";
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

  test("the human's Chrome is the default while the extension is connected, and the choice settles per session", () => {
    // A live host (this process stands in for it) holding the extension.
    writeBridgeState({ port: 41999, token: "t".repeat(64), hostPid: process.pid, extensionConnected: true, extensionSeenAt: Date.now() });
    expect(extensionReady()).toBe(true);
    expect(explicitTarget("session:a")).toBeNull();
    expect(stickyTarget("session:a")).toBe("real");
    expect(isRealMode({}, "session:a")).toBe(true);
    // Settled: the extension going away does not move a session that already chose.
    expect(explicitTarget("session:a")).toBe("real");
    writeBridgeState({ port: 41999, token: "t".repeat(64), hostPid: process.pid, extensionConnected: false, extensionSeenAt: Date.now() });
    expect(extensionReady()).toBe(false);
    expect(isRealMode({}, "session:a")).toBe(true);
    expect(isRealMode({}, "session:b")).toBe(false);
    // A clone default is never written: the session moves over when the extension comes.
    expect(explicitTarget("session:b")).toBeNull();
  });

  test("a dead host never makes the real Chrome the default", () => {
    writeBridgeState({ port: 41999, token: "t".repeat(64), hostPid: 2 ** 22 + 12345, extensionConnected: true, extensionSeenAt: Date.now() });
    expect(extensionReady()).toBe(false);
    expect(stickyTarget("session:a")).toBe("clone");
  });

  test("the sign-in hint names the step that fits the bridge's state", () => {
    expect(realModeHint("session:a")).toContain("cast browser extension setup");
    writeBridgeState({ port: 41999, token: "t".repeat(64), hostPid: 2 ** 22 + 12345, extensionConnected: false, extensionSeenAt: Date.now() });
    expect(realModeHint("session:a")).toContain("not connected right now");
    // A session that settled on the clone before the extension came is told the way over.
    setStickyTarget("session:a", "clone");
    writeBridgeState({ port: 41999, token: "t".repeat(64), hostPid: process.pid, extensionConnected: true, extensionSeenAt: Date.now() });
    expect(realModeHint("session:a")).toContain("cast browser target real");
    // A fresh session defaults to the real Chrome, so it needs no hint; neither does one that chose it.
    expect(realModeHint("session:b")).toBeNull();
    setStickyTarget("session:a", "real");
    expect(realModeHint("session:a")).toBeNull();
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
  test("a plain key drives the managed Chrome: no socket", async () => {
    expect(await engineBrowserFor("env-abc")).toEqual({ session: "env-abc" });
  });

  test("a -real key drives a PROVEN bridge host: its socket URL carrying the token", async () => {
    const host = await testBridgeHost();
    try {
      expect(await engineBrowserFor(realSessionKey("env-abc"))).toEqual({
        session: "env-abc-real",
        cdp: `ws://127.0.0.1:${host.port}/devtools/browser/${host.token}`,
      });
      expect(await bridgeEndpointIfConfigured()).toEqual({ port: host.port, token: host.token });
    } finally {
      await host.close();
    }
  });

  test("a -real key with no bridge set up is refused, never routed to the clone", async () => {
    await expect(engineBrowserFor("env-abc-real")).rejects.toThrow(/extension setup/);
    expect(await bridgeEndpointIfConfigured()).toBeNull();
  });

  test("a -real key whose host is down, or squatted by a server that cannot prove the token, never gets the token", async () => {
    const port = await freePort();
    writeBridgeState({ port, token: "t".repeat(64) });
    await expect(engineBrowserFor("env-abc-real")).rejects.toThrow(/no bridge host is answering/);
    expect(await bridgeEndpointIfConfigured()).toBeNull();

    // A squatter that knows what a healthz body looks like, but not the token.
    const seen: string[] = [];
    const squatter = http.createServer((req, res) => {
      seen.push(req.url ?? "");
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("cast-bridge protocol=4 proof=" + "0".repeat(64));
    });
    await new Promise<void>((r) => squatter.listen(port, "127.0.0.1", r));
    try {
      await expect(engineBrowserFor("env-abc-real")).rejects.toThrow(/cannot prove it holds the token/);
      expect(await bridgeEndpointIfConfigured()).toBeNull();
      // Everything it ever saw was a nonce; the token was never presented.
      expect(seen.length).toBeGreaterThan(0);
      for (const url of seen) expect(url).toMatch(/^\/healthz\?nonce=[0-9a-f]{64}$/);
    } finally {
      await new Promise<void>((r) => squatter.close(() => r()));
    }
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
