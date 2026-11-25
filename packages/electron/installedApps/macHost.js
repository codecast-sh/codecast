// The macOS installed-app host (docs/architecture/installed-apps.md, "Hosting"):
// the platform host host.js builds on darwin. Each installed app is its own
// native bundle running the Swift shim (appshim/). The shim reaches Codecast
// over a Unix socket; this module serves that socket, hands page calls to the
// engine, pushes host events back, and builds, re-seals and removes bundles.
//
// What runs where:
//   - Notifications, badge, tray, shortcuts, the window and open-at-login are
//     the shim's: the engine decides the call, this host answers null, and the
//     shim performs the OS action when the reply says ok.
//   - Consent, agent.ask and shell.open run in host.js (shared with Windows);
//     files and programs in the engine itself (fullAccess.js).
//
// The socket carries two kinds of request from a shim:
//   {app, frame: {version, surface}, msg: {id, module, method, args}}  a page call, for the engine
//   {app, host: <action>, data, msg: {id}}                              the shim's own request
// A page can only produce the first: the shim builds every envelope itself.
// Host actions: "report" (what only the shim knows: notification
// authorization, its window frame, that it came forward), "open-in-codecast",
// "uninstall" (the shim already asked the person).
// Host-only events the shim keeps to itself: "host-state" {signedIn},
// "host-reload" and "host-quit".
//
// createMacHost(deps) -> the platform host host.js expects:
//   name, emit, open, reload, isOpen, anchor, install({record, info, icons}),
//   uninstall(record), closeAll(), resealAll(), every shim-owned engine method,
//   plus serve() (listen on the socket), stop(), setSignedIn(on), status(slug),
//   bundleFor(slug), sealKey().
//
// deps (host.js's createPlatform deps, plus the mac ones):
//   call(slug, frame, msg)  -> reply envelope (engine.handle)
//   onFocus(slug)           an app came forward
//   onClosed(slug)          an app's last connection went away
//   socketPath              <userData>/apps.sock
//   hostVersion             Codecast's version; the shim puts it in its user agent
//   shimBinaryPath          the universal shim (shimBinaryPath() finds the shipped one)
//   hostBundleId            default sh.codecast.desktop
//   root                    default ~/Applications/Codecast Apps
//   pageOrigin              default https://a.codecast.sh
//   signedIn()              whether Codecast has a signed-in person (default true)
//   uninstallApp(slug)      the full uninstall (host.js's), run when the shim asks
//   openInCodecast(slug)    shows the page in Codecast's main window
//   onStatus(slug)          a shim connected, went away or reported
//   fetchIcon(url)          -> Buffer of a PNG (default fetch), when no icon file is given
//   register, home          pass-throughs to appshim/install.js (tests)
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const installer = require("../appshim/install");
const { AppError, ok, replyFor, serveSocket, clientSource } = require("./protocol");
const { HOST_METHODS } = require("./engine");
const { isSlug } = require("./registry");

/** Calls the main process answers itself; every other host method is the shim's. */
const MAIN_METHODS = new Set(["agent.ask", "shell.open"]);
/** Window calls the shim performs that newer engines know (overlay). */
const SHIM_EXTRA = ["window.setVisibleOnAllWorkspaces", "window.setIgnoreMouseEvents"];
const GATE_KEYS = ["k", "e", "m"];
const QUIT_WAIT_MS = 3000;

/** Where the shim binary is: in Codecast.app's Resources when packaged, else the local build. */
function shimBinaryPath({ resourcesPath = process.resourcesPath, packaged = false } = {}) {
  return packaged
    ? path.join(resourcesPath, "appshim", "CodecastAppShim")
    : path.join(__dirname, "..", "appshim", "build", "CodecastAppShim");
}

const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");

