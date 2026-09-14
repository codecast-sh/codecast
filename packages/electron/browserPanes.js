// The browser pane's native half: a real Chromium view, placed over the rect a
// pane occupies in the app window.
//
// Why a view and not a frame. The web app already shows a page in an iframe,
// and that is the right default — it works in every browser. But a site that
// sends X-Frame-Options or frame-ancestors simply refuses, and most of the web
// a developer cares about (GitHub, cloud consoles, dashboards) refuses. A
// WebContentsView is not being framed at all: it is a browser view the shell
// owns, so every site loads, each pane can open its own devtools, and the CDP
// port this app already exposes can drive the exact pixels the human sees.
//
// What it costs, and why the renderer has work to do. The view paints ABOVE
// the DOM — it is a native layer, not an element — so anything the app draws
// over the pane (the palette, a menu, a drag veil, a modal) would be painted
// under it. The renderer therefore hides the view whenever an overlay is up
// (packages/web/lib/nativeOverlayGuard.ts), and this module hides it for the
// cases only the shell can see: a minimized window, a hidden window, a host
// renderer that navigated away.
//
// The wire. Nothing here needs a new preload surface: the shared bridge
// already carries app-defined IPC (platform/packages/desktop/src/bridge.js) —
// `call(name, ...args)` reaches `ipcMain.handle("app:" + name)`, and
// `subscribe(name, cb)` receives what main sends on "app:" + name. So the
// renderer speaks one command channel, "browser-pane", and listens on the
// same name for events about its panes.

"use strict";

// One partition for every pane in every window. A person opening two panes
// expects one browser, not two strangers: a sign-in in the first pane is a
// sign-in in the second, and a site that set a cookie yesterday is still
// signed in today ("persist:" makes it survive a restart).
//
// It is deliberately NOT the app's default session. A pane holds arbitrary
// third-party pages, and they must never see the cookies, the storage or the
// permission grants that belong to codecast itself.
const PANE_PARTITION = "persist:browser-pane";

// The one channel name, in both directions: the renderer invokes it with a
// command, and main sends pane events back on it. Different IPC mechanisms
// (invoke/handle vs send/on), so one name carries both without collision.
const CHANNEL = "browser-pane";
// A probe with no side effects: the renderer asks whether this build has the
// native view at all, and an older shell answers by rejecting the invoke (no
// handler registered), which is exactly the "not available" it needs.
const CAPABILITIES_CHANNEL = "browser-pane-capabilities";

// The keys a page inside the view never gets to keep: they belong to the app
// around it. Everything else — Cmd+C, Cmd+F, Cmd+Z, the page's own chords —
// stays in the page, because the person clicked into that page on purpose.
//   l  the address strip        r  reload the pane
//   k  the command palette
const APP_CHORD_KEYS = new Set(["l", "r", "k"]);

// ---------------------------------------------------------------------------
// The pane registry: how `cast browser` finds a pane on the app's CDP port.
//
// The app already opens a Chrome DevTools Protocol port on loopback (main.js,
// CODECAST_CDP_PORT; 9333 from source). Every WebContents in the app is a
// target on that port, a pane's view included, so an agent can drive the very
// view the human is looking at with no screencast and no second browser. What
// the port does not say is WHICH target is which pane, or which session the
// human opened it for. This file says that: one JSON document under the CLI's
// own config dir, rewritten whenever a pane is created, navigates or goes.
//
// Why a file and not an HTTP endpoint on the app. An endpoint would be a new
// listener with a new token to mint, store and check, and it would still only
// be as safe as the CDP port beside it — a process that can reach the port can
// already drive every window. The port is the boundary the app has accepted;
// the file adds nothing to the boundary, only a name for what is behind it.
// It is 0600 in a 0700 directory, same as the CLI's other browser state, and
// it carries this process's pid so a reader can tell a stale file from a live
// app without dialing the port.
//
// No port, no file: a packaged app without CODECAST_CDP_PORT cannot be driven,
// so it advertises nothing, and removes what an earlier run left behind.
const REGISTRY_VERSION = 1;
const REGISTRY_FILE = "desktop-panes.json";

