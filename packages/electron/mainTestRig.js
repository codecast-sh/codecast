// The stand-in Electron that main.js is exercised against.
//
// Shared by every *.main.test.js: main.js decides window construction options
// and a handful of runtime calls that must move together (float,
// click-through, resizable, bounds), and all of them are ordinary function
// calls — so the tests load main.js with this recorder in Electron's place
// and read what it asked for.
//
// No window is ever created: `BrowserWindow` here is a recorder. That is the
// point — a window a test opened would be a window somebody could see.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const MAIN = require.resolve("./main.js");
const ELECTRON = require.resolve("electron");

/** Every call a BrowserWindow was asked to make, in order. */
class FakeWindow {
  static nextId = 1;
  constructor(options) {
    this.options = options;
    this.calls = [];
    this.destroyed = false;
    this.events = new Map();
    this.bounds = {
      x: options.x ?? 0,
      y: options.y ?? 0,
      width: options.width ?? 0,
      height: options.height ?? 0,
    };
    this.contentSize = [this.bounds.width, this.bounds.height];
    this.resizable = options.resizable !== false;
    this.zoom = options.webPreferences?.zoomFactor ?? 1;
    // Real windows are born hidden when `show: false` and only appear on
    // show()/showInactive(); the faces overlay's yield depends on this.
    this.visible = options.show !== false;
    this.webContents = {
      id: FakeWindow.nextId++,
      isDestroyed: () => false,
      on: () => {},
      send: () => {},
      setZoomFactor: (z) => {
        this.zoom = z;
      },
      getZoomFactor: () => this.zoom,
      executeJavaScript: () => Promise.resolve(),
      setWindowOpenHandler: () => {},
      getURL: () => "https://codecast.sh/",
      reloadIgnoringCache: () => {},
      openDevTools: () => {},
      session: { clearCache: () => Promise.resolve() },
    };
  }
  record(name, ...args) {
    this.calls.push([name, ...args]);
  }
  did(name) {
    return this.calls.filter((c) => c[0] === name).map((c) => c.slice(1));
  }
  last(name) {
    const all = this.did(name);
    return all.length ? all[all.length - 1] : null;
  }
  isDestroyed() {
    return this.destroyed;
  }
  isMinimized() {
    return false;
  }
  isFocused() {
    return false;
  }
  isVisible() {
    return this.visible;
  }
  restore() {}
  hide() {
    this.record("hide");
    this.visible = false;
  }
  setTitle() {}
  on(event, cb) {
    this.events.set(event, cb);
  }
  once(event, cb) {
    this.events.set(event, cb);
  }
  emit(event, ...args) {
    this.events.get(event)?.(...args);
  }
  loadURL(url) {
    this.record("loadURL", url);
  }
  show() {
    this.record("show");
    this.visible = true;
  }
  showInactive() {
    this.record("showInactive");
    this.visible = true;
  }
  focus() {
    this.record("focus");
  }
  close() {
    this.record("close");
    const ev = {
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
    };
    this.emit("close", ev);
    if (ev.defaultPrevented) return;
    this.destroyed = true;
    this.emit("closed");
  }
  setResizable(on) {
    this.resizable = on;
    this.record("setResizable", on);
  }
  isResizable() {
    return this.resizable;
  }
  setAlwaysOnTop(on, level) {
    this.record("setAlwaysOnTop", on, level);
  }
  isAlwaysOnTop() {
    const l = this.last("setAlwaysOnTop");
    return !!(l && l[0]);
  }
  setVisibleOnAllWorkspaces(on, opts) {
    this.record("setVisibleOnAllWorkspaces", on, opts);
  }
  setIgnoreMouseEvents(on, opts) {
    this.record("setIgnoreMouseEvents", on, opts);
  }
  setMinimumSize(w, h) {
    this.record("setMinimumSize", w, h);
  }
  setBounds(b) {
    this.record("setBounds", b);
    if (!this.resizable) throw new Error("setBounds on a non-resizable window");
    this.bounds = { ...this.bounds, ...b };
  }
  getBounds() {
    return { ...this.bounds };
  }
  setContentSize(w, h) {
    this.record("setContentSize", w, h);
    if (!this.resizable) throw new Error("setContentSize on a non-resizable window");
    this.contentSize = [w, h];
    this.bounds = { ...this.bounds, width: w, height: h };
  }
  getContentSize() {
    return [...this.contentSize];
  }
  getSize() {
    return [this.bounds.width, this.bounds.height];
  }
  setPosition(x, y) {
    this.record("setPosition", x, y);
    this.bounds = { ...this.bounds, x, y };
  }
  getPosition() {
    return [this.bounds.x, this.bounds.y];
  }
}

const cursorReads = { count: 0 };

