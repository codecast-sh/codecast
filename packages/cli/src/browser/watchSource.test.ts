import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { engineSessionKey, paneSessionKey, realSessionKey } from "./engine.js";
import { cdpWatchEngine, resolveEngineTab, type CdpEngineDeps } from "./watchSource.js";
import type { InstanceState } from "./instance.js";

const CLONE = 58489;
const BRIDGE = { port: 41729, token: "t0k" };
const OWNER = "env:509b4b48-c521-4352-bf19-eafa153745bb";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "watch-src-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function pin(key: string, targetId: string, mtimeMs: number): void {
  const file = path.join(dir, `${key}.target`);
  fs.writeFileSync(file, JSON.stringify({ targetId, url: "https://example.com", pinned: true }));
  fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
}

const cloneState = (): InstanceState => ({ pid: 1, port: CLONE, userDataDir: "/x", headless: false, sourceProfile: null, channel: "stable", startedAt: 0 } as unknown as InstanceState);

describe("resolveEngineTab", () => {
  test("a session driving the human's Chrome resolves to its bridge tab", () => {
    pin(realSessionKey(engineSessionKey(OWNER)), "1E21CD78", 2_000);
    expect(resolveEngineTab([OWNER], { clone: CLONE, bridge: BRIDGE }, dir)).toEqual({ tabId: "1E21CD78", endpoint: BRIDGE });
  });

  test("with pins in both browsers the most recent one is the tab being driven", () => {
    pin(engineSessionKey(OWNER), "CLONETAB", 1_000);
    pin(realSessionKey(engineSessionKey(OWNER)), "1E21CD78", 2_000);
    expect(resolveEngineTab([OWNER], { clone: CLONE, bridge: BRIDGE }, dir)?.tabId).toBe("1E21CD78");
    pin(engineSessionKey(OWNER), "CLONETAB", 3_000);
    expect(resolveEngineTab([OWNER], { clone: CLONE, bridge: BRIDGE }, dir)).toEqual({ tabId: "CLONETAB", endpoint: CLONE });
  });

  test("a pin in a browser that is not up does not count", () => {
    pin(realSessionKey(engineSessionKey(OWNER)), "1E21CD78", 2_000);
    expect(resolveEngineTab([OWNER], { clone: CLONE, bridge: null }, dir)).toBeNull();
  });

  test("nothing pinned resolves to nothing", () => {
    expect(resolveEngineTab([OWNER, "pane:%1"], { clone: CLONE, bridge: BRIDGE }, dir)).toBeNull();
  });
});

describe("cdpWatchEngine with the bridge", () => {
  const deps = (over: Partial<CdpEngineDeps>): CdpEngineDeps => ({
    getState: () => null,
    getBridge: () => BRIDGE,
    stateDir: dir,
    connect: async () => {
      throw new Error("not dialed in this test");
    },
    listTargets: async () => [],
    ...over,
  });

  test("no clone running, real tab pinned: resolves, and opens on the bridge endpoint", async () => {
    pin(realSessionKey(engineSessionKey(OWNER)), "1E21CD78", 2_000);
    const dialed: unknown[] = [];
    const engine = cdpWatchEngine(
      deps({
        connect: async (ep) => {
          dialed.push(ep);
          throw new Error("stop here");
        },
      }),
    );
    expect(engine.resolveTab([OWNER])).toEqual({ tabId: "1E21CD78" });
    const ac = new AbortController();
    await expect(
      engine.open("1E21CD78", { minIntervalMs: 100, shouldHold: () => false, quality: 50, maxWidth: 10, maxHeight: 10, signal: ac.signal }, { onFrame() {}, onTab() {}, onGone() {} }),
    ).rejects.toThrow("stop here");
    expect(dialed).toEqual([BRIDGE]);
  });

  test("no clone, live bridge, nothing pinned: the session has no tab, the browser is not missing", () => {
    expect(cdpWatchEngine(deps({})).resolveTab([OWNER])).toEqual({ error: "no-tab" });
  });

  test("no clone and no bridge: no browser", () => {
    expect(cdpWatchEngine(deps({ getBridge: () => null })).resolveTab([OWNER])).toEqual({ error: "no-browser" });
  });

  test("the built-in driver's own claim still wins when the engine pinned nothing", () => {
    const engine = cdpWatchEngine(deps({ getState: () => ({ ...cloneState(), tabsBySession: { [OWNER]: "OWNED" } }) }));
    expect(engine.resolveTab([OWNER])).toEqual({ tabId: "OWNED" });
  });
});

describe("the desktop pane as a third browser", () => {
  const PANE = { endpoint: 9444, targets: new Set(["PANE1"]) };

  test("the pane pin wins while it is the newest, and only while the registry still lists its target", () => {
    pin(realSessionKey(engineSessionKey(OWNER)), "1E21CD78", 2_000);
    pin(paneSessionKey(engineSessionKey(OWNER)), "PANE1", 3_000);
    expect(resolveEngineTab([OWNER], { clone: CLONE, bridge: BRIDGE, pane: PANE }, dir)).toEqual({ tabId: "PANE1", endpoint: 9444 });
    // The human closed the pane: the registry no longer vouches for it.
    expect(resolveEngineTab([OWNER], { clone: CLONE, bridge: BRIDGE, pane: { endpoint: 9444, targets: new Set() } }, dir)?.tabId).toBe("1E21CD78");
    // The app is not up at all.
    expect(resolveEngineTab([OWNER], { clone: CLONE, bridge: BRIDGE, pane: null }, dir)?.tabId).toBe("1E21CD78");
    // The session moved back to its Chrome tab (touchBoundTarget on each verb).
    pin(realSessionKey(engineSessionKey(OWNER)), "1E21CD78", 4_000);
    expect(resolveEngineTab([OWNER], { clone: CLONE, bridge: BRIDGE, pane: PANE }, dir)?.tabId).toBe("1E21CD78");
  });

  test("cdpWatchEngine streams the pane from the app's port, and an app with no pane for this session is 'no tab'", async () => {
    pin(paneSessionKey(engineSessionKey(OWNER)), "PANE1", 3_000);
    const dialed: unknown[] = [];
    const engine = cdpWatchEngine({
      getState: () => null,
      getBridge: () => null,
      getDesktopPane: () => PANE,
      stateDir: dir,
      connect: async (endpoint) => {
        dialed.push(endpoint);
        throw new Error("dialed");
      },
      listTargets: async () => [],
    });
    expect(engine.resolveTab([OWNER])).toEqual({ tabId: "PANE1" });
    await expect(
      engine.open("PANE1", { minIntervalMs: 300, shouldHold: () => false, quality: 50, maxWidth: 1, maxHeight: 1, signal: new AbortController().signal }, { onFrame() {}, onTab() {}, onGone() {} }),
    ).rejects.toThrow("dialed");
    expect(dialed).toEqual([9444]);
    expect(engine.resolveTab(["session:someone-else"])).toEqual({ error: "no-tab" });
  });
});
