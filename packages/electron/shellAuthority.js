const net = require("node:net");

function originOf(value) {
  if (typeof value !== "string" || !URL.canParse(value)) return null;
  const url = new URL(value);
  return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.origin : null;
}

const PROD_URL = "https://codecast.sh";
// The local dev site: a from-source run's own. main.js decides whether this
// run may use it (never a packaged build) and marks the environment with
// LOCAL_DEV_FLAG, which is how the preload, a renderer with no `app`, learns
// the same answer.
const LOCAL_DEV_URL = "https://local.codecast.sh";
const LOCAL_DEV_FLAG = "CODECAST_LOCAL_DEV";

// The origins whose documents are the app: production, the local dev site
// when this run may use it, and the site the run was pointed at.
function shellOrigins({ localDev, baseUrl }) {
  return [...new Set([PROD_URL, localDev ? LOCAL_DEV_URL : null, originOf(baseUrl)].filter(Boolean))];
}

function trustedShellUrl(value, origins) {
  const origin = originOf(value);
  return origin !== null && origins.includes(origin);
}

function createShellAuthority({ ipcMain, origins, openExternal }) {
  const registered = new Set();
  const trusted = (url) => trustedShellUrl(url, origins());
  const isShell = (wc) => !!wc && registered.has(wc) && !wc.isDestroyed() && trusted(wc.getURL());
  const admits = (event) => isShell(event?.sender) && !!event.senderFrame &&
    event.senderFrame === event.sender.mainFrame && trusted(event.senderFrame.url) &&
    originOf(event.senderFrame.url) === originOf(event.sender.getURL());
  const register = (win) => {
    const wc = win.webContents;
    registered.add(wc);
    wc.once("destroyed", () => registered.delete(wc));
    const guard = (event, url) => {
      const target = url ?? event.url;
      if (trusted(target)) return;
      event.preventDefault();
      if (originOf(target)) openExternal(target);
    };
    wc.on("will-navigate", guard);
    wc.on("will-redirect", (event, url, _inPlace, isMainFrame) => {
      if (isMainFrame) guard(event, url);
    });
    wc.on("will-frame-navigate", (event) => {
      if (event.isMainFrame) guard(event, event.url);
      else if (!originOf(event.url) && event.url !== "about:blank") event.preventDefault();
    });
    return win;
  };
  const ipc = {
    handle: (channel, handler) => ipcMain.handle(channel, (event, ...args) => admits(event) ? handler(event, ...args) : null),
    on: (channel, handler) => ipcMain.on(channel, (event, ...args) => { if (admits(event)) handler(event, ...args); }),
    removeHandler: (channel) => ipcMain.removeHandler(channel),
  };
  const permission = (wc, details, requestingOrigin) => isShell(wc) && details?.isMainFrame === true &&
    trusted(details.requestingUrl) && originOf(details.requestingUrl) === originOf(wc.getURL()) &&
    (requestingOrigin === undefined || originOf(requestingOrigin) === originOf(wc.getURL()));
  const frameOwner = (frame) => [...registered].find((wc) => isShell(wc) && frame && wc.mainFrame === frame && trusted(frame.url));
  return { register, ipc, admits, isShell, permission, frameOwner };
}

// `onDisplaySource(owner, source)` hears which source a shell renderer's
// capture actually got (its own pick, or the fallback screen), so the shell can
// put things over what is being shared: teammates' cursors (shareCursors.js).
function installShellCapabilities({ authority, session, desktopCapturer, permissions, onDisplaySource }) {
  session.setPermissionRequestHandler((wc, permission, callback, details) => {
    callback(permissions().has(permission) && authority.permission(wc, details));
  });
  session.setPermissionCheckHandler((wc, permission, requestingOrigin, details) => {
    return permissions().has(permission) && authority.permission(wc, details, requestingOrigin);
  });
  const pendingDisplaySources = new WeakMap();
  authority.ipc.handle("desktop-sources", async (e, opts) => {
    if (!authority.isShell(e.sender)) return [];
    const types = Array.isArray(opts?.types) ? opts.types.filter((t) => t === "screen" || t === "window") : ["screen", "window"];
    const sources = await desktopCapturer.getSources({
      types,
      thumbnailSize: { width: 320, height: 200 },
      fetchWindowIcons: true,
    });
    return sources.map((src) => ({
      id: src.id,
      name: src.name,
      kind: src.id.startsWith("screen:") ? "screen" : "window",
      thumbnail: src.thumbnail.toDataURL(),
      appIcon: src.appIcon && !src.appIcon.isEmpty() ? src.appIcon.toDataURL() : undefined,
    }));
  });
  authority.ipc.handle("select-display-source", (e, id) => {
    if (!authority.isShell(e.sender)) return false;
    if (typeof id !== "string" || !/^(screen|window):/.test(id)) return false;
    pendingDisplaySources.set(e.senderFrame, { id, url: e.senderFrame.url });
    return true;
  });
  session.setDisplayMediaRequestHandler((request, callback) => {
    const frame = request.frame;
    const owner = authority.frameOwner(frame);
    if (!owner || originOf(request.securityOrigin) !== originOf(frame.url)) return callback({});
    const requestingUrl = frame.url;
    const selected = pendingDisplaySources.get(frame);
    pendingDisplaySources.delete(frame);
    const wanted = selected?.url === frame.url ? selected.id : null;
    desktopCapturer
      .getSources({ types: ["screen", "window"] })
      .then((sources) => {
        if (authority.frameOwner(frame) !== owner || frame.url !== requestingUrl) return callback({});
        const pick = (wanted && sources.find((s) => s.id === wanted)) || sources.find((s) => s.id.startsWith("screen:")) || sources[0];
        if (pick) {
          onDisplaySource?.(owner, { id: pick.id, displayId: pick.display_id || null });
          callback({ video: pick, audio: request.audioRequested ? "loopback" : undefined });
        }
        else callback({});
      })
      .catch(() => callback({}));
  });

}

// Certificate trust for the local dev site. It is served with a mkcert
// certificate that Electron's bundled Chromium rejects, so a run allowed to use
// it accepts that certificate, but only while the name points at this machine.
// The name resolves through ordinary DNS, so a network that answers it with
// another address gets Chromium's normal verification. `resolve` is the
// session's own resolver (session.resolveHost), the one whose cached answer the
// connection being verified just used. A certificate Chromium already accepts,
// and every other host, keep the normal path. Results follow
// setCertificateVerifyProc: 0 trusts, -3 defers to Chromium.
const LOOPBACK = new net.BlockList();
LOOPBACK.addSubnet("127.0.0.0", 8, "ipv4");
LOOPBACK.addAddress("::1", "ipv6");

function isLoopbackAddress(address) {
  const family = net.isIP(address);
  return family !== 0 && LOOPBACK.check(address, family === 4 ? "ipv4" : "ipv6");
}

function localDevCertVerifier({ enabled, resolve }) {
  const host = new URL(LOCAL_DEV_URL).hostname;
  return (request, callback) => {
    if (!enabled || request.hostname !== host || request.verificationResult === "net::OK") return callback(-3);
    Promise.resolve()
      .then(() => resolve(host))
      .then(
        (resolved) => {
          const addresses = (resolved?.endpoints ?? []).map((e) => e.address);
          callback(addresses.length > 0 && addresses.every(isLoopbackAddress) ? 0 : -3);
        },
        () => callback(-3),
      );
  };
}

module.exports = { originOf, trustedShellUrl, shellOrigins, LOCAL_DEV_URL, LOCAL_DEV_FLAG, createShellAuthority, installShellCapabilities, localDevCertVerifier, isLoopbackAddress };
