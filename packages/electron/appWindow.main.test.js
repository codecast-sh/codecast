const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { harness } = require("./mainTestRig");

beforeEach(harness.setup);
afterEach(harness.teardown);

function lastRole(win) {
  const sent = win.webContents.sent.filter(([ch]) => ch === "window-role");
  return sent.length ? sent[sent.length - 1][1] : null;
}

// The rig's webContents.send is a no-op; record what each window was told.
function recordSends(rig) {
  for (const win of rig.windows) {
    if (win.webContents.sent) continue;
    win.webContents.sent = [];
    win.webContents.send = (...args) => win.webContents.sent.push(args);
  }
}

function navigations(win) {
  return win.webContents.ran.map((js) => {
    const m = js.match(/codecast-navigate', \{ detail: (.*) \}\)\)/);
    return m ? JSON.parse(m[1]) : null;
  }).filter(Boolean);
}

function recordJs(win) {
  win.webContents.ran = [];
  win.webContents.executeJavaScript = (js) => {
    win.webContents.ran.push(js);
    return Promise.resolve();
  };
}

test("opening an app window loads its home with the app flag; a second open raises and navigates the same window", async () => {
  const rig = harness.loadShell();
  const created = rig.windows.length;
  rig.handlers.get("open-app-window")(null, "chat");
  assert.equal(rig.windows.length, created + 1);
  const chat = rig.windows.at(-1);
  assert.ok(chat.options.webPreferences.additionalArguments.includes("--app-window=chat"));
  assert.ok(chat.options.webPreferences.additionalArguments.includes("--tab-window"));
  assert.deepEqual(chat.last("loadURL"), ["https://codecast.sh/chat"]);
  chat.emit("ready-to-show");
  assert.equal(chat.isVisible(), true);

  recordJs(chat);
  rig.handlers.get("open-app-window")(null, "chat", "/chat/ch1");
  assert.equal(rig.windows.length, created + 1);
  assert.deepEqual(navigations(chat), [{ path: "/chat/ch1", tabId: null, placed: true }]);
  assert.ok(chat.did("focus").length >= 1);

  assert.equal(rig.handlers.get("open-app-window")(null, "people"), false);
  assert.equal(rig.windows.length, created + 1);
});

test("an app window opens on the path it was asked for and remembers its bounds", async () => {
  const rig = harness.loadShell();
  rig.handlers.get("open-app-window")(null, "work", "/tasks/ct-1");
  const work = rig.windows.at(-1);
  assert.deepEqual(work.last("loadURL"), ["https://codecast.sh/tasks/ct-1"]);
  work.bounds = { x: 300, y: 200, width: 900, height: 700 };
  work.emit("close", { defaultPrevented: false, preventDefault() {} });
  assert.deepEqual(harness.readSettings().appWindows.work.bounds, { x: 300, y: 200, width: 900, height: 700 });
  work.destroy();

  rig.handlers.get("open-app-window")(null, "work");
  const again = rig.windows.at(-1);
  assert.notEqual(again, work);
  assert.deepEqual(again.last("setBounds"), [{ x: 300, y: 200, width: 900, height: 700 }]);
});

test("the window role says which app windows exist, and closing one clears it", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const rig = harness.loadShell();
  recordSends(rig);
  rig.handlers.get("open-app-window")(null, "chat");
  recordSends(rig);
  t.mock.timers.tick(50);
  assert.deepEqual(lastRole(rig.mainWindow).apps, { chat: true });
  const chat = rig.windows.at(-1);
  chat.destroy();
  t.mock.timers.tick(50);
  assert.deepEqual(lastRole(rig.mainWindow).apps, {});
});

test("route-navigate lands a chat path in the Chat window and a session in the main window", async () => {
  const rig = harness.loadShell();
  recordJs(rig.mainWindow);
  rig.handlers.get("open-app-window")(null, "chat");
  const chat = rig.windows.at(-1);
  recordJs(chat);

  // From the main window: chat goes to the Chat window.
  rig.handlers.get("route-navigate")({ sender: rig.mainWindow.webContents }, "/chat/ch1?m=1");
  assert.deepEqual(navigations(chat), [{ path: "/chat/ch1?m=1", tabId: null, placed: true }]);
  assert.deepEqual(navigations(rig.mainWindow), []);

  // From the Chat window: a session goes to the main window; a task, with no
  // Work window, goes to the main window too.
  rig.handlers.get("route-navigate")({ sender: chat.webContents }, "/conversation/c1");
  rig.handlers.get("route-navigate")({ sender: chat.webContents }, "/tasks/ct-1");
  assert.deepEqual(navigations(rig.mainWindow).map((n) => n.path), ["/conversation/c1", "/tasks/ct-1"]);
  assert.ok(rig.mainWindow.did("focus").length >= 2);

  // A stray absolute URL never rides the channel.
  assert.equal(rig.handlers.get("route-navigate")({ sender: chat.webContents }, "https://evil"), false);
});

test("detaching a chat path opens the Chat window rather than a plain breakout", async () => {
  const rig = harness.loadShell();
  const created = rig.windows.length;
  rig.handlers.get("detach-tab")(null, "/chat/ch1");
  const win = rig.windows.at(-1);
  assert.equal(rig.windows.length, created + 1);
  assert.ok(win.options.webPreferences.additionalArguments.includes("--app-window=chat"));
  assert.deepEqual(win.last("loadURL"), ["https://codecast.sh/chat/ch1"]);
  // The same path again raises it: no second window.
  rig.handlers.get("detach-tab")(null, "/chat/ch2");
  assert.equal(rig.windows.length, created + 1);
});

