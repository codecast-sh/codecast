// The renderer facing bridge. `createBridge` builds the object the preload
// exposes on window[<bridgeGlobal>] from an ipcRenderer-shaped transport, so the
// buffering rules can be tested without Electron; preload.js wires the real one.

// IPC events can fire during the cold-start window, before the page's React
// handler subscribes. The preload script runs before any page JS, so
// registering the IPC listener here (not lazily inside the on* subscribe
// call) guarantees it's live before main can ever send; events that land
// before subscribe are buffered and replayed on subscribe. Without this, an
// event sent during boot hits no listener and is silently dropped (a deep
// link would leave the app on whatever it restored; an adopted tab would be
// lost). Registering once also avoids the old leak of stacking a new
// ipcRenderer.on listener every time the subscribe function was called.
// { latest: true } keeps and replays only the most recent event (an update
// banner only cares about the current state).
function bufferedChannel(ipcRenderer, channel, { latest = false } = {}) {
  let handler = null;
  let buffer = [];
  let last = null;
  ipcRenderer.on(channel, (_e, payload) => {
    if (latest) last = payload;
    if (handler) handler(payload);
    else if (!latest) buffer.push(payload);
  });
  return (cb) => {
    handler = cb;
    if (latest) {
      if (last) cb(last);
    } else if (buffer.length) {
      const pending = buffer;
      buffer = [];
      for (const p of pending) cb(p);
    }
  };
}

// Read a `--name=value` flag from the preload's argv (set by the main process
// through webPreferences.additionalArguments).
function argValue(argv, name) {
  const hit = (argv || []).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

function createBridge({ ipcRenderer, argv = [], platform = process.platform }) {
  // Deep links must survive cold start — a dropped one leaves the app on
  // whatever it restored (its last conversation).
  const onDeepLink = bufferedChannel(ipcRenderer, "deep-link");

  // Update status: only the most recent state matters, so the banner never
  // misses a download that already progressed or finished.
  const onUpdateStatus = bufferedChannel(ipcRenderer, "update-status", { latest: true });

  // The offline copy of the site moved to a new release while this page was
  // up. Latest only: the page decides when to reload into it.
  const onWebUpdate = bufferedChannel(ipcRenderer, "web-update", { latest: true });

  // Tabs handed back by detached tab windows. Buffered like deep links: an
  // adoption can land while the main renderer is still booting, and a dropped
  // one would silently lose the user's tab.
  const onAdoptTab = bufferedChannel(ipcRenderer, "adopt-tab");

  // Window role (notification leader / app focus / any call) is pushed by main
  // whenever windows or focus change. Keep the latest so a subscriber that
  // mounts after the first push starts from the truth instead of a default.
  let windowRoleHandler = null;
  let lastWindowRole = null;
  ipcRenderer.on("window-role", (_e, role) => {
    lastWindowRole = role;
    if (windowRoleHandler) windowRoleHandler(role);
  });

  return {
    getVersion: () => ipcRenderer.invoke("get-app-version"),
    setBadgeCount: (count) => ipcRenderer.invoke("set-badge-count", count),
    getEnv: () => ipcRenderer.invoke("get-env"),
    onDeepLink,
    onUpdateStatus,
    restartForUpdate: () => ipcRenderer.invoke("restart-for-update"),
    onWebUpdate,
    // The offline copy: { release, dir } or null, and a refresh on demand.
    getWebRelease: () => ipcRenderer.invoke("get-web-release"),
    refreshWeb: () => ipcRenderer.invoke("refresh-web"),
    // URL schemes beyond the app's own (mailto:, …): ask the OS to make this
    // app their handler (macOS confirms with its own dialog), and read back
    // whether it is.
    setAsDefaultClient: (scheme) => ipcRenderer.invoke("set-default-client", scheme),
    isDefaultClient: (scheme) => ipcRenderer.invoke("is-default-client", scheme),
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
    isTabWindow: argv.includes("--tab-window"),
    detachTab: (navPath) => ipcRenderer.invoke("detach-tab", navPath),
    attachTab: (navPath) => ipcRenderer.invoke("attach-tab", navPath),
    onAdoptTab,
    platform,
  };
}

// Every method name the bridge exposes, in one place, so the web side's type
// and a consumer's compatibility check can be derived rather than retyped.
const BRIDGE_METHODS = Object.keys(
  createBridge({ ipcRenderer: { on() {}, invoke() {}, send() {}, removeListener() {} }, argv: [] }),
);

module.exports = { createBridge, bufferedChannel, argValue, BRIDGE_METHODS };
