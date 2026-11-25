// The Electron-window host for installed apps: what Windows runs, and what a
// Mac runs with CODECAST_APPS_HOST=electron (docs/architecture/installed-apps.md,
// "Hosting > Windows").
//
// Each app is a BrowserWindow in its own partition (persist:app-<slug>),
// sandboxed, with the small app preload and never the shell preload
// (protocol.appWebPreferences). Navigation stays under the page's path;
// everything else goes to the default browser or mail client, and only for
// http, https and mailto. The bridge (cast-app:call) answers only that app's
// main frame on its own page URL. The frame version the engine checks is the
// X-Cast-Version header of the document the frame loaded, read on the
// partition's webRequest; a response without the header (servers before
// ct-101002) counts as the version the facts named when the load began.
//
// On Windows each app also gets its own taskbar identity (setAppDetails with
// AUMID Codecast.App.<slug>), a Start menu shortcut carrying that AUMID, and
// toasts shown through that AUMID (see `windowsToast`).
//
// createElectronHost(deps) returns the platform host host.js expects (see
// there). deps: {electron, registry, pageUrl, pageOrigin, call, onFocus,
// onClosed, appVersion, platform?, notify?, showWindows?, log?}
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { AppError, CHANNELS, fail, appWebPreferences } = require("./protocol");

const EXTERNAL = /^(https?:|mailto:)/i;
// What an app's page may ask the browser layer for. Native notifications go
// through cast.app.notify (the notifications permission), never the web API.
const WEB_PERMISSIONS = new Set(["clipboard-sanitized-write", "fullscreen"]);

const aumid = (slug) => `Codecast.App.${slug}`;

/**
 * The window and tray an app opens with. appInfo always carries every field
 * (resolvePageApp on the server), so the fallbacks here only cover a record
 * whose facts are missing.
 */
function manifestOf(record) {
  const app = (record.facts && record.facts.app) || {};
  const w = { width: 1024, height: 768, minWidth: 320, minHeight: 240, resizable: true, titleBar: "default", ...app.window };
  const t = app.tray || {};
  return { window: w, tray: { width: t.width || 360, height: t.height || 480, tooltip: t.tooltip || record.name } };
}

/** Whether `url` is the app's page or a path under it, on a page origin. */
function pageUrlAllowed(url, slug, origins) {
  if (typeof url !== "string" || !URL.canParse(url)) return false;
  const u = new URL(url);
  if (u.username || u.password || !origins.includes(u.origin)) return false;
  return u.pathname === `/${slug}` || u.pathname.startsWith(`/${slug}/`);
}

/** Whether a link leaving the app may be handed to the OS (default browser or mail client). */
const externalAllowed = (url) => typeof url === "string" && EXTERNAL.test(url) && URL.canParse(url);

/** The X-Cast-Version a document response carries, or null. */
function castVersionHeader(headers) {
  for (const [name, value] of Object.entries(headers || {})) {
    if (name.toLowerCase() !== "x-cast-version") continue;
    const n = Number(Array.isArray(value) ? value[0] : value);
    return Number.isInteger(n) && n > 0 ? n : null;
  }
  return null;
}

/** A Start menu file name from an app's display name. */
function shortcutFileName(name) {
  const clean = String(name || "").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").replace(/[. ]+$/, "").trim().slice(0, 80);
  return `${clean || "App"}.lnk`;
}

const xmlEscape = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

/**
 * The PowerShell that shows one toast under `appId` and reports what became
 * of it ("act", "dis", "fail" or "timeout").
 *
 * Electron's Notification cannot do this: its toast notifier is created once
 * per process with the process AUMID (shell/browser/notifications/win/
 * windows_toast_notification.cc, Initialize), so neither toastXml nor
 * changing the AUMID later moves a toast to another app. The WinRT
 * ToastNotificationManager takes any AUMID that a Start menu shortcut
 * carries, which install writes. Clicks while this script waits come back as
 * notification-click with the tag; a later click from Action Center launches
 * the shortcut, which reaches us as --codecast-app=<slug> and focuses the app.
 */