test("a banner for a chat route lands in the Chat window even when the main window shows that channel", async () => {
  const rig = harness.loadShell();
  rig.handlers.get("open-app-window")(null, "chat");
  const chat = rig.windows.at(-1);
  recordJs(chat);
  recordJs(rig.mainWindow);
  const report = rig.handlers.get("report-window-state");
  report({ sender: rig.mainWindow.webContents }, { active: "/chat/ch1", open: [], inCall: false });
  report({ sender: chat.webContents }, { active: "/chat/ch2", open: [], inCall: false });
  const { pickWindow } = require("./notificationRouter");
  const windows = [
    { id: rig.mainWindow.id ?? 1, isMain: true, app: null, active: "/chat/ch1", open: [] },
    { id: 2, isMain: false, app: "chat", active: "/chat/ch2", open: [] },
  ];
  assert.equal(pickWindow(windows, { route: "/chat/ch1", kind: "chat" }).window.app, "chat");
  assert.equal(pickWindow(windows, { route: "/conversation/c1", kind: "session_idle" }).window.isMain, true);
});

test("a deep link for a work path lands in the Work window when one exists", async () => {
  const rig = harness.loadShell();
  recordSends(rig);
  rig.handlers.get("open-app-window")(null, "work");
  const work = rig.windows.at(-1);
  recordSends(rig);
  rig.listeners.get("open-url")?.({ preventDefault() {} }, "codecast://open/tasks/ct-9");
  const got = work.webContents.sent.filter(([ch]) => ch === "deep-link").map(([, url]) => url);
  assert.deepEqual(got, ["codecast://open/tasks/ct-9"]);
  assert.equal(rig.mainWindow.webContents.sent.some(([ch]) => ch === "deep-link"), false);
});

test("an app window claims the warm spare: no new window, told what it is before it navigates, then shown", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const rig = harness.loadShell();
  rig.mainWindow.webContents.emit("did-finish-load");
  t.mock.timers.tick(6000);
  const spare = rig.windows.at(-1);
  assert.notEqual(spare, rig.mainWindow);
  spare.webContents.emit("did-finish-load");

  // One ordered log of what the spare was told and asked to run.
  const log = [];
  spare.webContents.send = (ch, payload) => log.push(["send", ch, payload]);
  spare.webContents.executeJavaScript = (js) => {
    log.push(["run", js]);
    return Promise.resolve();
  };

  const created = rig.windows.length;
  rig.handlers.get("open-app-window")(null, "work", "/docs");
  // The claim builds no window of its own (the NEXT spare warms on a timer).
  assert.equal(rig.windows.length, created);

  const role = log.findIndex(([kind, ch, payload]) => kind === "send" && ch === "window-role" && payload.app === "work");
  const nav = log.findIndex(([kind, js]) => kind === "run" && js.includes("codecast-navigate") && js.includes('"/docs"'));
  assert.ok(role !== -1, "the claimed spare is told it is the Work window");
  assert.ok(nav !== -1, "the claimed spare is navigated to the path");
  assert.ok(role < nav, "identity arrives before the navigation");
  assert.deepEqual(log[role][2].apps, { work: true });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(spare.isVisible(), true);

  // It is the Work window from here on: a second open raises it.
  rig.handlers.get("open-app-window")(null, "work");
  assert.equal(rig.windows.length, created);
});

test("a deep link for a chat path reaches the Chat window even with the main window closed", async () => {
  const rig = harness.loadShell();
  recordSends(rig);
  rig.handlers.get("open-app-window")(null, "chat");
  const chat = rig.windows.at(-1);
  recordSends(rig);
  rig.mainWindow.destroy();
  const before = rig.windows.length;
  rig.listeners.get("open-url")({ preventDefault() {} }, "codecast://open/chat/ch1");
  assert.deepEqual(chat.webContents.sent.filter(([ch]) => ch === "deep-link").map(([, u]) => u), ["codecast://open/chat/ch1"]);
  // No main window was booted for a link the Chat window could show.
  assert.equal(rig.windows.length, before);
  // A session link with no main window is held for the one the app's
  // activation boots, as it always was, and lands there on load.
  rig.listeners.get("open-url")({ preventDefault() {} }, "codecast://open/conversation/c1");
  assert.equal(rig.windows.length, before);
  rig.listeners.get("activate")();
  const main = rig.windows.at(-1);
  recordSends(rig);
  main.webContents.emit("did-finish-load");
  assert.deepEqual(main.webContents.sent.filter(([ch]) => ch === "deep-link").map(([, u]) => u), ["codecast://open/conversation/c1"]);
  assert.equal(chat.webContents.sent.filter(([ch]) => ch === "deep-link").length, 1);
});

test("first open lands beside the main window when the display has room, else cascades", async () => {
  const rig = harness.loadShell();
  rig.mainWindow.bounds = { x: 0, y: 0, width: 400, height: 300 };
  rig.handlers.get("open-app-window")(null, "chat");
  assert.deepEqual(rig.windows.at(-1).last("setPosition"), [412, 0]);
  rig.mainWindow.bounds = { x: 0, y: 0, width: 1500, height: 900 };
  rig.handlers.get("open-app-window")(null, "work");
  assert.deepEqual(rig.windows.at(-1).last("setPosition"), [60, 60]);
});

test("moving an app window's page into the main window closes the app window", async () => {
  const rig = harness.loadShell();
  recordSends(rig);
  rig.handlers.get("open-app-window")(null, "work");
  const work = rig.windows.at(-1);
  rig.handlers.get("attach-tab")({ sender: work.webContents }, "/tasks/ct-1");
  assert.deepEqual(rig.mainWindow.webContents.sent.filter(([ch]) => ch === "adopt-tab").map(([, p]) => p), ["/tasks/ct-1"]);
  assert.equal(work.isDestroyed(), true);
});
