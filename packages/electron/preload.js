const { contextBridge, ipcRenderer, webFrame } = require("electron");

const zoomArg = process.argv.find(a => a.startsWith('--zoom-factor='));
if (zoomArg) {
  const z = parseFloat(zoomArg.split('=')[1]);
  if (z && isFinite(z)) webFrame.setZoomFactor(z);
}

// Deep links must survive the cold-start window. This preload script runs
// before any page JS, so registering the IPC listener here (not lazily inside
// onDeepLink) guarantees it's live before main can ever send. Links that land
// before the page's React handler subscribes are buffered and replayed on
// subscribe — without this, a deep link sent during boot hits no listener and
// is silently dropped, leaving the app on whatever it restored (its last
// conversation). Registering once also avoids the old leak of stacking a new
// ipcRenderer.on listener every time onDeepLink was called.
let deepLinkHandler = null;
let deepLinkBuffer = [];
ipcRenderer.on("deep-link", (_e, url) => {
  if (deepLinkHandler) deepLinkHandler(url);
  else deepLinkBuffer.push(url);
});

// Update status can fire during cold start, before the page's React handler has
// subscribed. Keep the latest one and replay it on subscribe so the banner
// never misses a download that already progressed or finished (same reasoning
// as the deep-link buffer above, but we only care about the most recent state).
let updateStatusHandler = null;
let lastUpdateStatus = null;
ipcRenderer.on("update-status", (_e, status) => {
  lastUpdateStatus = status;
  if (updateStatusHandler) updateStatusHandler(status);
});

// Tabs handed back by detached tab windows. Buffered like deep links: an
// adoption can land while the main renderer is still booting, and a dropped
// one would silently lose the user's tab.
let adoptTabHandler = null;
let adoptTabBuffer = [];
ipcRenderer.on("adopt-tab", (_e, navPath) => {
  if (adoptTabHandler) adoptTabHandler(navPath);
  else adoptTabBuffer.push(navPath);
});

// Window role (notification leader / app focus / any call) is pushed by main
// whenever windows or focus change. Keep the latest so a subscriber that
// mounts after the first push starts from the truth instead of a default.
let windowRoleHandler = null;
let lastWindowRole = null;
ipcRenderer.on("window-role", (_e, role) => {
  lastWindowRole = role;
  if (windowRoleHandler) windowRoleHandler(role);
});

contextBridge.exposeInMainWorld("__CODECAST_ELECTRON__", {
  getVersion: () => ipcRenderer.invoke("get-app-version"),
  setBadgeCount: (count) => ipcRenderer.invoke("set-badge-count", count),
  getEnv: () => ipcRenderer.invoke("get-env"),
  onDeepLink: (cb) => {
    deepLinkHandler = cb;
    if (deepLinkBuffer.length) {
      const pending = deepLinkBuffer;
      deepLinkBuffer = [];
      for (const url of pending) cb(url);
    }
  },
  onUpdateStatus: (cb) => {
    updateStatusHandler = cb;
    if (lastUpdateStatus) cb(lastUpdateStatus);
  },
  restartForUpdate: () => ipcRenderer.invoke("restart-for-update"),
  checkForUpdate: (opts) => ipcRenderer.invoke("check-for-update", opts),
  // Resolves { shown } — false when main dropped it (duplicate from another
  // window, or an app window is focused), so only the announcing window sounds.
  showNotification: (title, body, data) => ipcRenderer.invoke("show-notification", { title, body, data }),
  // Multi-window notification routing: each renderer tells main what it shows
  // ({ active, open: [{id,path}], inCall }); main answers with this window's
  // role ({ leader, appFocused, anyInCall }) whenever it changes.
  reportWindowState: (state) => ipcRenderer.send("report-window-state", state),
  onWindowRole: (cb) => {
    windowRoleHandler = cb;
    if (lastWindowRole) cb(lastWindowRole);
  },
  getShortcuts: () => ipcRenderer.invoke("get-shortcuts"),
  getShortcutConfig: () => ipcRenderer.invoke("get-shortcut-config"),
  setShortcut: (key, accelerator) => ipcRenderer.invoke("set-shortcut", key, accelerator),
  paletteNavigate: (path) => ipcRenderer.send("palette-navigate", path),
  paletteHide: () => ipcRenderer.send("palette-hide"),
  paletteNewSession: () => ipcRenderer.send("palette-new-session"),
  // The palette window reports which face it has painted (compose / search);
  // main reveals the window only when that matches what it asked for, so the
  // previous face never flashes before the swap.
  paletteReady: (mode) => ipcRenderer.send("palette-ready", mode),
  onPaletteShow: (cb) => {
    const handler = () => cb();
    ipcRenderer.on("palette-show", handler);
    return () => ipcRenderer.removeListener("palette-show", handler);
  },
  // Compose popup: main asks the palette window to show the new-session
  // compose view; the window reports back how to finish (fire-and-forget vs
  // send & open) so main can manage focus.
  onComposeShow: (cb) => {
    const handler = () => cb();
    ipcRenderer.on("compose-show", handler);
    return () => ipcRenderer.removeListener("compose-show", handler);
  },
  composeSubmit: (data) => ipcRenderer.send("compose-submit", data),
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
  getSystemIdleSeconds: () => ipcRenderer.invoke("get-system-idle-seconds"),
  // Screen-share primitives. The shell hands the web layer the list of
  // capturable screens/windows (with thumbnails) and lets it pre-select one
  // for the NEXT getDisplayMedia call — so the web builds whatever picker UI
  // it wants, and the shell never needs a release for it. Absent a selection
  // the primary screen is captured.
  getDisplaySources: (opts) => ipcRenderer.invoke("desktop-sources", opts),
  selectDisplaySource: (id) => ipcRenderer.invoke("select-display-source", id),
  // Host capability policy: read the effective grant table, or extend it
  // (additive; persisted). Lets the web enable a new permission-gated
  // feature without a shell release. Absent on older builds — gate on it.
  hostPolicy: (patch) => ipcRenderer.invoke("host-policy", patch ?? null),
  // Detached tab windows: this renderer IS one (flag set by createTabWindow's
  // additionalArguments), break a tab out, hand one back, adopt one returned.
  isTabWindow: process.argv.includes("--tab-window"),
  detachTab: (navPath) => ipcRenderer.invoke("detach-tab", navPath),
  attachTab: (navPath) => ipcRenderer.invoke("attach-tab", navPath),
  onAdoptTab: (cb) => {
    adoptTabHandler = cb;
    if (adoptTabBuffer.length) {
      const pending = adoptTabBuffer;
      adoptTabBuffer = [];
      for (const p of pending) cb(p);
    }
  },
  platform: process.platform,
});
