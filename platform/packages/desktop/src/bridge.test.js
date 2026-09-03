const { test, expect } = require("bun:test");
const { createBridge, bufferedChannel, argValue, BRIDGE_METHODS } = require("./bridge");

// An ipcRenderer stand-in: records invokes/sends and lets the test push events.
function fakeIpc() {
  const listeners = new Map();
  const calls = [];
  return {
    calls,
    on(ch, fn) { listeners.set(ch, [...(listeners.get(ch) || []), fn]); },
    removeListener(ch, fn) { listeners.set(ch, (listeners.get(ch) || []).filter((f) => f !== fn)); },
    invoke(ch, ...args) { calls.push(["invoke", ch, ...args]); return Promise.resolve(ch); },
    send(ch, ...args) { calls.push(["send", ch, ...args]); },
    emit(ch, payload) { for (const fn of listeners.get(ch) || []) fn({}, payload); },
    count(ch) { return (listeners.get(ch) || []).length; },
  };
}

test("buffered channel replays events that arrived before subscribe, once", () => {
  const ipc = fakeIpc();
  const onDeepLink = bufferedChannel(ipc, "deep-link");
  ipc.emit("deep-link", "a://1");
  ipc.emit("deep-link", "a://2");
  const got = [];
  onDeepLink((u) => got.push(u));
  expect(got).toEqual(["a://1", "a://2"]);
  ipc.emit("deep-link", "a://3");
  expect(got).toEqual(["a://1", "a://2", "a://3"]);
  // Re-subscribing does not stack listeners or replay old events.
  const got2 = [];
  onDeepLink((u) => got2.push(u));
  expect(got2).toEqual([]);
  expect(ipc.count("deep-link")).toBe(1);
});

test("latest-only channel replays just the most recent state", () => {
  const ipc = fakeIpc();
  const onStatus = bufferedChannel(ipc, "update-status", { latest: true });
  ipc.emit("update-status", { status: "downloading", percent: 10 });
  ipc.emit("update-status", { status: "ready" });
  const got = [];
  onStatus((s) => got.push(s));
  expect(got).toEqual([{ status: "ready" }]);
});

test("the bridge exposes the full method surface and reads argv flags", () => {
  const ipc = fakeIpc();
  const b = createBridge({ ipcRenderer: ipc, argv: ["--tab-window", "--bridge-global=__X__"], platform: "darwin" });
  expect(b.isTabWindow).toBe(true);
  expect(b.platform).toBe("darwin");
  expect(argValue(["--bridge-global=__X__"], "bridge-global")).toBe("__X__");
  expect(argValue([], "bridge-global")).toBeNull();
  for (const m of ["getVersion", "onDeepLink", "onUpdateStatus", "showNotification", "reportWindowState", "onWindowRole",
    "getShortcutConfig", "paletteReady", "composeSubmit", "openExternal", "getSystemIdleSeconds", "getDisplaySources",
    "selectDisplaySource", "hostPolicy", "detachTab", "attachTab", "onAdoptTab"]) {
    expect(BRIDGE_METHODS).toContain(m);
  }
  b.showNotification("t", "b", { key: "k" });
  b.hostPolicy();
  b.reportWindowState({ active: "/x" });
  expect(ipc.calls).toEqual([
    ["invoke", "show-notification", { title: "t", body: "b", data: { key: "k" } }],
    ["invoke", "host-policy", null],
    ["send", "report-window-state", { active: "/x" }],
  ]);
});

test("window role keeps the latest push for late subscribers; palette listeners unsubscribe", () => {
  const ipc = fakeIpc();
  const b = createBridge({ ipcRenderer: ipc, argv: [] });
  ipc.emit("window-role", { leader: true, appFocused: false, anyInCall: false });
  const roles = [];
  b.onWindowRole((r) => roles.push(r));
  expect(roles).toEqual([{ leader: true, appFocused: false, anyInCall: false }]);
  let shows = 0;
  const off = b.onPaletteShow(() => shows++);
  ipc.emit("palette-show");
  off();
  ipc.emit("palette-show");
  expect(shows).toBe(1);
});

test("call and subscribe use the app: prefix and unsubscribe cleanly", async () => {
  const ipc = fakeIpc();
  const bridge = createBridge({ ipcRenderer: ipc, argv: [] });
  expect(await bridge.call("permissions", 1, 2)).toBe("app:permissions");
  expect(ipc.calls.at(-1)).toEqual(["invoke", "app:permissions", 1, 2]);
  const got = [];
  const off = bridge.subscribe("permissions-changed", (p) => got.push(p));
  ipc.emit("app:permissions-changed", { fda: "granted" });
  off();
  ipc.emit("app:permissions-changed", { fda: "off" });
  expect(got).toEqual([{ fda: "granted" }]);
  expect(BRIDGE_METHODS).toContain("call");
  expect(BRIDGE_METHODS).toContain("subscribe");
});
