function originOf(value) {
  if (typeof value !== "string" || !URL.canParse(value)) return null;
  const url = new URL(value);
  return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.origin : null;
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

function installShellCapabilities({ authority, session, desktopCapturer, permissions }) {
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
      fetchWindowIcons: false,
    });
    return sources.map((src) => ({
      id: src.id,
      name: src.name,
      kind: src.id.startsWith("screen:") ? "screen" : "window",
      thumbnail: src.thumbnail.toDataURL(),
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
        if (pick) callback({ video: pick, audio: request.audioRequested ? "loopback" : undefined });
        else callback({});
      })
      .catch(() => callback({}));
  });

}

module.exports = { originOf, trustedShellUrl, createShellAuthority, installShellCapabilities };
