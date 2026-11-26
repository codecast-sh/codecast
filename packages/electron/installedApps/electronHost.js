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
// While Codecast is signed out (deps.signedIn() false; host.js calls
// setSignedIn on a change) every surface shows a cover saying so, with the
// shim's words (appshim HostState.signedOut), instead of the page; its one
// control opens Codecast.
//
// Windows toasts are paced per app: one PowerShell toast process at a time,
// at most TOAST_QUEUE waiting (the oldest dropped), and at most
// NOTIFY_PER_MINUTE notify calls a minute (refused with failed past that).
//
// createElectronHost(deps) returns the platform host host.js expects (see
// there). deps: {electron, registry, pageUrl, pageOrigin, call, onFocus,
// onClosed, appVersion, platform?, notify?, showWindows?, log?, signedIn?,
// openInCodecast?, spawn?}
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { AppError, CHANNELS, fail, appWebPreferences } = require("./protocol");
const { psQuote } = require("../winInstaller");

const EXTERNAL = /^(https?:|mailto:)/i;
// What an app's page may ask the browser layer for. Native notifications go
// through cast.app.notify (the notifications permission), never the web API.
const WEB_PERMISSIONS = new Set(["clipboard-sanitized-write", "fullscreen"]);

const aumid = (slug) => `Codecast.App.${slug}`;
const NOTIFY_PER_MINUTE = 10;
const TOAST_QUEUE = 3;
// The toast script waits 30s for a click, so a process alive well past that
// is hung; it is killed so the app's later toasts are not held behind it.
const TOAST_KILL_MS = 15_000;
/** The cover's one control. It opens a new window, which the open handler takes. */
const OPEN_CODECAST = "codecast://open/";

const htmlEscape = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The signed-out cover, as a data URL: the shim's StatusOverlay words for HostState.signedOut. */
function signedOutCoverUrl(name) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${htmlEscape(name)}</title><style>
:root{color-scheme:light dark;font:14px -apple-system,"Segoe UI",system-ui,sans-serif}
body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;text-align:center;background:Canvas;color:CanvasText}
h1{font-size:17px;font-weight:600;margin:0 0 6px}p{margin:0 0 16px;opacity:.7}
a{display:inline-block;padding:6px 14px;border-radius:6px;background:AccentColor;color:AccentColorText;text-decoration:none}
</style></head><body><main><h1>Codecast is signed out</h1><p>Sign in to Codecast to use ${htmlEscape(name)}.</p>
<a href="${OPEN_CODECAST}" target="_blank">Open Codecast</a></main></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

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

// Names Windows keeps for devices: "CON.lnk" opens the console, not a file,
// on Windows 10, whatever the extension.
const RESERVED_FILE_NAME = /^(con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])$/i;

/** A Start menu file name from an app's display name; `suffix` tells two apps of one name apart. */
function shortcutFileName(name, suffix = "") {
  let clean = String(name || "").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").trim().slice(0, 80).replace(/[. ]+$/, "");
  if (!clean) clean = "App";
  const [head, ...rest] = clean.split(".");
  if (RESERVED_FILE_NAME.test(head.trimEnd())) clean = [`${head.trimEnd()}_`, ...rest].join(".");
  return `${clean}${suffix ? ` (${suffix})` : ""}.lnk`;
}

/**
 * Where an app's Start menu shortcut goes: its name, or its name and slug when
 * another installed app already holds that file (NTFS names ignore case).
 * Sharing one file would hand the first app's toasts to the second app's
 * AUMID, and uninstalling either would delete the other's shortcut.
 */
function shortcutPathFor(dir, record, records) {
  const plain = path.win32.join(dir, shortcutFileName(record.name));
  const taken = records.some((r) => r.slug !== record.slug && typeof r.shortcutPath === "string" && path.win32.normalize(r.shortcutPath).toLowerCase() === plain.toLowerCase());
  return taken ? path.win32.join(dir, shortcutFileName(record.name, record.slug)) : plain;
}

