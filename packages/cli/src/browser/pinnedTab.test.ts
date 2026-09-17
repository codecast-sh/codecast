import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import {
  ensurePinnedTab, pickReclaimableTab, pinnedTabBrowser, readBoundTarget, sessionDaemonPid,
  tabHolderIsSelf, targetLiveness, writeBoundTarget, type CastTab,
} from "./pinnedTab.js";
import { writeBridgeState } from "./bridge/host.js";
import { CAST_TAB_GROUP } from "./bridge/protocol.js";
import { FakeExtension, testBridgeHost } from "./bridge/host.testutil.js";

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
      // The endpoint names the session so the host files the tab under it.
      expect(await pinnedTabBrowser("env-1234567890-real")).toEqual({
        endpoint: { port: host.port, token: host.token, session: "env-1234567890-real" },
        create: { url: "about:blank", background: true, castGroup: CAST_TAB_GROUP },
      });
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

describe("targetLiveness", () => {
  /** A /json/list that answers after `delayMs` with the given tab ids. */
  async function listServer(ids: string[], delayMs = 0): Promise<{ port: number; close: () => void }> {
    const srv = http.createServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(ids.map((id) => ({ id, type: "page", url: "about:blank" }))));
      }, delayMs);
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    return { port: (srv.address() as { port: number }).port, close: () => srv.closeAllConnections?.() ?? srv.close() };
  }

  test("alive when the browser lists the tab, gone when it lists others", async () => {
    const s = await listServer(["AAAA0001"]);
    expect(await targetLiveness(s.port, "AAAA0001")).toBe("alive");
    expect(await targetLiveness(s.port, "AAAA0002")).toBe("gone");
    s.close();
  });

  // A slow list read as "gone" made ensurePinnedTab open a blank tab beside
  // the live one on every slow check, orphaning the old tab.
  test("unknown, never gone, when the list is slower than the deadline or nothing answers", async () => {
    const slow = await listServer(["AAAA0001"], 300);
    expect(await targetLiveness(slow.port, "AAAA0002", 50)).toBe("unknown");
    slow.close();
    const dead = await listServer([]);
    dead.close();
    expect(await targetLiveness(dead.port, "AAAA0001", 200)).toBe("unknown");
  });
});

describe("page creation", () => {
  let previousSocketDir: string | undefined;
  beforeEach(() => {
    previousSocketDir = process.env.AGENT_BROWSER_SOCKET_DIR;
    process.env.AGENT_BROWSER_SOCKET_DIR = dir;
  });
  afterEach(() => {
    if (previousSocketDir === undefined) delete process.env.AGENT_BROWSER_SOCKET_DIR;
    else process.env.AGENT_BROWSER_SOCKET_DIR = previousSocketDir;
  });

  test("a command with no page never creates a blank placeholder", async () => {
    const host = await testBridgeHost();
    const extension = await new FakeExtension([]).connect(host.port);
    try {
      await expect(ensurePinnedTab("env-empty-real")).rejects.toThrow("No blank tab was created");
      expect(extension.seen.filter((m) => m.op === "tabs.create")).toHaveLength(0);
      expect(extension.tabs).toHaveLength(0);
    } finally {
      extension.ws.close();
      await host.close();
    }
  });

  test("open creates the requested URL in the background and reuses it without attaching", async () => {
    const host = await testBridgeHost();
    const extension = await new FakeExtension([]).connect(host.port);
    const session = "env-page-real";
    const url = "https://example.com/requested";
    try {
      expect(await ensurePinnedTab(session, url)).toBe(true);
      const first = readBoundTarget(session);
      expect(await ensurePinnedTab(session)).toBe(false);
      fs.rmSync(path.join(dir, `${session}.target`));
      expect(await ensurePinnedTab(session, url)).toBe(false);
      expect(readBoundTarget(session)).toBe(first);
      expect(extension.seen.filter((m) => m.op === "tabs.create")).toMatchObject([{ url, background: true }]);
      expect(extension.seen.filter((m) => m.op === "attach")).toHaveLength(0);
      expect(extension.tabs.map((tab) => tab.url)).toEqual([url]);
      expect(JSON.parse(fs.readFileSync(path.join(dir, `${session}.target`), "utf8")).url).toBe(url);
    } finally {
      extension.ws.close();
      await host.close();
    }
  });
});

describe("pickReclaimableTab", () => {
  const url = "http://localhost:3200/conversation/jx7abc";
  const session = "env-grok-real";
  const tab = (targetId: string, sessions: string[], href = url): CastTab => ({ targetId, url: href, sessions });

  test("a tab this session already holds, including an older pane identity, is reused", () => {
    const env = { TMUX_PANE: "%921" };
    const tabs = [tab("AAAA", ["env-other-real"]), tab("BBBB", ["pane-921-real"])];
    expect(pickReclaimableTab(tabs, url, session, () => false, env)?.targetId).toBe("BBBB");
  });

  test("a harness twin of this session is treated as ours", () => {
    expect(tabHolderIsSelf("env-01a0abcd-real", "env-other-real", { GROK_SESSION_ID: "01a0abcd" })).toBe(true);
    expect(tabHolderIsSelf("env-stranger-real", "env-other-real", { GROK_SESSION_ID: "01a0abcd" })).toBe(false);
  });

  test("an unowned Cast tab on the same URL is claimed", () => {
    expect(pickReclaimableTab([tab("FREE", [])], url, session, () => false)?.targetId).toBe("FREE");
  });

  test("a tab whose every holder has exited is claimed", () => {
    expect(pickReclaimableTab([tab("DEAD", ["pane-66-real"])], url, session, (h) => h === "pane-66-real")?.targetId).toBe("DEAD");
  });

  test("a live stranger's tab on the same URL is never taken", () => {
    expect(pickReclaimableTab([tab("LIVE", ["env-other-real"])], url, session, () => false)).toBeNull();
  });

  test("a tab on a different URL is ignored even if unowned", () => {
    expect(pickReclaimableTab([tab("X", [], "https://example.com/")], url, session, () => true)).toBeNull();
  });
});