function windowsToastScript({ appId, title, body, tag, silent }) {
  const xml = `<toast><visual><binding template="ToastGeneric"><text>${xmlEscape(title)}</text>${body ? `<text>${xmlEscape(body)}</text>` : ""}</binding></visual>${silent ? '<audio silent="true"/>' : ""}</toast>`;
  return [
    "$ErrorActionPreference = 'Stop'",
    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
    "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null",
    "$xml = New-Object Windows.Data.Xml.Dom.XmlDocument",
    `$xml.LoadXml(${psQuote(xml)})`,
    "$toast = New-Object Windows.UI.Notifications.ToastNotification $xml",
    tag ? `$toast.Tag = ${psQuote(String(tag).slice(0, 64))}` : "",
    "Register-ObjectEvent -InputObject $toast -EventName Activated -SourceIdentifier act | Out-Null",
    "Register-ObjectEvent -InputObject $toast -EventName Dismissed -SourceIdentifier dis | Out-Null",
    "Register-ObjectEvent -InputObject $toast -EventName Failed -SourceIdentifier fail | Out-Null",
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(${psQuote(appId)}).Show($toast)`,
    "$e = Wait-Event -Timeout 30",
    "if ($e) { Write-Output $e.SourceIdentifier } else { Write-Output 'timeout' }",
  ].filter(Boolean).join("\n");
}

function windowsToast(opts, onClick, spawnImpl = spawn) {
  const script = windowsToastScript(opts);
  const child = spawnImpl("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.on("error", () => {});
  child.on("close", () => {
    if (out.trim().split(/\s+/).pop() === "act") onClick();
  });
}

/** A frameless popover's position: centered on the tray item, below it at the top of a display, above it at the bottom. */
function popoverPosition(trayBounds, size, area) {
  const below = trayBounds.y < area.y + area.height / 2;
  let x = Math.round(trayBounds.x + trayBounds.width / 2 - size.width / 2);
  let y = below ? trayBounds.y + trayBounds.height + 4 : trayBounds.y - size.height - 4;
  x = Math.min(Math.max(x, area.x), area.x + area.width - size.width);
  y = Math.min(Math.max(y, area.y), area.y + area.height - size.height);
  return { x, y };
}

/**
 * The rectangle a popover hangs from: the tray item's own bounds when they are
 * on the display, else that display's tray corner (top right on macOS, bottom
 * right elsewhere). macOS reports an item that a full menu bar hides behind
 * the notch with a frame off every display.
 */
function trayAnchor(bounds, display, platform) {
  const on = bounds && bounds.width > 0 && bounds.height > 0 &&
    bounds.x + bounds.width > display.bounds.x && bounds.x < display.bounds.x + display.bounds.width &&
    bounds.y + bounds.height > display.bounds.y && bounds.y < display.bounds.y + display.bounds.height;
  if (on) return bounds;
  const area = display.workArea;
  const x = area.x + area.width - 40;
  return platform === "darwin"
    ? { x, y: display.bounds.y, width: 24, height: Math.max(0, area.y - display.bounds.y) }
    : { x, y: area.y + area.height, width: 24, height: Math.max(0, display.bounds.y + display.bounds.height - area.y - area.height) };
}

/** A 16 px red dot, the taskbar overlay for a badge (BGRA). */
function badgeBitmap(size = 16) {
  const buf = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const a = Math.max(0, Math.min(1, size / 2 - Math.hypot(x - c, y - c)));
      const i = (y * size + x) * 4;
      buf[i] = Math.round(0x2f * a);
      buf[i + 1] = Math.round(0x32 * a);
      buf[i + 2] = Math.round(0xdc * a);
      buf[i + 3] = Math.round(255 * a);
    }
  }
  return buf;
}

function createElectronHost(deps) {
  const { electron, registry, pageUrl, call, onFocus = () => {}, onClosed = () => {}, appVersion } = deps;
  const { BrowserWindow, session, ipcMain, Tray, nativeImage, globalShortcut, shell, screen, app, powerMonitor } = electron;
  const platform = deps.platform || process.platform;
  const isWin = platform === "win32";
  const showWindows = deps.showWindows !== false;
  const log = deps.log || ((...a) => console.warn("[apps]", ...a));
  const origins = () => [deps.pageOrigin];
  const launchArgs = app.isPackaged ? [] : [app.getAppPath()];
  const startMenuDir = () => path.join(app.getPath("appData"), "Microsoft", "Windows", "Start Menu", "Programs", "Codecast Apps");

  const apps = new Map(); // slug -> {win, popover, tray, shortcuts: Set, ignoreMouse, badge}
  const surfaces = new Map(); // webContents id -> {slug, surface, wc, frameVersion, loadVersion}
  const sessions = new Set();
  let screenLocked = false;
  powerMonitor?.on?.("lock-screen", () => (screenLocked = true));
  powerMonitor?.on?.("unlock-screen", () => (screenLocked = false));

  const stateOf = (slug) => {
    if (!apps.has(slug)) apps.set(slug, { win: null, popover: null, tray: null, shortcuts: new Set(), ignoreMouse: false, badge: 0 });
    return apps.get(slug);
  };
  const alive = (w) => !!w && !w.isDestroyed();
  const factsVersion = (slug) => Number(registry.get(slug)?.facts?.version) || 0;

  let lastExternal = { url: null, at: 0 };
  function openOutside(url) {
    if (!externalAllowed(url)) return;
    const now = Date.now();
    if (lastExternal.url === url && now - lastExternal.at < 1000) return;
    lastExternal = { url, at: now };
    shell.openExternal(url);
  }

  // ── the bridge ──
  /** The surface a call came from, when it is an app's main frame on its own page; else null. */
  function admitted(event) {
    const sender = event && event.sender;
    const entry = sender && surfaces.get(sender.id);
    if (!entry || entry.wc !== sender) return null;
    const frame = event.senderFrame;
    if (!frame || frame !== sender.mainFrame) return null;
    if (!pageUrlAllowed(frame.url, entry.slug, origins())) return null;
    return entry;
  }

  ipcMain.handle(CHANNELS.call, (event, msg) => {
    const entry = admitted(event);
    const id = msg && msg.id !== undefined ? msg.id : null;
    if (!entry) return fail(id, "failed", "only an installed app's own page can call cast.app");
    return call(entry.slug, { version: entry.frameVersion, surface: entry.surface }, msg);
  });

  function emit(slug, event, data) {
    const s = apps.get(slug);
    if (!s) return;
    for (const w of [s.win, s.popover]) if (alive(w)) w.webContents.send(CHANNELS.event, { event, data });
  }

  // ── the partition ──
  function configureSession(slug) {
    const ses = session.fromPartition(`persist:app-${slug}`);
    if (sessions.has(slug)) return ses;
    sessions.add(slug);
    ses.setUserAgent(`${ses.getUserAgent()} CodecastApp/${appVersion} (${slug})`);
    ses.webRequest.onHeadersReceived((details, callback) => {
      if (details.resourceType === "mainFrame") {
        const entry = surfaces.get(details.webContentsId);
        if (entry && entry.slug === slug && pageUrlAllowed(details.url, slug, origins())) {
          entry.frameVersion = castVersionHeader(details.responseHeaders) ?? entry.loadVersion;
        }
      }
      callback({});
    });
    ses.setPermissionRequestHandler((_wc, permission, callback) => callback(WEB_PERMISSIONS.has(permission)));
    ses.setPermissionCheckHandler((_wc, permission) => WEB_PERMISSIONS.has(permission));
    return ses;
  }

  function lockNavigation(wc, slug) {
    const guard = (event, url) => {
      if (pageUrlAllowed(url, slug, origins())) return;
      event.preventDefault();
      openOutside(url);
    };
    wc.on("will-frame-navigate", (event) => {
      if (event.isMainFrame) guard(event, event.url);
    });
    wc.on("will-navigate", (event, url) => guard(event, url));
    wc.on("will-redirect", (event, url, _inPlace, isMainFrame) => {
      if (isMainFrame) guard(event, url);
    });
    wc.setWindowOpenHandler(({ url }) => {
      openOutside(url);
      return { action: "deny" };
    });
  }

  // ── windows ──
  function visibleBounds(bounds) {
    if (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) return null;
    const area = screen.getDisplayMatching(bounds).workArea;
    const overlapX = Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x);
    const overlapY = Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y);
    return overlapX >= 80 && overlapY >= 40 ? bounds : null;
  }

  function saveBounds(slug, win) {
    if (!alive(win) || !registry.get(slug)) return;
    try {
      registry.update(slug, { bounds: win.getNormalBounds ? win.getNormalBounds() : win.getBounds() });
    } catch {}
  }

  function appIcon(record) {
    const file = (isWin && record.icons && record.icons.ico) || record.iconPath;
    return file && fs.existsSync(file) ? file : undefined;
  }

  function createSurface(slug, surface) {
    const record = registry.get(slug);
    const manifest = manifestOf(record);
    const s = stateOf(slug);
    configureSession(slug);
    const webPreferences = appWebPreferences(slug);
    let options;
    if (surface === "window") {
      const w = manifest.window;
      const hidden = w.titleBar === "hidden";
      options = {
        width: w.width,
        height: w.height,
        minWidth: w.minWidth,
        minHeight: w.minHeight,
        resizable: w.resizable,
        title: record.name,
        icon: appIcon(record),
        show: false,
        ...(hidden ? (platform === "darwin" ? { titleBarStyle: "hiddenInset" } : { titleBarStyle: "hidden", titleBarOverlay: true }) : {}),
        ...(visibleBounds(record.bounds) || {}),
        webPreferences,
      };
    } else {
      options = {
        width: manifest.tray.width,
        height: manifest.tray.height,
        frame: false,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        show: false,
        webPreferences,
      };
    }
    const win = new BrowserWindow(options);
    const wc = win.webContents;
    const entry = { slug, surface, wc, frameVersion: 0, loadVersion: factsVersion(slug) };
    surfaces.set(wc.id, entry);
    lockNavigation(wc, slug);
    if (isWin && surface === "window") {
      win.setAppDetails({
        appId: aumid(slug),
        appIconPath: appIcon(record) || "",
        appIconIndex: 0,
        relaunchCommand: [app.getPath("exe"), ...launchArgs, `--codecast-app=${slug}`].map((a) => `"${a}"`).join(" "),
        relaunchDisplayName: record.name,
      });
    }
    if (surface === "window") {
      let saveTimer = null;
      const saveSoon = () => {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => saveBounds(slug, win), 500);
      };
      win.on("resize", saveSoon);
      win.on("move", saveSoon);
      win.on("close", () => {
        clearTimeout(saveTimer);
        saveBounds(slug, win);
      });
      win.on("focus", () => {
        if (s.ignoreMouse) {
          s.ignoreMouse = false;
          win.setIgnoreMouseEvents(false);
        }
        onFocus(slug);
      });
      win.once("ready-to-show", () => {
        if (showWindows) win.show();
      });
    } else {
      win.on("blur", () => {
        if (alive(win) && !win.webContents.isDevToolsOpened()) win.hide();
      });
    }
    win.on("closed", () => {
      surfaces.delete(wc.id);
      if (s[surface === "window" ? "win" : "popover"] === win) s[surface === "window" ? "win" : "popover"] = null;
      onClosed(slug);
    });
    s[surface === "window" ? "win" : "popover"] = win;
    win.loadURL(pageUrl(slug, surface));
    return win;
  }

  function surfaceWindow(ctx) {
    const s = apps.get(ctx.slug);
    const win = s && (ctx.frame && ctx.frame.surface === "tray" ? s.popover : s.win);
    if (!alive(win)) throw new AppError("failed", "that window is not open");
    return win;
  }

  function focusApp(slug) {
    const s = stateOf(slug);
    if (!alive(s.win)) return createSurface(slug, "window");
    if (s.win.isMinimized()) s.win.restore();
    s.win.show();
    s.win.focus();
    return s.win;
  }

  // ── tray ──
  function trayImage(record) {
    const icons = record.icons || {};
    let image = icons.tray && fs.existsSync(icons.tray) ? nativeImage.createFromPath(icons.tray) : null;
    if (!image && record.iconPath && fs.existsSync(record.iconPath)) image = nativeImage.createFromPath(record.iconPath).resize({ width: 16, height: 16 });
    image = image || nativeImage.createEmpty();
    if (platform === "darwin" && icons.trayTemplate) image.setTemplateImage(true);
    return image;
  }

  function togglePopover(slug) {
    const s = stateOf(slug);
    if (alive(s.popover) && s.popover.isVisible()) return s.popover.hide();
    const win = alive(s.popover) ? s.popover : createSurface(slug, "tray");
    const raw = s.tray.getBounds();
    const display = raw && raw.width > 0 ? screen.getDisplayMatching(raw) : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const [width, height] = win.getSize();
    const { x, y } = popoverPosition(trayAnchor(raw, display, platform), { width, height }, display.workArea);
    win.setPosition(x, y);
    const reveal = () => {
      if (!alive(win)) return;
      win.show();
      win.focus();
    };
    if (win.webContents.isLoading()) win.once("ready-to-show", reveal);
    else reveal();
    emit(slug, "tray-click", {});
  }

  function trayLabel(s) {
    return [s.trayTitle, s.trayBadge].filter((v) => v !== undefined && v !== null && v !== "" && v !== 0).join(" ");
  }

  // ── shortcuts ──
  function bindShortcut(slug, accelerator) {
    return globalShortcut.register(accelerator, () => {
      if (!screenLocked) emit(slug, "shortcut", { accelerator });
    });
  }

  // ── the platform host ──
  const host = {
    name: "electron",
    emit,
    isOpen: (slug) => {
      const s = apps.get(slug);
      return !!s && (alive(s.win) || alive(s.popover));
    },
    anchor: (slug) => {
      const s = apps.get(slug);
      return s && alive(s.win) ? s.win.getBounds() : null;
    },
    /** Brings the app forward; {surface: "tray"} opens its popover under its menu bar item instead. */
    async open(slug, opts = {}) {
      if (opts.surface !== "tray") return void focusApp(slug);
      const s = stateOf(slug);
      if (!s.tray || s.tray.isDestroyed()) throw new Error("the app has no menu bar item");
      if (!(alive(s.popover) && s.popover.isVisible())) togglePopover(slug);
    },
    reload(slug) {
      const s = apps.get(slug);
      if (!s) return;
      for (const [surface, win] of [["window", s.win], ["tray", s.popover]]) {
        if (!alive(win)) continue;
        const entry = surfaces.get(win.webContents.id);
        if (entry) entry.loadVersion = factsVersion(slug);
        win.loadURL(pageUrl(slug, surface));
      }
    },

    async install({ record, icons }) {
      if (!isWin) return {};
      const dir = startMenuDir();
      fs.mkdirSync(dir, { recursive: true });
      const shortcutPath = path.join(dir, shortcutFileName(record.name));
      // The target is the running Codecast.exe. A per-user install lives at
      // %LOCALAPPDATA%\Programs\Codecast\Codecast.exe and an update reinstalls
      // it in place, so the shortcut outlives updates. It does not survive
      // Codecast moving (a per-machine reinstall under Program Files, or a
      // portable copy): the shortcut then points at a missing file until the
      // app is installed again. A from-source run targets electron.exe with
      // the app path as its first argument.
      const ok = shell.writeShortcutLink(shortcutPath, "create", {
        target: app.getPath("exe"),
        args: [...launchArgs.map((a) => `"${a}"`), `--codecast-app=${record.slug}`].join(" "),
        appUserModelId: aumid(record.slug),
        icon: (icons && icons.ico) || app.getPath("exe"),
        iconIndex: 0,
        description: record.name,
      });
      if (!ok) throw new Error("could not write the Start menu shortcut");
      return { shortcutPath };
    },

    async uninstall(record) {
      const slug = record.slug;
      const s = apps.get(slug);
      if (s) {
        for (const acc of s.shortcuts) globalShortcut.unregister(acc);
        if (s.tray && !s.tray.isDestroyed()) s.tray.destroy();
        for (const w of [s.win, s.popover]) if (alive(w)) w.destroy();
        apps.delete(slug);
      }
      if (isWin) {
        if (record.shortcutPath) fs.rmSync(record.shortcutPath, { force: true });
        try {
          app.setLoginItemSettings({ openAtLogin: false, path: app.getPath("exe"), args: [...launchArgs, `--codecast-app=${slug}`], name: `CodecastApp-${slug}` });
        } catch {}
      }
      const ses = session.fromPartition(`persist:app-${slug}`);
      await ses.clearStorageData();
      await ses.clearCache();
      sessions.delete(slug);
    },

    closeAll() {
      for (const [slug, s] of apps) {
        saveBounds(slug, s.win);
        for (const acc of s.shortcuts) globalShortcut.unregister(acc);
        if (s.tray && !s.tray.isDestroyed()) s.tray.destroy();
        for (const w of [s.win, s.popover]) if (alive(w)) w.destroy();
      }
      apps.clear();
    },

    /** main.js unregisters every global shortcut when it rebinds its own; put the apps' back. */
    reregisterShortcuts() {
      for (const [slug, s] of apps) for (const acc of s.shortcuts) if (!globalShortcut.isRegistered(acc)) bindShortcut(slug, acc);
    },

    // ── engine host methods (ctx, ...args) ──
    "app.notify": (ctx, { title, body, tag, silent }) => {
      const onClick = () => {
        focusApp(ctx.slug);
        emit(ctx.slug, "notification-click", { tag: tag ?? null });
      };
      if (isWin) return void windowsToast({ appId: aumid(ctx.slug), title, body, tag, silent }, onClick);
      if (!deps.notify) throw new AppError("failed", "notifications are not available here");
      deps.notify({ title: title, body: body || "", silent: !!silent }, onClick);
    },
    "app.badge": (ctx, count) => {
      const s = stateOf(ctx.slug);
      s.badge = count;
      if (isWin && alive(s.win)) {
        s.win.setOverlayIcon(count > 0 ? nativeImage.createFromBitmap(badgeBitmap(), { width: 16, height: 16 }) : null, count > 0 ? String(count) : "");
      }
    },
    "tray.set": (ctx, opts = {}) => {
      const s = stateOf(ctx.slug);
      const record = registry.get(ctx.slug);
      if (!s.tray || s.tray.isDestroyed()) {
        s.tray = new Tray(trayImage(record));
        s.tray.on("click", () => togglePopover(ctx.slug));
      }
      const manifest = manifestOf(record);
      s.tray.setToolTip(opts.tooltip ?? manifest.tray.tooltip);
      if (opts.title !== undefined) s.trayTitle = opts.title;
      if (opts.badge !== undefined) s.trayBadge = opts.badge;
      if (platform === "darwin") s.tray.setTitle(trayLabel(s));
    },
    "tray.remove": (ctx) => {
      const s = stateOf(ctx.slug);
      if (s.tray && !s.tray.isDestroyed()) s.tray.destroy();
      s.tray = null;
      if (alive(s.popover)) s.popover.destroy();
    },
    "shortcuts.register": (ctx, accelerator) => {
      const s = stateOf(ctx.slug);
      if (s.shortcuts.has(accelerator)) return;
      if (globalShortcut.isRegistered(accelerator) || !bindShortcut(ctx.slug, accelerator)) {
        throw new AppError("failed", `${accelerator} is already taken by another app or shortcut`);
      }
      s.shortcuts.add(accelerator);
    },
    "shortcuts.unregister": (ctx, accelerator) => {
      const s = stateOf(ctx.slug);
      if (!s.shortcuts.delete(accelerator)) return;
      globalShortcut.unregister(accelerator);
    },
    "window.setSize": (ctx, width, height) => surfaceWindow(ctx).setContentSize(Math.round(width), Math.round(height)),
    "window.setTitle": (ctx, title) => surfaceWindow(ctx).setTitle(title),
    "window.focus": (ctx) => {
      const win = surfaceWindow(ctx);
      win.show();
      win.focus();
    },
    "window.minimize": (ctx) => surfaceWindow(ctx).minimize(),
    "window.close": (ctx) => surfaceWindow(ctx).close(),
    "window.setAlwaysOnTop": (ctx, on) => surfaceWindow(ctx).setAlwaysOnTop(on, "floating"),
    // In the contract's overlay set; the engine reaches them once tiers.json,
    // engine.ARGS and client.js carry them.
    "window.setVisibleOnAllWorkspaces": (ctx, on) => surfaceWindow(ctx).setVisibleOnAllWorkspaces(on, { visibleOnFullScreen: true }),
    "window.setIgnoreMouseEvents": (ctx, on) => {
      const win = surfaceWindow(ctx);
      stateOf(ctx.slug).ignoreMouse = on;
      win.setIgnoreMouseEvents(on, { forward: true });
    },
    "login.set": (ctx, on) => {
      if (!isWin) throw new AppError("failed", "open at login is set by the macOS host");
      app.setLoginItemSettings({ openAtLogin: on, path: app.getPath("exe"), args: [...launchArgs, `--codecast-app=${ctx.slug}`], name: `CodecastApp-${ctx.slug}` });
    },
  };
  return host;
}

module.exports = {
  createElectronHost,
  pageUrlAllowed,
  externalAllowed,
  castVersionHeader,
  shortcutFileName,
  windowsToastScript,
  windowsToast,
  popoverPosition,
  trayAnchor,
  badgeBitmap,
  aumid,
  WEB_PERMISSIONS,
};
