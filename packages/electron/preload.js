const { contextBridge, ipcRenderer, webFrame } = require("electron");

const zoomArg = process.argv.find(a => a.startsWith('--zoom-factor='));
if (zoomArg) {
  const z = parseFloat(zoomArg.split('=')[1]);
  if (z && isFinite(z)) webFrame.setZoomFactor(z);
}

// IPC events can fire during the cold-start window, before the page's React
// handler subscribes. This preload script runs before any page JS, so
// registering the IPC listener here (not lazily inside the on* subscribe
// call) guarantees it's live before main can ever send; events that land
// before subscribe are buffered and replayed on subscribe. Without this, an
// event sent during boot hits no listener and is silently dropped (a deep
// link would leave the app on whatever it restored; an adopted tab would be
// lost). Registering once also avoids the old leak of stacking a new
// ipcRenderer.on listener every time the subscribe function was called.
// { latest: true } keeps and replays only the most recent event (an update
// banner only cares about the current state).
function bufferedChannel(channel, { latest = false } = {}) {
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

// Deep links must survive cold start — a dropped one leaves the app on
// whatever it restored (its last conversation).
const onDeepLink = bufferedChannel("deep-link");

// Update status: only the most recent state matters, so the banner never
// misses a download that already progressed or finished.
const onUpdateStatus = bufferedChannel("update-status", { latest: true });

// Tabs handed back by detached tab windows. Buffered like deep links: an
// adoption can land while the main renderer is still booting, and a dropped
// one would silently lose the user's tab.
const onAdoptTab = bufferedChannel("adopt-tab");

// The call panel closing hands its room back to the main window. Buffered
// because a dropped one drops a live call: the panel is going away either way,
// so this message is the only thing that keeps the huddle alive.
const onCallPanelHandback = bufferedChannel("call-panel-handback");

// A meeting app started on this machine and the shell is offering to record
// it. Buffered like a deep link: the offer is about something happening NOW,
// and one that lands while the renderer is still booting would otherwise be
// dropped in exactly the case it was written for — the app opening because the
// person just sat down to a meeting.
const onMeetingDetected = bufferedChannel("meeting-detected");

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
  onDeepLink,
  onUpdateStatus,
  restartForUpdate: () => ipcRenderer.invoke("restart-for-update"),
  checkForUpdate: (opts) => ipcRenderer.invoke("check-for-update", opts),
  // Resolves { shown } — false when main dropped it (duplicate from another
  // window, or an app window is focused), so only the announcing window sounds.
  showNotification: (title, body, data) => ipcRenderer.invoke("show-notification", { title, body, data }),
  // OS-level permissions, read from the OS itself (osPermissions.js):
  // { notifications, microphone, camera, screen } each "granted" | "ask" |
  // "off" | "unknown". `request` performs the one gesture that makes the OS
  // ask (a notification post, askForMediaAccess, a capture attempt);
  // `openSettings` lands on the kind's System Settings pane.
  getOsPermissions: () => ipcRenderer.invoke("get-os-permissions"),
  requestOsPermission: (kind) => ipcRenderer.invoke("request-os-permission", kind),
  openOsPermissionSettings: (kind) => ipcRenderer.invoke("open-os-permission-settings", kind),
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
  onAdoptTab,
  // The people window: the floating buddy list (route /people). One per app —
  // openPeopleWindow focuses the existing one. `isPeopleWindow` tells this
  // renderer it IS that window, so it draws the panel and mounts the call and
  // walkie pumps. The always-on-top pin is honored only from that window and
  // persists across launches.
  isPeopleWindow: process.argv.includes("--people-window"),
  openPeopleWindow: () => ipcRenderer.invoke("open-people-window"),
  setAlwaysOnTop: (on) => ipcRenderer.invoke("set-always-on-top", on),
  getAlwaysOnTop: () => ipcRenderer.invoke("get-always-on-top"),
  // The call panel: a huddle in a window of its own (route /call-panel). One
  // per app, because one call at a time. `isCallPanelWindow` tells this
  // renderer it IS that window, so it takes the call over on load and treats
  // its own closing as a handoff rather than a hang-up.
  //
  // `closeCallPanel({ended})` is how the panel says WHY it is closing: a
  // hang-up ended the call and nothing is handed anywhere, while any other
  // close — including the OS close box, which says nothing — hands the room
  // back to the main window. `reportCallPanelState` keeps the shell holding
  // the payload for that handback: the same room, in the same mic, camera and
  // scribe state the person was already in.
  isCallPanelWindow: process.argv.includes("--call-panel-window"),
  openCallPanel: (roomKey, opts) => ipcRenderer.invoke("open-call-panel", roomKey, opts ?? {}),
  closeCallPanel: (opts) => ipcRenderer.invoke("close-call-panel", opts ?? {}),
  reportCallPanelState: (state) => ipcRenderer.send("report-call-panel-state", state),
  onCallPanelHandback,
  // The four sizes. One window, because `transparent` and `frame` are decided
  // when a window is CONSTRUCTED: the call window is born see-through and
  // frameless, and changing size reshapes it in place rather than handing the
  // call to another window — a call changing shape must never be a call
  // re-joining a room.
  //
  //   panel     the stage, a card the person resizes by its edges
  //   circles   everybody, as a row of face circles over the work
  //   speaker   one circle, whoever is talking
  //   tiny      the same circle at the size of a menu bar icon
  //
  // The last three setters are what the see-through sizes need and the stage
  // does not: `setCallWindowInteractive` decides whether the window takes the
  // mouse at all (off except over a circle, so a click on the desktop behind
  // reaches the desktop), `setCallWindowContentSize` keeps the window exactly
  // as big as its circles, and `setCallWindowDragging` has the shell follow the
  // cursor while a circle is held — a drag region would eat the mouse events
  // the renderer needs to know the pointer left. The stage drags by a real
  // drag region instead, since nothing there is competing for those events.
  setCallWindowSize: (size) => ipcRenderer.invoke("set-call-window-size", size),
  getCallWindowSize: () => ipcRenderer.invoke("get-call-window-size"),
  setCallWindowInteractive: (on) => ipcRenderer.send("set-call-window-interactive", on === true),
  setCallWindowContentSize: (size) => ipcRenderer.send("set-call-window-content-size", size),
  setCallWindowDragging: (on) => ipcRenderer.send("set-call-window-dragging", on === true),
  // Meeting detection: the shell polls the names of running programs (and
  // nothing else) while the setting is on, and offers to record when a meeting
  // app starts. The ANSWER lives here in the web layer — main never starts a
  // recording, it only says a meeting looks like it began.
  onMeetingDetected,
  getMeetingDetect: () => ipcRenderer.invoke("get-meeting-detect"),
  setMeetingDetect: (patch) => ipcRenderer.invoke("set-meeting-detect", patch ?? {}),
  // The meeting-offer window: the record-this-meeting card as a small
  // chromeless corner window (route /meeting-offer). It renders the offer AND
  // runs the recording it starts, so the shell only reshapes the window
  // around the content it reports (the first report is the reveal — always
  // without focus), hides it on request, and lands "open the transcript" in
  // the main window.
  isMeetingOfferWindow: process.argv.includes("--meeting-offer-window"),
  meetingOfferSize: (size) => ipcRenderer.send("meeting-offer-size", size),
  meetingOfferHide: () => ipcRenderer.send("meeting-offer-hide"),
  meetingOfferOpenCall: (id) => ipcRenderer.send("meeting-offer-open-call", id),
  platform: process.platform,
});