function fakeElectron() {
  const windows = [];
  const handlers = new Map();
  const listeners = new Map();
  const app = {
    name: "",
    setPath: () => {},
    getPath: () => harness.userData,
    commandLine: { appendSwitch: () => {} },
    on: (event, cb) => listeners.set(event, cb),
    once: () => {},
    whenReady: () => new Promise(() => {}),
    getVersion: () => "0.0.0-test",
    setAboutPanelOptions: () => {},
    isPackaged: false,
    dock: { setIcon: () => {} },
    requestSingleInstanceLock: () => true,
    setAsDefaultProtocolClient: () => {},
  };
  const BrowserWindow = class extends FakeWindow {
    constructor(options) {
      super(options);
      windows.push(this);
    }
    static getAllWindows() {
      return windows.filter((w) => !w.destroyed);
    }
    static fromWebContents(wc) {
      return windows.find((w) => w.webContents === wc) ?? null;
    }
  };
  const noop = () => {};
  const electron = {
    app,
    BrowserWindow,
    Menu: { buildFromTemplate: () => ({}), setApplicationMenu: noop },
    Tray: class {
      setToolTip() {}
      setContextMenu() {}
      on() {}
    },
    globalShortcut: { register: () => true, unregisterAll: noop },
    ipcMain: {
      handle: (channel, cb) => handlers.set(channel, cb),
      on: (channel, cb) => handlers.set(channel, cb),
      removeHandler: (channel) => handlers.delete(channel),
    },
    nativeImage: { createFromPath: () => ({ setTemplateImage: noop, isEmpty: () => true }) },
    shell: { openExternal: noop, showItemInFolder: noop },
    screen: {
      getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1600, height: 1000 } }),
      getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1600, height: 1000 } }),
      getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1600, height: 1000 }, scaleFactor: 2 }),
      getCursorScreenPoint: () => {
        cursorReads.count += 1;
        return { x: 400, y: 400 };
      },
      on: noop,
    },
    Notification: class {
      static isSupported() {
        return false;
      }
    },
    session: { defaultSession: { setPermissionRequestHandler: noop, webRequest: { onHeadersReceived: noop } } },
    powerMonitor: { on: noop },
    desktopCapturer: { getSources: async () => [] },
  };
  return { electron, windows, handlers, listeners };
}

/**
 * The per-test lifecycle, owned here so every main-process test file runs the
 * same way: a fresh temp userData per test, main.js re-required against the
 * stand-in, and every timer the shell started stopped on the way out (they
 * belong to a process that normally lives for hours).
 */
const timers = [];
const harness = {
  userData: null,

  setup() {
    harness.userData = fs.mkdtempSync(path.join(os.tmpdir(), "codecast-mainrig-"));
  },

  teardown() {
    while (timers.length) timers.pop()();
    delete require.cache[MAIN];
    delete require.cache[ELECTRON];
    fs.rmSync(harness.userData, { recursive: true, force: true });
  },

  /**
   * Load main.js against the stand-in, from a clean settings file, and make
   * the main window the way the shell itself does — `activate` is the app's
   * own "there is no window, make one" path.
   */
  loadShell(settings = {}) {
    const rig = fakeElectron();
    fs.writeFileSync(path.join(harness.userData, "settings.json"), JSON.stringify(settings));
    require.cache[ELECTRON] = { id: ELECTRON, filename: ELECTRON, loaded: true, exports: rig.electron };
    delete require.cache[MAIN];
    const realInterval = globalThis.setInterval;
    const realTimeout = globalThis.setTimeout;
    globalThis.setInterval = (...args) => {
      const t = realInterval(...args);
      timers.push(() => clearInterval(t));
      return t;
    };
    globalThis.setTimeout = (...args) => {
      const t = realTimeout(...args);
      timers.push(() => clearTimeout(t));
      return t;
    };
    try {
      require(MAIN);
      rig.listeners.get("activate")();
    } finally {
      globalThis.setInterval = realInterval;
      globalThis.setTimeout = realTimeout;
    }
    rig.mainWindow = rig.windows[rig.windows.length - 1];
    return rig;
  },

  readSettings() {
    return JSON.parse(fs.readFileSync(path.join(harness.userData, "settings.json"), "utf8"));
  },
};

/** The call window, opened the way the renderer opens it. */
function openCallWindow(rig, room = "dm:a:b", opts = { mic: true }) {
  rig.handlers.get("open-call-panel")(null, room, opts);
  const win = rig.windows[rig.windows.length - 1];
  const sender = { sender: win.webContents };
  return { win, sender };
}

/** The faces overlay, opened the way the people window's button opens it. */
function openFacesWindow(rig) {
  rig.handlers.get("open-faces-window")(null);
  const win = rig.windows[rig.windows.length - 1];
  const sender = { sender: win.webContents };
  return { win, sender };
}

module.exports = { FakeWindow, fakeElectron, harness, cursorReads, openCallWindow, openFacesWindow };