const xmlEscape = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
// Characters XML 1.0 refuses (LoadXml throws on them, and the toast is lost):
// control characters other than tab and newlines, U+FFFE and U+FFFF, and
// halves of a surrogate pair standing alone.
const XML_INVALID = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
/** Toast text: XML-safe and at most `max` characters, cut between code points. */
const toastText = (s, max) => Array.from(String(s).replace(XML_INVALID, "")).slice(0, max).join("");
// A toast shows a few lines; the caps also keep the encoded script well under
// Windows' 32767-character command line, past which the spawn fails.
const TOAST_TITLE_MAX = 256;
const TOAST_BODY_MAX = 1024;
// ToastNotification.Tag holds 64 characters at most.
const TOAST_TAG_MAX = 64;

/**
 * The PowerShell that shows one toast under `appId` and reports what became
 * of it ("act", "dis", "fail" or "timeout").
 *
 * Electron's Notification cannot do this: its toast notifier is created once
 * per process with the process AUMID (shell/browser/notifications/win/
 * windows_toast_notification.cc, Initialize), so neither toastXml nor
 * changing the AUMID later moves a toast to another app. The WinRT
 * ToastNotificationManager takes any AUMID that a Start menu shortcut
 * carries, which install writes.
 *
 * The toast is a protocol toast: a click, on the banner or later in Action
 * Center, opens its launch link, codecast://app-notification/<slug>?tag=<tag>,
 * which reaches main as a deep link (host.js notificationClickFromUrl) and
 * becomes notification-click with the tag. The script only shows the toast
 * and exits: Windows PowerShell 5.1 cannot subscribe to a WinRT object's
 * events, so nothing here waits for Activated or Dismissed.
 */
/** The link a toast opens when clicked; host.js notificationClickFromUrl reads it back. */
function toastLaunchUrl(slug, tag) {
  return `codecast://app-notification/${slug}${tag ? `?tag=${encodeURIComponent(tag)}` : ""}`;
}

