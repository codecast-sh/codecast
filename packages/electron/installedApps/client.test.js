// Run: node --test packages/electron/installedApps/client.test.js
//
// The page client in a bare JS context with each transport faked. The real
// renderer, with castData's runtime beside it, is appPreload.sandbox.test.js.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { clientSource } = require("./protocol");

function load(win) {
  const context = vm.createContext({ setTimeout, Promise, Error, Object, Array, String });
  context.window = context;
  Object.assign(context, win);
  vm.runInContext(clientSource(), context);
  return context;
}

// An Electron-style transport whose replies the test scripts.
function electron(reply) {
  const sent = [];
  let sink = null;
  const transport = {
    call: async (msg) => (sent.push(msg), reply(msg)),
    onEvent: (cb) => (sink = cb),
  };
  return { transport, sent, push: (ev) => sink(ev) };
}

test("no transport, no cast.app: a browser tab sees undefined", () => {
  const w = load({ cast: { data() {} } });
  assert.equal(w.cast.app, undefined);
  assert.equal(typeof w.cast.data, "function");
});

test("cast.app joins an existing window.cast without replacing it", () => {
  const { transport } = electron(() => ({ ok: true, value: null }));
  const data = () => "data";
  const w = load({ __castAppTransport: transport, cast: { data, __data: true } });
  assert.equal(w.cast.data, data);
  assert.equal(w.cast.__data, true);
  assert.equal(typeof w.cast.app.info, "function");
  // castData's own merge (window.cast = window.cast || {}) running afterwards keeps it.
  vm.runInContext("window.cast = window.cast || {}; window.cast.data = function () {};", w);
  assert.equal(typeof w.cast.app.notify, "function");
  // Not replaceable from the page by accident.
  assert.throws(() => vm.runInContext('"use strict"; window.cast.app = {};', w));
  assert.throws(() => vm.runInContext('"use strict"; window.cast.app.fs.readText = null;', w));
});

test("calls go out as {id, module, method, args} and resolve to the value", async () => {
  const { transport, sent } = electron((msg) => ({ id: msg.id, ok: true, value: { echoed: msg.method } }));
  const w = load({ __castAppTransport: transport });
  assert.deepEqual(await w.cast.app.window.setSize(400, 600), { echoed: "setSize" });
  await w.cast.app.process.run("ls", undefined, undefined);
  await w.cast.app.info();
  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [
    { id: "c1", module: "window", method: "setSize", args: [400, 600] },
    { id: "c2", module: "process", method: "run", args: ["ls"] },
    { id: "c3", module: "app", method: "info", args: [] },
  ]);
});

test("a refusal rejects with an Error whose .code is the code; a broken transport is failed", async () => {
  let mode = "refuse";
  const { transport } = electron((msg) => {
    if (mode === "throw") throw new Error("ipc gone");
    if (mode === "empty") return undefined;
    return { id: msg.id, ok: false, code: "needs-consent", message: "ask first" };
  });
  const w = load({ __castAppTransport: transport });
  const rejectsWith = async (p, code, message) => {
    const err = await p.then(() => null, (e) => e);
    assert.ok(err instanceof w.Error, "not an Error");
    assert.equal(err.code, code);
    if (message) assert.equal(err.message, message);
  };
  await rejectsWith(w.cast.app.notify({ title: "t" }), "needs-consent", "ask first");
  mode = "throw";
  await rejectsWith(w.cast.app.badge(1), "failed", "ipc gone");
  mode = "empty";
  await rejectsWith(w.cast.app.badge(1), "failed");
});

test("host events reach on() listeners until off(); a throwing listener does not stop the rest", async () => {
  const { transport, push } = electron(() => ({ ok: true }));
  const w = load({ __castAppTransport: transport });
  const got = [];
  const thrown = [];
  const loud = () => {
    throw new Error("listener bug");
  };
  w.setTimeout = (fn) => {
    try {
      fn();
    } catch (e) {
      thrown.push(e.message);
    }
  };
  const a = (d) => got.push(["a", d]);
  w.cast.app.on("shortcut", loud);
  const stop = w.cast.app.on("shortcut", a);
  w.cast.app.on("tray-click", (d) => got.push(["tray", d]));
  push({ event: "shortcut", data: { accelerator: "CmdOrCtrl+Shift+K" } });
  push({ event: "tray-click", data: {} });
  push(null);
  stop();
  push({ event: "shortcut", data: { accelerator: "x" } });
  assert.deepEqual(JSON.parse(JSON.stringify(got)), [
    ["a", { accelerator: "CmdOrCtrl+Shift+K" }],
    ["tray", {}],
  ]);
  assert.deepEqual(thrown, ["listener bug", "listener bug"]);
});

test("fs.watch routes fs-change to its own callback and the returned stop unwatches", async () => {
  const { transport, sent, push } = electron((msg) => ({ id: msg.id, ok: true, value: msg.method === "watch" ? "w9" : true }));
  const w = load({ __castAppTransport: transport });
  const seen = [];
  const stop = await w.cast.app.fs.watch("/tmp/x", (change) => seen.push(change.path));
  push({ event: "fs-change", data: { watchId: "w9", type: "change", path: "/tmp/x/a" } });
  push({ event: "fs-change", data: { watchId: "w1", type: "change", path: "/elsewhere" } });
  assert.equal(await stop(), true);
  push({ event: "fs-change", data: { watchId: "w9", type: "change", path: "/tmp/x/b" } });
  assert.deepEqual(seen, ["/tmp/x/a"]);
  assert.deepEqual(JSON.parse(JSON.stringify(sent.map((m) => [m.method, m.args]))), [["watch", ["/tmp/x"]], ["unwatch", ["w9"]]]);
  const err = await w.cast.app.fs.watch("/tmp/x").then(() => null, (e) => e);
  assert.equal(err.code, "bad-args");
});

test("WKWebView: calls ride postMessage's reply and the shim pushes events through __castAppEvent", async () => {
  const posted = [];
  const w = load({
    webkit: {
      messageHandlers: {
        castApp: { postMessage: async (msg) => (posted.push(msg), { id: msg.id, ok: true, value: "from-shim" }) },
      },
    },
  });
  assert.equal(await w.cast.app.tray.set({ title: "3" }), "from-shim");
  assert.deepEqual(JSON.parse(JSON.stringify(posted)), [{ id: "c1", module: "tray", method: "set", args: [{ title: "3" }] }]);
  const got = [];
  w.cast.app.on("version", (d) => got.push(d.version));
  w.__castAppEvent({ event: "version", data: { version: 5 } });
  assert.deepEqual(got, [5]);
});

test("Electron's transport wins when both exist, and a second run changes nothing", async () => {
  const { transport, sent } = electron((msg) => ({ id: msg.id, ok: true, value: "electron" }));
  const w = load({ __castAppTransport: transport, webkit: { messageHandlers: { castApp: { postMessage: () => "webkit" } } } });
  const first = w.cast.app;
  vm.runInContext(clientSource(), w);
  assert.equal(w.cast.app, first);
  assert.equal(await w.cast.app.info(), "electron");
  assert.equal(sent.length, 1);
});