/** The page URL a bundle loads: the slug under the page origin, host=app, and the install's gate keys. */
function pageUrlFor(slug, gate = {}, pageOrigin = "https://a.codecast.sh") {
  const url = new URL(`${pageOrigin.replace(/\/$/, "")}/${encodeURIComponent(slug)}`);
  url.searchParams.set("host", "app");
  for (const k of GATE_KEYS) if (typeof gate[k] === "string" && gate[k]) url.searchParams.set(k, gate[k]);
  return url.toString();
}

async function defaultFetchIcon(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`icon ${res.status} from ${new URL(url).origin}`);
  return Buffer.from(await res.arrayBuffer());
}

function createMacHost(deps) {
  const {
    socketPath,
    hostVersion,
    call,
    onFocus = () => {},
    onClosed = () => {},
    hostBundleId = "sh.codecast.desktop",
    root = installer.defaultRoot(),
    pageOrigin = "https://a.codecast.sh",
    signedIn = () => true,
    uninstallApp,
    openInCodecast,
    onStatus = () => {},
    fetchIcon = defaultFetchIcon,
    register = true,
    home = os.homedir(),
    log = () => {},
  } = deps;
  const shimPath = deps.shimBinaryPath || shimBinaryPath();
  if (!socketPath) throw new Error("createMacHost needs socketPath");
  if (!hostVersion) throw new Error("createMacHost needs hostVersion");

  /** slug -> Set of shim connections. A connection belongs to the app named by its first message. */
  const conns = new Map();
  const appOf = new Map();
  /** slug -> what its shim last reported: {notifications, frame}. */
  const reports = new Map();
  let serving = null;
  const sockets = new Set();
  let lastSignedIn = null;

  function emit(slug, event, data) {
    for (const conn of conns.get(slug) || []) conn.send({ event, data });
  }

  /** The engine methods the shim performs: allowed calls answer null, and the shim acts on the ok. */
  const shimMethods = {};
  for (const key of [...HOST_METHODS, ...SHIM_EXTRA]) if (!MAIN_METHODS.has(key)) shimMethods[key] = () => null;

  // ── the socket ──
  function identify(conn, slug) {
    const known = appOf.get(conn);
    if (known) {
      if (known !== slug) throw new AppError("denied", `this connection belongs to ${known}`);
      return;
    }
    appOf.set(conn, slug);
    if (!conns.has(slug)) conns.set(slug, new Set());
    conns.get(slug).add(conn);
    conn.send({ event: "host-state", data: { signedIn: !!signedIn() } });
    onStatus(slug);
  }

  async function hostRequest(slug, action, data) {
    switch (action) {
      case "report": {
        const prev = reports.get(slug) || {};
        const next = { ...prev };
        if (data && typeof data.notifications === "string") next.notifications = data.notifications;
        if (data && validFrame(data.frame)) next.frame = data.frame;
        reports.set(slug, next);
        if (data && data.active === true) onFocus(slug);
        if (next.notifications !== prev.notifications) onStatus(slug);
        return null;
      }
      case "open-in-codecast":
        if (typeof openInCodecast !== "function") throw new AppError("failed", "Codecast cannot open pages yet");
        await openInCodecast(slug);
        return null;
      case "uninstall":
        if (typeof uninstallApp !== "function") throw new AppError("failed", "Codecast cannot uninstall apps yet");
        // The shim quits on this reply; removing its files waits for that, so it runs after.
        setImmediate(() => Promise.resolve().then(() => uninstallApp(slug)).catch((err) => log(`uninstall ${slug}: ${err.message}`)));
        return null;
      default:
        throw new AppError("unknown-method", `no host action ${action}`);
    }
  }

  async function onMessage(conn, message) {
    const id = message && message.msg && message.msg.id !== undefined ? message.msg.id : null;
    const slug = message && message.app;
    if (!isSlug(slug)) return replyFor(id, new AppError("bad-args", "a message names its app"));
    try {
      identify(conn, slug);
    } catch (err) {
      return replyFor(id, err);
    }
    if (typeof message.host === "string") {
      try {
        return ok(id, await hostRequest(slug, message.host, message.data));
      } catch (err) {
        return replyFor(id, err);
      }
    }
    return call(slug, message.frame || {}, message.msg);
  }

  function onClose(conn) {
    const slug = appOf.get(conn);
    if (!slug) return;
    appOf.delete(conn);
    const set = conns.get(slug);
    set.delete(conn);
    if (set.size === 0) {
      conns.delete(slug);
      onClosed(slug);
    }
    onStatus(slug);
  }

  /**
   * Listens on the socket; calling it again returns the same listener. host.js
   * re-seals (resealAll) before this, so no app connects to a stale bundle.
   */
  function serve() {
    if (!serving) {
      fs.mkdirSync(path.dirname(socketPath), { recursive: true });
      lastSignedIn = !!signedIn();
      serving = serveSocket(socketPath, { onMessage, onClose }).then((s) => {
        s.on("connection", (socket) => {
          sockets.add(socket);
          socket.on("close", () => sockets.delete(socket));
        });
        return s;
      });
    }
    return serving;
  }

  /** Stops listening and drops every shim connection (each retries until Codecast is back). */
  async function stop() {
    if (!serving) return;
    const s = await serving.catch(() => null);
    serving = null;
    for (const socket of sockets) socket.destroy();
    if (s) await new Promise((resolve) => s.close(() => resolve()));
  }

  /** Codecast's sign-in changed: every open app hears it and covers or uncovers its page. */
  function setSignedIn(on) {
    if (lastSignedIn === !!on) return;
    lastSignedIn = !!on;
    for (const slug of conns.keys()) emit(slug, "host-state", { signedIn: lastSignedIn });
  }

  // ── bundles ──
  const bundles = () => installer.listBundles(root);
  const bundleFor = (slug) => bundles().find((b) => b.info.CodecastAppSlug === slug) || null;

  /** What a bundle sealed by this Codecast carries; a bundle with another key is re-sealed. */
  function sealKey() {
    return sha256([sha256(fs.readFileSync(shimPath)), sha256(clientSource()), hostVersion, socketPath, hostBundleId].join("\n")).slice(0, 32);
  }

  /**
   * Builds (or rebuilds) the bundle for one install. `record` is the registry
   * record, `info` the page's app info (api.artifacts.appInfo), `icons` the
   * icon set host.js wrote (its `png` is the page's 1024 icon). Two pages with
   * one name get distinct bundles ("Vitals.app", "Vitals 2.app"); a renamed
   * page replaces its old bundle, keeping its data. Returns a record patch.
   */
  async function install({ record, info, icons }) {
    const slug = (record && record.slug) || info.slug;
    const app = info.app || {};
    const name = app.name || (record && record.name) || info.title || slug;
    const existing = bundleFor(slug);

    const given = [icons && icons.png, record && record.iconPath].find((p) => p && fs.existsSync(p));
    let iconPngPath = given || null;
    let tmp = null;
    if (!iconPngPath) {
      const url = info.icons && (info.icons["1024"] || info.icons["512"]);
      if (!url) throw new AppError("failed", `${slug} has no icon to install`);
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codecast-app-icon-"));
      iconPngPath = path.join(tmp, "icon.png");
      fs.writeFileSync(iconPngPath, await fetchIcon(url));
    }
    try {
      const appPath = installer.freeBundlePath(name, root, (p) => existing !== null && p === existing.path);
      const result = installer.install({
        slug,
        name,
        appPath,
        root,
        iconPngPath,
        shimBinaryPath: shimPath,
        pageUrl: pageUrlFor(slug, info.gate || {}, pageOrigin),
        hostBundleId,
        socketPath,
        hostVersion,
        sealKey: sealKey(),
        window: app.window || {},
        tray: app.tray || {},
        version: info.version || 1,
        register,
      });
      if (existing && existing.path !== result.path) installer.uninstall({ appPath: existing.path, register });
      return { bundlePath: result.path };
    } finally {
      if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  function waitForQuit(slug, ms) {
    return new Promise((resolve) => {
      const deadline = Date.now() + ms;
      const tick = () => (!conns.has(slug) || Date.now() >= deadline ? resolve() : setTimeout(tick, 50));
      tick();
    });
  }

  /**
   * Removes one app's bundle, its Launch Services record and the data macOS
   * keeps for its bundle id. A running app is asked to quit first, so it
   * cannot write its data back. Takes the record (host.js) or a slug.
   */
  async function uninstall(recordOrSlug) {
    const slug = typeof recordOrSlug === "string" ? recordOrSlug : recordOrSlug.slug;
    if (conns.has(slug)) {
      emit(slug, "host-quit", {});
      await waitForQuit(slug, QUIT_WAIT_MS);
    }
    const found = bundleFor(slug);
    const removed = installer.uninstall({ appPath: found ? found.path : null, slug, register, home });
    reports.delete(slug);
    onStatus(slug);
    return removed;
  }

  /**
   * On Codecast's launch: every bundle sealed by another Codecast (another
   * shim, page client, version or socket) gets the current shim and client and
   * is re-sealed. Bundles already current are left alone.
   */
  function resealAll() {
    if (!fs.existsSync(shimPath)) {
      log(`reseal: no shim at ${shimPath}`);
      return [];
    }
    const key = sealKey();
    return bundles().map(({ path: appPath, info }) => {
      const slug = info.CodecastAppSlug;
      if (info.CodecastSealKey === key) return { slug, path: appPath, resealed: false };
      try {
        installer.reseal({
          appPath,
          shimBinaryPath: shimPath,
          plist: { CodecastHostVersion: hostVersion, CodecastSocketPath: socketPath, CodecastHostBundleId: hostBundleId, CodecastSealKey: key },
          register,
        });
        return { slug, path: appPath, resealed: true };
      } catch (err) {
        log(`reseal ${appPath}: ${err.message}`);
        return { slug, path: appPath, resealed: false, error: err.message };
      }
    });
  }

  /** Opens (or brings forward) an installed app. A tray surface opens from the app's own menu bar item. */
  function open(slug) {
    const found = bundleFor(slug);
    if (!found) return Promise.reject(new AppError("not-installed", `${slug} is not installed on this computer`));
    return new Promise((resolve, reject) => execFile("open", [found.path], (err) => (err ? reject(err) : resolve())));
  }

  /** What Settings shows for an app beyond its record. */
  function status(slug) {
    const found = bundleFor(slug);
    const bundleId = installer.bundleId(slug);
    return {
      installed: !!found,
      path: found ? found.path : null,
      running: conns.has(slug),
      notifications: (reports.get(slug) || {}).notifications || null,
      notificationSettingsUrl: `x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=${bundleId}`,
    };
  }

  /** The app's window in Electron's screen coordinates (top-left origin), as its shim last reported it. */
  function anchor(slug) {
    const r = reports.get(slug);
    return conns.has(slug) && r && r.frame ? { ...r.frame } : null;
  }

  return {
    name: "mac",
    ...shimMethods,
    emit,
    open,
    reload: (slug) => emit(slug, "host-reload", {}),
    isOpen: (slug) => conns.has(slug),
    anchor,
    install,
    uninstall,
    // Shims keep running when Codecast quits and reconnect when it is back.
    closeAll: () => {},
    resealAll,
    serve,
    stop,
    setSignedIn,
    status,
    bundleFor,
    sealKey,
  };
}

const validFrame = (f) => !!f && ["x", "y", "width", "height"].every((k) => Number.isFinite(f[k])) && f.width > 0 && f.height > 0;

module.exports = { createMacHost, shimBinaryPath, pageUrlFor, MAIN_METHODS };