/** Where the CLI keeps browser state: `$CODECAST_DIR/browser`, else
 *  `~/.codecast/browser` (packages/cli/src/browser/profile.ts browserHome). */
function defaultRegistryPath() {
  const os = require("os");
  const path = require("path");
  const root = process.env.CODECAST_DIR || path.join(process.env.HOME || os.homedir(), ".codecast");
  return path.join(root, "browser", REGISTRY_FILE);
}

/**
 * The document the registry holds for a set of panes. Pure, so the shape is
 * testable apart from the file: `panes` are the manager's records, and only
 * the fields an agent needs to find and own a view go out.
 */
function registryDocument(panes, { port, pid = process.pid, now = Date.now() } = {}) {
  return {
    version: REGISTRY_VERSION,
    port: Number(port),
    pid,
    updatedAt: now,
    panes: [...panes]
      .filter((p) => !(p.view?.webContents?.isDestroyed?.() ?? false))
      .map((p) => ({
        paneId: p.paneId,
        hostId: p.hostId,
        targetId: p.targetId ?? null,
        url: p.url ?? null,
        session: p.session ?? null,
      })),
  };
}

/**
 * Write the registry atomically, owner-only. A null document removes the file
 * (no port to advertise). Never throws: the registry is a courtesy to the CLI,
 * and a full disk must not take the pane down with it.
 */
