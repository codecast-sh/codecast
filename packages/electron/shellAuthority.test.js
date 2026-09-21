const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { harness, FakeWindow } = require("./mainTestRig");
const { createShellAuthority, installShellCapabilities } = require("./shellAuthority");

beforeEach(harness.setup);
afterEach(harness.teardown);

test("every real shell IPC handler rejects missing, foreign, subframe and unregistered senders", () => {
  const rig = harness.loadShell();
  const wc = rig.mainWindow.webContents;
  const unknown = new FakeWindow({}).webContents;
  const cases = [null, {}, { sender: wc }, { sender: wc, senderFrame: { url: "https://codecast.sh/" } }, { sender: unknown, senderFrame: unknown.mainFrame }];
  for (const [channel, handler] of rig.handlers) {
    for (const event of cases) {
      assert.ok(handler(event) == null, channel);
    }
  }
  wc.mainFrame.url = "https://foreign.invalid/";
  assert.equal(rig.handlers.get("get-app-version")(rig.event()), null);
  assert.equal(rig.handlers.get("voice-command")(rig.event(), "press"), null);
  wc.mainFrame.url = "https://codecast.sh/";
  assert.equal(rig.handlers.get("get-app-version")(rig.event()), "0.0.0-test");
});

test("registered window navigation cannot inherit privileges on a foreign document", () => {
  const rig = harness.loadShell();
  const event = { prevented: false, preventDefault() { this.prevented = true; } };
  rig.mainWindow.webContents.emit("will-navigate", event, "https://foreign.invalid");
  assert.equal(event.prevented, true);
  event.prevented = false;
  rig.mainWindow.webContents.emit("will-navigate", event, "https://codecast.sh/tasks");
  assert.equal(event.prevented, false);
  rig.mainWindow.loadURL("https://foreign.invalid/");
  assert.equal(rig.handlers.get("get-app-version")(rig.event()), null);
});

test("permission admission requires exact requesting origin, main frame and registered window", () => {
  const authority = createShellAuthority({ ipcMain: {}, origins: () => ["https://codecast.sh", "http://localhost:3200"], openExternal() {} });
  const win = authority.register(new FakeWindow({}));
  const good = { isMainFrame: true, requestingUrl: "https://codecast.sh/call-panel" };
  assert.equal(authority.permission(win.webContents, good, "https://codecast.sh"), true);
  for (const requestingUrl of ["https://foreign.invalid", "http://codecast.sh", "https://codecast.sh:444", "https://codecast.sh.evil.invalid", "data:text/html,x", "about:blank", "file:///tmp/x", "http://localhost:9999"]) {
    assert.equal(authority.permission(win.webContents, { ...good, requestingUrl }), false, requestingUrl);
  }
  assert.equal(authority.permission(null, good), false);
  assert.equal(authority.permission(new FakeWindow({}).webContents, good), false);
  assert.equal(authority.permission(win.webContents, { ...good, isMainFrame: false }), false);
  assert.equal(authority.permission(win.webContents, undefined), false);
  assert.equal(authority.permission(win.webContents, good, "null"), false);
  win.loadURL("http://localhost:3200/call-panel");
  assert.equal(authority.permission(win.webContents, { ...good, requestingUrl: win.url }, "http://localhost:3200"), true);
});

test("installed capability handlers deny before touching providers and keep screen selections per frame", async () => {
  const handlers = new Map();
  const authority = createShellAuthority({ ipcMain: { handle: (key, fn) => handlers.set(key, fn) }, origins: () => ["https://codecast.sh"], openExternal() {} });
  const a = authority.register(new FakeWindow({})).webContents;
  const b = authority.register(new FakeWindow({})).webContents;
  const callbacks = {};
  let reads = 0;
  installShellCapabilities({ authority,
    permissions: () => new Set(["media", "clipboard-read", "display-capture"]),
    session: {
      setPermissionRequestHandler: (fn) => callbacks.request = fn,
      setPermissionCheckHandler: (fn) => callbacks.check = fn,
      setDisplayMediaRequestHandler: (fn) => callbacks.display = fn,
    },
    desktopCapturer: { getSources: async () => { reads++; return [{ id: "screen:1" }, { id: "window:2" }]; } },
  });
  const details = { isMainFrame: true, requestingUrl: a.mainFrame.url };
  assert.equal(callbacks.check(a, "media", "https://codecast.sh", details), true);
  for (const [wc, frameDetails] of [[null, details], [a, undefined], [a, { ...details, isMainFrame: false }], [a, { ...details, requestingUrl: "https://evil.invalid" }]]) {
    let allowed = true;
    callbacks.request(wc, "clipboard-read", (value) => allowed = value, frameDetails);
    assert.equal(allowed, false);
    assert.equal(callbacks.check(wc, "media", "https://codecast.sh", frameDetails), false);
  }
  const display = (frame, securityOrigin = "https://codecast.sh") => new Promise(resolve => callbacks.display({ frame, securityOrigin, audioRequested: false }, resolve));
  for (const frame of [null, { url: "https://codecast.sh/" }, { url: "https://evil.invalid" }]) assert.deepEqual(await display(frame), {});
  assert.deepEqual(await display(a.mainFrame, "null"), {});
  assert.equal(reads, 0);
  handlers.get("select-display-source")({ sender: a, senderFrame: a.mainFrame }, "window:2");
  assert.equal((await display(b.mainFrame)).video.id, "screen:1");
  assert.equal((await display(a.mainFrame)).video.id, "window:2");
  assert.equal((await display(a.mainFrame)).video.id, "screen:1");
  const pending = display(a.mainFrame);
  a.mainFrame.url += "?navigated=1";
  assert.deepEqual(await pending, {});
});
