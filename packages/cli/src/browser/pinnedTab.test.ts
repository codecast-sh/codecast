import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  pinnedTabBrowser, readBoundTarget, sessionDaemonPid, sessionTabGroup, sessionTabGroupColor, sessionTabGroupTitle, writeBoundTarget,
} from "./pinnedTab.js";
import { writeBridgeState } from "./bridge/host.js";
import { testBridgeHost } from "./bridge/host.testutil.js";

const TARGET = "2BE86883491FD502B8D986C164423006";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pinned-tab-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("writeBoundTarget", () => {
  test("writes the shape tab_binding.rs reads: targetId, url, pinned", () => {
    writeBoundTarget("env-abc", TARGET, dir);
    const raw = JSON.parse(fs.readFileSync(path.join(dir, "env-abc.target"), "utf-8"));
    expect(raw).toEqual({ targetId: TARGET, url: "about:blank", pinned: true });
  });

  test("replaces a stale binding in place, leaving no temp file", () => {
    writeBoundTarget("env-abc", "OLD", dir);
    writeBoundTarget("env-abc", TARGET, dir);
    expect(readBoundTarget("env-abc", dir)).toBe(TARGET);
    expect(fs.readdirSync(dir)).toEqual(["env-abc.target"]);
  });
});

describe("readBoundTarget", () => {
  test("round-trips what writeBoundTarget wrote", () => {
    writeBoundTarget("env-abc", TARGET, dir);
    expect(readBoundTarget("env-abc", dir)).toBe(TARGET);
  });

  test("null for a missing, corrupt, or empty-id binding", () => {
    expect(readBoundTarget("nope", dir)).toBeNull();
    fs.writeFileSync(path.join(dir, "bad.target"), "not json");
    expect(readBoundTarget("bad", dir)).toBeNull();
    fs.writeFileSync(path.join(dir, "empty.target"), JSON.stringify({ targetId: "" }));
    expect(readBoundTarget("empty", dir)).toBeNull();
  });
});

describe("sessionDaemonPid", () => {
  test("a live pid is reported, a dead or missing one is null", () => {
    fs.writeFileSync(path.join(dir, "live.pid"), String(process.pid));
    expect(sessionDaemonPid("live", dir)).toBe(process.pid);
    // Pid 1 is launchd/init: alive but not ours — EPERM still counts as alive,
    // which is the isPidAlive contract, so use an impossible pid for "dead".
    fs.writeFileSync(path.join(dir, "dead.pid"), "999999999");
    expect(sessionDaemonPid("dead", dir)).toBeNull();
    expect(sessionDaemonPid("missing", dir)).toBeNull();
  });
});

describe("pinnedTabBrowser", () => {
  let home: string;
  let prevEnv: string | undefined;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "pinned-tab-home-"));
    prevEnv = process.env.CODECAST_DIR;
    process.env.CODECAST_DIR = home;
  });
  afterEach(() => {
    if (prevEnv === undefined) delete process.env.CODECAST_DIR;
    else process.env.CODECAST_DIR = prevEnv;
    fs.rmSync(home, { recursive: true, force: true });
  });

  test("a -real session pins into a proven bridge host, in the background, under the session's tab group", async () => {
    const host = await testBridgeHost();
    try {
      expect(await pinnedTabBrowser("env-1234567890-real")).toEqual({
        endpoint: { port: host.port, token: host.token },
        create: { url: "about:blank", background: true, castGroup: sessionTabGroup("env-1234567890-real") },
      });
      expect(sessionTabGroup("env-1234567890-real").title).toBe("cast 1234567");
    } finally {
      await host.close();
    }
  });

  test("a -real session with no bridge set up, or no host answering, pins nowhere", async () => {
    expect(await pinnedTabBrowser("env-abc-real")).toBeNull();
    writeBridgeState({ port: 1, token: "tok" });
    expect(await pinnedTabBrowser("env-abc-real")).toBeNull();
  });

  test("a plain session never pins into the bridge", async () => {
    writeBridgeState({ port: 47123, token: "tok" });
    // No managed browser runs under this CODECAST_DIR, so there is nothing to
    // pin into; the point is that the bridge is not offered instead.
    expect(await pinnedTabBrowser("env-abc")).toBeNull();
  });
});

describe("sessionTabGroupTitle", () => {
  test("names the group after the session id, with or without the real suffix", () => {
    expect(sessionTabGroupTitle("env-941b0bbd-1234-real")).toBe("cast 941b0bb");
    expect(sessionTabGroupTitle("session-941b0bbd")).toBe("cast 941b0bb");
    expect(sessionTabGroupTitle("default")).toBe("cast default");
  });

  test("a tmux pane is named as a pane, never as a bare number that looks like a session id", () => {
    expect(sessionTabGroupTitle("pane--12-real")).toBe("cast pane 12");
    expect(sessionTabGroupTitle("pane--12")).toBe("cast pane 12");
  });
});

describe("sessionTabGroupColor", () => {
  test("is stable for a session, the same in both modes, and never grey", () => {
    const c = sessionTabGroupColor("env-941b0bbd-1234");
    expect(sessionTabGroupColor("env-941b0bbd-1234-real")).toBe(c);
    expect(c).not.toBe("grey");
  });

  test("spreads sessions over the palette", () => {
    const seen = new Set(Array.from({ length: 40 }, (_, i) => sessionTabGroupColor(`env-session-${i}`)));
    expect(seen.size).toBeGreaterThan(4);
  });
});