function writeRegistryFile(file, doc) {
  const fs = require("fs");
  const path = require("path");
  try {
    if (!doc) {
      fs.rmSync(file, { force: true });
      return true;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/** A session key as the registry stores it: the CLI's owner ids are uuids and
 *  harness ids, so anything outside that alphabet is not one. */
function cleanSessionKey(session) {
  if (typeof session !== "string") return null;
  const s = session.trim();
  return /^[A-Za-z0-9_.:%-]{1,80}$/.test(s) ? s : null;
}

/**
 * Where a pane's rect lands in the window, in the coordinates a view wants.
 *
 * The renderer measures in CSS pixels (getBoundingClientRect) inside a window
 * that may be zoomed; a view is placed in device-independent pixels relative
 * to the window's content area. So the rect scales by the window's zoom factor
 * and is then clipped to the content area — a pane scrolled half out of the
 * window must not paint over the window's edge.
 *
 * Both edges are rounded, never the size separately: rounding width and height
 * on their own lets the view drift a pixel away from the strip above it at
 * fractional zooms, and that gap is visible.
 */
function paneViewBounds(rect, { zoomFactor = 1, contentWidth = 0, contentHeight = 0 } = {}) {
  const zoom = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;
  const left = Math.round((rect?.x ?? 0) * zoom);
  const top = Math.round((rect?.y ?? 0) * zoom);
  const right = Math.round(((rect?.x ?? 0) + (rect?.width ?? 0)) * zoom);
  const bottom = Math.round(((rect?.y ?? 0) + (rect?.height ?? 0)) * zoom);
  const clamp = (v, max) => Math.max(0, Math.min(v, Math.max(0, max)));
  const x = clamp(left, contentWidth);
  const y = clamp(top, contentHeight);
  return {
    x,
    y,
    width: Math.max(0, clamp(right, contentWidth) - x),
    height: Math.max(0, clamp(bottom, contentHeight) - y),
  };
}

/** A rect with nothing in it cannot be shown: a pane in a collapsed split, or
 *  one scrolled entirely out of the window. */
function isEmptyBounds(b) {
  return !b || b.width < 1 || b.height < 1;
}

/**
 * The panes manager. Every Electron dependency is injected so the whole thing
 * can be exercised without an Electron process (browserPanes.test.js).
 *
 * `isTrusted(webContents)` is the shell's own origin policy, passed in rather
 * than restated here: only a first-party codecast page may open a view, or any
 * site could ask the shell to browse for it.
 */
function createBrowserPanes({
  WebContentsView, session, ipcMain, BrowserWindow, isTrusted,
  // The CDP port the app listens on, or nothing when it does not (the
  // registry above), and where the registry lands. No path, no registry at
  // all: the shell opts in (main.js passes defaultRegistryPath()), so a
  // manager built anywhere else — a test — never touches the real file.
  cdpPort = null, registryPath = null,
}) {
  /** key `${hostWebContentsId}:${paneId}` → pane record. */
  const panes = new Map();
  /** Hosts we have already wired lifecycle listeners onto. */
  const hosts = new Set();
  let paneSession = null;

  function key(hostId, paneId) {
    return `${hostId}:${paneId}`;
  }

  // One write per tick however many panes changed in it: a navigation fires
  // several events for one page, and a window closing drops every pane at
  // once. The first change schedules, the rest ride along.
  let registryPending = false;
  function scheduleRegistry() {
    if (registryPending) return;
    registryPending = true;
    queueMicrotask(() => {
      registryPending = false;
      writeRegistry();
    });
  }

  /** The registry as of now. Exposed on the manager so a shell shutting down
   *  can flush it, and so tests read exactly what the CLI would. */
  function writeRegistry() {
    if (!registryPath) return false;
    const port = Number(cdpPort);
    return writeRegistryFile(registryPath, port > 0 ? registryDocument(panes.values(), { port }) : null);
  }

  /**
   * The CDP target id of a view. Electron does not expose it, but its own
   * debugger speaks the protocol to the same target: attach, ask the target
   * about itself, detach. The id is fixed for the life of the WebContents, so
   * this happens once per pane. Multi-client is a Chromium guarantee, so an
   * agent already attached from outside is not disturbed. A shell whose
   * debugger cannot attach leaves the id null and the CLI matches by URL.
   */
  async function resolveTargetId(pane) {
    const wc = pane.view.webContents;
    const dbg = wc?.debugger;
    if (!dbg || typeof dbg.attach !== "function") return null;
    try {
      if (!dbg.isAttached?.()) dbg.attach("1.3");
      const info = await dbg.sendCommand("Target.getTargetInfo");
      return info?.targetInfo?.targetId ?? null;
    } catch {
      return null;
    } finally {
      try {
        dbg.detach();
      } catch {}
    }
  }

  /**
   * The pane session, made once. Its permission policy is a flat no: the pages
   * in here are third-party by definition, and the shell's baseline grants
   * (main.js, BASELINE_PERMISSIONS) exist for first-party codecast origins —
   * a third-party origin is denied by that same policy. Saying it here, at the
   * session that only ever holds third-party pages, keeps the answer true even
   * if the baseline grows.
   */
  function ensureSession() {
    if (paneSession) return paneSession;
    paneSession = session.fromPartition(PANE_PARTITION);
    paneSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    paneSession.setPermissionCheckHandler(() => false);
    return paneSession;
  }

  function emit(host, payload) {
    if (!host || host.isDestroyed()) return;
    host.send(`app:${CHANNEL}`, payload);
  }

  /**
   * Everything the shell knows about a pane's window: how to scale its rect,
   * and whether the window can show anything at all. A minimized or hidden
   * window still has a content area, so without this check the views would sit
   * visible on top of whatever the person switched to.
   */
  function windowFacts(host) {
    const win = BrowserWindow.fromWebContents(host);
    if (!win || win.isDestroyed()) return null;
    const bounds = win.getContentBounds();
    return {
      win,
      zoomFactor: host.getZoomFactor ? host.getZoomFactor() : 1,
      contentWidth: bounds.width,
      contentHeight: bounds.height,
      showable: win.isVisible() && !win.isMinimized(),
    };
  }

  /** Place and reveal one pane from what it last asked for. */
  function apply(pane) {
    const facts = windowFacts(pane.host);
    if (!facts) return;
    const bounds = paneViewBounds(pane.rect, facts);
    const visible = pane.wanted && facts.showable && !isEmptyBounds(bounds);
    if (visible) pane.view.setBounds(bounds);
    setVisible(pane, visible);
  }

  function setVisible(pane, visible) {
    if (pane.visible === visible) return;
    pane.visible = visible;
    if (typeof pane.view.setVisible === "function") pane.view.setVisible(visible);
    else if (!visible) pane.view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    // A hidden view that still holds focus swallows every keystroke, so the
    // palette the person just opened would never see a key. Hand focus back to
    // the app the moment the view goes away.
    if (!visible && pane.view.webContents && !pane.view.webContents.isDestroyed()) {
      if (pane.view.webContents.isFocused && pane.view.webContents.isFocused()) {
        if (!pane.host.isDestroyed()) pane.host.focus();
      }
    }
  }

  function applyAllFor(hostId) {
    for (const pane of panes.values()) if (pane.hostId === hostId) apply(pane);
  }

  /**
   * The views belong to the renderer that asked for them. When that renderer
   * goes — the window closed, the process died, or it navigated to another
   * page — the views go with it, or they outlive the pane they were drawn for
   * and hang over whatever is there now.
   */
  function watchHost(host) {
    // Read once, now. Electron throws on ANY property of destroyed web
    // contents, and `drop` runs from the destroyed event itself: reading
    // host.id there threw before the views were closed, and every pane of a
    // closed window lived on as an invisible renderer process.
    const hostId = host.id;
    if (hosts.has(hostId)) return;
    hosts.add(hostId);
    const drop = () => {
      hosts.delete(hostId);
      destroyAllFor(hostId);
    };
    host.once("destroyed", drop);
    host.on("render-process-gone", drop);
    host.on("did-navigate", drop);
    const win = BrowserWindow.fromWebContents(host);
    if (win && !win.isDestroyed()) {
      const refresh = () => applyAllFor(hostId);
      for (const event of ["minimize", "restore", "show", "hide", "resize", "move"]) {
        win.on(event, refresh);
      }
      win.once("closed", drop);
    }
  }

  /** Wire one view's webContents to the renderer that owns the pane. */
  function watchView(pane) {
    const wc = pane.view.webContents;
    const send = (event, extra) => emit(pane.host, { paneId: pane.paneId, event, ...extra });

    wc.on("page-title-updated", (_e, title) => send("title", { title }));
    wc.on("page-favicon-updated", (_e, favicons) => send("favicon", { favicon: favicons?.[0] ?? null }));
    wc.on("did-start-loading", () => send("loading", { loading: true }));
    wc.on("did-stop-loading", () => send("loading", { loading: false }));
    // The registry follows the page, not the request: a redirect or a link
    // the person clicked changes what an agent finds at the target.
    wc.on("did-navigate", (_e, url) => {
      pane.url = url;
      scheduleRegistry();
      send("url", { url, inPage: false });
    });
    wc.on("did-navigate-in-page", (_e, url, isMainFrame) => {
      if (!isMainFrame) return;
      pane.url = url;
      scheduleRegistry();
      send("url", { url, inPage: true });
    });
    wc.on("did-fail-load", (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
      // -3 is ABORTED: a navigation the page itself replaced. Reporting it
      // would paint an error over a page that is loading fine.
      if (!isMainFrame || errorCode === -3) return;
      send("fail", { errorCode, errorDescription, url: validatedURL });
    });
    // A click in the view is how a person moves between panes: the stage's
    // focus ring has to follow, and only the shell can see this happen.
    wc.on("focus", () => send("focus", {}));
    wc.on("blur", () => send("blur", {}));

    // A link that asks for a new window opens in this pane instead. Handing it
    // to the system browser would lose the page out of the workspace the
    // person is working in, and that is what every other Electron window in
    // this app does precisely because those windows are the app itself.
    wc.setWindowOpenHandler(({ url }) => {
      if (isLoadableUrl(url)) {
        wc.loadURL(url);
        send("url", { url, inPage: false });
      }
      return { action: "deny" };
    });

    // Keys the app owns (see APP_CHORD_KEYS). The view has keyboard focus, so
    // the renderer never sees them; forwarding is what keeps Cmd+K opening the
    // palette while the person is reading a page in a pane.
    wc.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown") return;
      const chord = process.platform === "darwin" ? input.meta && !input.control : input.control;
      if (!chord || input.alt) return;
      const k = String(input.key || "").toLowerCase();
      if (!APP_CHORD_KEYS.has(k)) return;
      event.preventDefault();
      send("chord", { key: k, shift: !!input.shift });
    });
  }

  /** http(s) only: a pane is a web view, and a file:// or javascript: string
   *  reaching loadURL would be the shell doing something the web layer cannot. */
  function isLoadableUrl(url) {
    try {
      const u = new URL(String(url));
      return u.protocol === "http:" || u.protocol === "https:";
    } catch {
      return false;
    }
  }

  // `session` is the agent session the human opened this pane for (the offer
  // it came from, ct-51075), and it is what lets that session's `cast browser`
  // find its own view in the registry. A pane nobody offered has none, and no
  // agent may claim it.
  function create(host, { paneId, url, rect, visible, session: sessionKey }) {
    const k = key(host.id, paneId);
    const existing = panes.get(k);
    if (existing) {
      if (url && isLoadableUrl(url) && url !== existing.url) navigate(existing, url);
      if (rect) existing.rect = rect;
      if (visible !== undefined) existing.wanted = visible !== false;
      const owner = cleanSessionKey(sessionKey);
      if (owner && owner !== existing.session) {
        existing.session = owner;
        scheduleRegistry();
      }
      apply(existing);
      return { ok: true, reused: true };
    }
    const win = BrowserWindow.fromWebContents(host);
    if (!win || win.isDestroyed()) return { ok: false, reason: "no-window" };

    const view = new WebContentsView({
      webPreferences: {
        // No preload, no Node, its own sandbox: the page in here is a stranger
        // and gets nothing of this app. The bridge lives one layer up, in the
        // renderer that placed the view.
        session: ensureSession(),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    const pane = {
      paneId,
      host,
      hostId: host.id,
      view,
      url: null,
      rect: rect ?? { x: 0, y: 0, width: 0, height: 0 },
      wanted: visible !== false,
      visible: true,
      session: cleanSessionKey(sessionKey),
      targetId: null,
    };
    panes.set(k, pane);
    watchHost(host);
    watchView(pane);
    win.contentView.addChildView(view);
    // Born hidden: placing it before the first measured rect arrives would
    // flash a full-window page for one frame.
    setVisible(pane, false);
    if (url) navigate(pane, url);
    apply(pane);
    // Advertised twice: at once with what is known, and again with the target
    // id when the debugger answers, so the CLI never waits on the shell.
    scheduleRegistry();
    void resolveTargetId(pane).then((targetId) => {
      if (!targetId || panes.get(k) !== pane) return;
      pane.targetId = targetId;
      scheduleRegistry();
    });
    return { ok: true, reused: false };
  }

  function navigate(pane, url) {
    if (!isLoadableUrl(url)) return { ok: false, reason: "bad-url" };
    pane.url = url;
    pane.view.webContents.loadURL(url);
    scheduleRegistry();
    return { ok: true };
  }

  function destroy(pane) {
    panes.delete(key(pane.hostId, pane.paneId));
    scheduleRegistry();
    // The host may already be gone (this runs from its destroyed event), and
    // asking Electron for its window then throws. The view must close either
    // way: that is the whole point of the call.
    try {
      const win = BrowserWindow.fromWebContents(pane.host);
      if (win && !win.isDestroyed()) win.contentView.removeChildView(pane.view);
    } catch {}
    try {
      const wc = pane.view.webContents;
      if (wc && !wc.isDestroyed()) wc.close();
    } catch {}
  }

  function destroyAllFor(host) {
    const hostId = typeof host === "number" ? host : host?.id;
    for (const pane of [...panes.values()]) if (pane.hostId === hostId) destroy(pane);
  }

  /** Every command the renderer can send, by name. Each one is handed the
   *  pane it names; a command for a pane that is gone is a no-op, because a
   *  renderer unmounting and a window closing race by design. */
  const COMMANDS = {
    create: (host, payload) => create(host, payload),
    navigate: (_host, payload, pane) => (pane ? navigate(pane, payload.url) : { ok: false }),
    bounds: (_host, payload, pane) => {
      if (!pane) return { ok: false };
      if (payload.rect) pane.rect = payload.rect;
      if (payload.visible !== undefined) pane.wanted = payload.visible !== false;
      apply(pane);
      return { ok: true, visible: pane.visible };
    },
    show: (_host, _payload, pane) => {
      if (!pane) return { ok: false };
      pane.wanted = true;
      apply(pane);
      return { ok: true, visible: pane.visible };
    },
    hide: (_host, _payload, pane) => {
      if (!pane) return { ok: false };
      pane.wanted = false;
      apply(pane);
      return { ok: true, visible: pane.visible };
    },
    reload: (_host, _payload, pane) => {
      pane?.view.webContents.reload();
      return { ok: !!pane };
    },
    back: (_host, _payload, pane) => {
      const nav = pane?.view.webContents.navigationHistory;
      if (nav?.canGoBack()) nav.goBack();
      return { ok: !!pane, can: !!nav?.canGoBack() };
    },
    forward: (_host, _payload, pane) => {
      const nav = pane?.view.webContents.navigationHistory;
      if (nav?.canGoForward()) nav.goForward();
      return { ok: !!pane, can: !!nav?.canGoForward() };
    },
    // Detached, always: devtools docked inside the view would take half the
    // pane, and a pane is already somebody's split.
    devtools: (_host, _payload, pane) => {
      const wc = pane?.view.webContents;
      if (!wc) return { ok: false };
      // Answer with the state being asked for. openDevTools is asynchronous:
      // isDevToolsOpened() still reads false straight after the call (measured
      // in the rig), so reading it back reports an opening window as closed.
      const open = !wc.isDevToolsOpened();
      if (open) wc.openDevTools({ mode: "detach" });
      else wc.closeDevTools();
      return { ok: true, open };
    },
    focus: (_host, _payload, pane) => {
      pane?.view.webContents.focus();
      return { ok: !!pane };
    },
    destroy: (_host, _payload, pane) => {
      if (pane) destroy(pane);
      return { ok: true };
    },
    destroyAll: (host) => {
      destroyAllFor(host);
      return { ok: true };
    },
    // Read-only, and the only way anything outside the shell can see what the
    // views are actually doing: a native view is not in the DOM and not in the
    // renderer's screenshot, so "the palette hid the page" is provable here
    // and nowhere else.
    state: (host) => ({
      ok: true,
      panes: [...panes.values()]
        .filter((p) => p.hostId === host.id)
        .map((p) => ({
          paneId: p.paneId,
          url: p.view.webContents.getURL(),
          visible: p.visible,
          wanted: p.wanted,
          bounds: p.rect,
        })),
    }),
  };

  function handle(event, cmd, payload = {}) {
    const host = event.sender;
    if (!isTrusted(host)) return { ok: false, reason: "untrusted" };
    const run = COMMANDS[cmd];
    if (!run) return { ok: false, reason: "unknown-command" };
    const pane = payload.paneId ? panes.get(key(host.id, payload.paneId)) : null;
    if (pane && (pane.view.webContents?.isDestroyed?.() ?? false)) {
      panes.delete(key(host.id, payload.paneId));
      return { ok: false, reason: "gone" };
    }
    return run(host, payload, pane);
  }

  function install() {
    ipcMain.handle(`app:${CHANNEL}`, handle);
    ipcMain.handle(`app:${CAPABILITIES_CHANNEL}`, (event) => ({
      available: isTrusted(event.sender),
      partition: PANE_PARTITION,
      // What the renderer may ask for. A build that grows a command says so
      // here rather than making the web side guess from a version number.
      commands: Object.keys(COMMANDS),
      // Whether an agent can drive a pane from the CLI: only with a port.
      drivable: Number(cdpPort) > 0,
    }));
    // A fresh app has no panes yet: say so, or the CLI reads last run's file
    // (which names this pid's predecessor) until the first pane opens.
    writeRegistry();
  }

  return { install, handle, destroyAllFor, panes, PANE_PARTITION, writeRegistry, registryPath };
}

module.exports = {
  createBrowserPanes,
  paneViewBounds,
  isEmptyBounds,
  registryDocument,
  writeRegistryFile,
  defaultRegistryPath,
  PANE_PARTITION,
  CHANNEL,
  CAPABILITIES_CHANNEL,
  APP_CHORD_KEYS,
  REGISTRY_VERSION,
  REGISTRY_FILE,
};