function windowsToastScript({ appId, slug, title, body, tag, silent }) {
  const text = body ? toastText(body, TOAST_BODY_MAX) : "";
  const tagText = tag == null ? "" : toastText(tag, TOAST_TAG_MAX);
  const launch = slug ? ` activationType="protocol" launch="${xmlEscape(toastLaunchUrl(slug, tagText))}"` : "";
  const xml = `<toast${launch}><visual><binding template="ToastGeneric"><text>${xmlEscape(toastText(title, TOAST_TITLE_MAX))}</text>${text ? `<text>${xmlEscape(text)}</text>` : ""}</binding></visual>${silent ? '<audio silent="true"/>' : ""}</toast>`;
  return [
    "$ErrorActionPreference = 'Stop'",
    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
    "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null",
    "$xml = New-Object Windows.Data.Xml.Dom.XmlDocument",
    `$xml.LoadXml(${psQuote(xml)})`,
    "$toast = New-Object Windows.UI.Notifications.ToastNotification $xml",
    tagText ? `$toast.Tag = ${psQuote(tagText)}` : "",
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(${psQuote(appId)}).Show($toast)`,
    "Write-Output 'shown'",
  ].filter(Boolean).join("\n");
}

/**
 * Shows one toast; `onDone` runs once, when its PowerShell process is gone or
 * after `killMs`, when a hung one is killed.
 */
function windowsToast(opts, spawnImpl = spawn, onDone = () => {}, killMs = TOAST_KILL_MS) {
  const script = windowsToastScript(opts);
  let finished = false;
  let timer = null;
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    onDone();
  };
  let child;
  try {
    child = spawnImpl("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true });
  } catch {
    return finish();
  }
  timer = setTimeout(() => {
    try {
      child.kill();
    } catch {}
    finish();
  }, killMs);
  if (typeof timer.unref === "function") timer.unref();
  child.on("error", finish);
  child.on("close", finish);
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
  const signedIn = deps.signedIn || (() => true);
  const spawnImpl = deps.spawn || spawn;
  const now = deps.now || Date.now;
  const launchArgs = app.isPackaged ? [] : [app.getAppPath()];
  const startMenuDir = () => path.win32.join(app.getPath("appData"), "Microsoft", "Windows", "Start Menu", "Programs", "Codecast Apps");
  // Electron joins login item args with spaces as they stand, so a path among
  // them is quoted here. The exe is left to Electron (no `path`), which quotes
  // it; a `path` given here would be written unquoted, and a profile folder
  // with a space in it would then start the wrong program or none.
  const setLoginItem = (slug, openAtLogin) =>
    app.setLoginItemSettings({ openAtLogin, args: [...launchArgs.map((a) => `"${a}"`), `--codecast-app=${slug}`], name: `CodecastApp-${slug}` });

  const apps = new Map(); // slug -> {win, popover, tray, shortcuts: Set, ignoreMouse, badge, toasts}
  const surfaces = new Map(); // webContents id -> {slug, surface, wc, frameVersion, loadVersion, covered}
  const sessions = new Set();
  let screenLocked = false;
  powerMonitor?.on?.("lock-screen", () => (screenLocked = true));
  powerMonitor?.on?.("unlock-screen", () => (screenLocked = false));

  const stateOf = (slug) => {
    if (!apps.has(slug)) {
      apps.set(slug, { win: null, popover: null, tray: null, shortcuts: new Set(), ignoreMouse: false, badge: 0, toasts: { running: false, queue: [], times: [] } });
    }
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

  /** The cover's Open Codecast control, from a covered surface only. True when it took the URL. */
  function coverAction(wc, slug, url) {
    const entry = surfaces.get(wc.id);
    if (!entry || !entry.covered || url !== OPEN_CODECAST) return false;
    Promise.resolve()
      .then(() => deps.openInCodecast && deps.openInCodecast(slug))
      .catch((err) => log(`open Codecast from ${slug}: ${err.message}`));
    return true;
  }

  function lockNavigation(wc, slug) {
    const guard = (event, url) => {
      if (pageUrlAllowed(url, slug, origins())) return;
      event.preventDefault();
      if (!coverAction(wc, slug, url)) openOutside(url);
    };
    wc.on("will-frame-navigate", (event) => {
      if (event.isMainFrame) guard(event, event.url);
    });
    wc.on("will-navigate", (event, url) => guard(event, url));
    wc.on("will-redirect", (event, url, _inPlace, isMainFrame) => {
      if (isMainFrame) guard(event, url);
    });
    wc.setWindowOpenHandler(({ url }) => {
      if (!coverAction(wc, slug, url)) openOutside(url);
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

  /** Loads the page into a surface, or the signed-out cover while Codecast is signed out. */
  function loadSurface(slug, surface, win) {
    const entry = surfaces.get(win.webContents.id);
    const covered = !signedIn();
    if (entry) {
      entry.loadVersion = factsVersion(slug);
      entry.covered = covered;
    }
    win.loadURL(covered ? signedOutCoverUrl((registry.get(slug) || {}).name || slug) : pageUrl(slug, surface));
  }

  function applyBadge(s) {
    if (!isWin || !alive(s.win)) return;
    const count = s.badge;
    s.win.setOverlayIcon(count > 0 ? nativeImage.createFromBitmap(badgeBitmap(), { width: 16, height: 16 }) : null, count > 0 ? String(count) : "");
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
    const entry = { slug, surface, wc, frameVersion: 0, loadVersion: factsVersion(slug), covered: false };
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
      // A badge the app set outlives its window. The taskbar button exists
      // only once the window is shown, and an overlay set before that is lost.
      win.once("show", () => applyBadge(s));
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
    loadSurface(slug, surface, win);
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
      for (const [surface, win] of [["window", s.win], ["tray", s.popover]]) if (alive(win)) loadSurface(slug, surface, win);
    },

    /** Codecast's sign-in changed: open surfaces swap between the page and the cover. */
    setSignedIn(on) {
      for (const [slug, s] of apps) {
        for (const [surface, win] of [["window", s.win], ["tray", s.popover]]) {
          if (!alive(win)) continue;
          const entry = surfaces.get(win.webContents.id);
          if (entry && entry.covered === !on) continue;
          loadSurface(slug, surface, win);
        }
      }
    },

    async install({ record, icons }) {
      if (!isWin) return {};
      const dir = startMenuDir();
      fs.mkdirSync(dir, { recursive: true });
      const shortcutPath = shortcutPathFor(dir, record, registry.list ? registry.list() : []);
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
          setLoginItem(slug, false);
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
    /** A toast's launch link came back (host.js handleUrl): the person clicked that app's notification. */
    notificationClicked(slug, tag) {
      focusApp(slug);
      emit(slug, "notification-click", { tag: tag ?? null });
    },
    reregisterShortcuts() {
      for (const [slug, s] of apps) for (const acc of s.shortcuts) if (!globalShortcut.isRegistered(acc)) bindShortcut(slug, acc);
    },

    // ── engine host methods (ctx, ...args) ──
    "app.notify": (ctx, { title, body, tag, silent }) => {
      const onClick = () => {
        focusApp(ctx.slug);
        emit(ctx.slug, "notification-click", { tag: tag ?? null });
      };
      const toasts = stateOf(ctx.slug).toasts;
      const at = now();
      toasts.times = toasts.times.filter((t) => at - t < 60_000);
      if (toasts.times.length >= NOTIFY_PER_MINUTE) throw new AppError("failed", "too many notifications");
      toasts.times.push(at);
      if (isWin) {
        const opts = { appId: aumid(ctx.slug), slug: ctx.slug, title, body, tag, silent };
        const next = () => {
          const job = toasts.queue.shift();
          if (!job) return void (toasts.running = false);
          toasts.running = true;
          windowsToast(job.opts, spawnImpl, next);
        };
        toasts.queue.push({ opts });
        if (toasts.queue.length > TOAST_QUEUE) {
          const dropped = toasts.queue.shift();
          log(`${ctx.slug}: dropped a waiting notification ("${dropped.opts.title}"); ${TOAST_QUEUE} newer ones are queued`);
        }
        if (!toasts.running) next();
        return;
      }
      if (!deps.notify) throw new AppError("failed", "notifications are not available here");
      deps.notify({ title: title, body: body || "", silent: !!silent }, onClick);
    },
    "app.badge": (ctx, count) => {
      const s = stateOf(ctx.slug);
      s.badge = count;
      applyBadge(s);
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
    "window.setVisibleOnAllWorkspaces": (ctx, on) => surfaceWindow(ctx).setVisibleOnAllWorkspaces(on, { visibleOnFullScreen: true }),
    "window.setIgnoreMouseEvents": (ctx, on) => {
      const win = surfaceWindow(ctx);
      stateOf(ctx.slug).ignoreMouse = on;
      win.setIgnoreMouseEvents(on, { forward: true });
    },
    "login.set": (ctx, on) => {
      if (!isWin) throw new AppError("failed", "open at login is set by the macOS host");
      setLoginItem(ctx.slug, on);
    },
  };
  return host;
}

module.exports = {
  toastLaunchUrl,
  createElectronHost,
  pageUrlAllowed,
  externalAllowed,
  castVersionHeader,
  shortcutFileName,
  shortcutPathFor,
  windowsToastScript,
  windowsToast,
  signedOutCoverUrl,
  popoverPosition,
  trayAnchor,
  badgeBitmap,
  aumid,
  WEB_PERMISSIONS,
  OPEN_CODECAST,
  NOTIFY_PER_MINUTE,
  TOAST_QUEUE,
  TOAST_KILL_MS,
  TOAST_TITLE_MAX,
  TOAST_BODY_MAX,
};
