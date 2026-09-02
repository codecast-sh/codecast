// The preload every Codecast window loads.
//
// The shared half of the bridge — versions, deep links, update status,
// notifications and window roles, shortcuts, the palette and compose popup,
// screen-share sources, the host policy, detached tab windows — is
// @platform/desktop's `createBridge`, so it is one implementation across every
// app on that shell, buffering rules included. Codecast's own half is spread
// over it below: the OS permission surface, the people window, the call window
// and its four sizes, the faces overlay, and meeting detection with its offer
// window. None of those exist in the package, and each is described where it
// is defined.
//
// The exposed object is the same shape it has always been, on the same global,
// hitting the same IPC channels.
const { contextBridge, ipcRenderer, webFrame } = require("electron");
const { createBridge, bufferedChannel } = require("@platform/desktop");

const zoomArg = process.argv.find(a => a.startsWith('--zoom-factor='));
if (zoomArg) {
  const z = parseFloat(zoomArg.split('=')[1]);
  if (z && isFinite(z)) webFrame.setZoomFactor(z);
}

// Registers its buffered listeners (deep-link, update-status, adopt-tab,
// window-role) as it is built, which is the point: this file runs before any
// page JS, so an event main sends during cold start is held and replayed on
// subscribe instead of landing on no listener and being silently dropped.
const shared = createBridge({ ipcRenderer, argv: process.argv });

// The call panel closing hands its room back to the main window. Buffered
// because a dropped one drops a live call: the panel is going away either way,
// so this message is the only thing that keeps the huddle alive.
const onCallPanelHandback = bufferedChannel(ipcRenderer, "call-panel-handback");

// A meeting app started on this machine and the shell is offering to record
// it. Buffered like a deep link: the offer is about something happening NOW,
// and one that lands while the renderer is still booting would otherwise be
// dropped in exactly the case it was written for — the app opening because the
// person just sat down to a meeting.
const onMeetingDetected = bufferedChannel(ipcRenderer, "meeting-detected");

contextBridge.exposeInMainWorld("__CODECAST_ELECTRON__", {
  ...shared,
  // OS-level permissions, read from the OS itself (osPermissions.js):
  // { notifications, microphone, camera, screen } each "granted" | "ask" |
  // "off" | "unknown". `request` performs the one gesture that makes the OS
  // ask (a notification post, askForMediaAccess, a capture attempt);
  // `openSettings` lands on the kind's System Settings pane.
  getOsPermissions: () => ipcRenderer.invoke("get-os-permissions"),
  requestOsPermission: (kind) => ipcRenderer.invoke("request-os-permission", kind),
  openOsPermissionSettings: (kind) => ipcRenderer.invoke("open-os-permission-settings", kind),
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
  // renderer it IS that window, so it takes the call over on load.
  //
  // `closeCallPanel({ended})` is hang-up: destroy the window. Any other close
  // — the X, the OS close box — HIDES it, like the palette. The huddle stays
  // here. `showCallPanel` raises it again from the rest of the app.
  isCallPanelWindow: process.argv.includes("--call-panel-window"),
  openCallPanel: (roomKey, opts) => ipcRenderer.invoke("open-call-panel", roomKey, opts ?? {}),
  showCallPanel: () => ipcRenderer.invoke("show-call-panel"),
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
  // The faces overlay: the team as circles floating over the work (route
  // /faces) when there is no call. Born see-through like the call window's
  // circle sizes, sharing their saved spot — it yields while a call is
  // minimized to circles and returns when the call ends. Its open state
  // persists across launches; the three see-through setters are the same
  // switches the call circles use, addressed to this window.
  isFacesWindow: process.argv.includes("--faces-window"),
  openFacesWindow: () => ipcRenderer.invoke("open-faces-window"),
  closeFacesWindow: () => ipcRenderer.invoke("close-faces-window"),
  getFacesWindowOpen: () => ipcRenderer.invoke("get-faces-window-open"),
  setFacesWindowInteractive: (on) => ipcRenderer.send("set-faces-window-interactive", on === true),
  setFacesWindowContentSize: (size) => ipcRenderer.send("set-faces-window-content-size", size),
  setFacesWindowDragging: (on) => ipcRenderer.send("set-faces-window-dragging", on === true),
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
});
