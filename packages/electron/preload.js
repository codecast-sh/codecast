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

// The ring window answered; the call window is the one that joins. Buffered
// because that window is usually being CREATED by this very answer — the
// message would otherwise land before the page has a listener, and the person
// would have pressed Join on a huddle nobody joined.
const onCallRingAccept = bufferedChannel(ipcRenderer, "call-ring-accept");

// A room for the voice window to join, and a command from another window
// (press, join, hang up) for the host to carry out. Both buffered: the host is
// persistent, but a request that lands in the second between its page loading
// and its listener mounting is somebody's Talk press, and it must not vanish.
const onCallPanelOpen = bufferedChannel(ipcRenderer, "call-panel-open");
const onVoiceCommand = bufferedChannel(ipcRenderer, "voice-command");
// Another window asked for the call to be shown: the host stops hiding it.
const onCallPanelShow = bufferedChannel(ipcRenderer, "call-panel-show", { latest: true });

// What the host is doing — its walkie and call facts — for every other
// window's talk keys. Latest only: a window that subscribes late wants the
// truth now, not a replay of every partial transcript on the way to it.
const onVoiceMirror = bufferedChannel(ipcRenderer, "voice-mirror", { latest: true });

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
  // With a voice host the buddy list is the WALL, a shape of that window;
  // opening it is a standing arrangement the host takes up, and this puts it
  // away again. On an older arrangement it closes the people window.
  closePeopleWindow: () => ipcRenderer.invoke("close-people-window"),
  setAlwaysOnTop: (on) => ipcRenderer.invoke("set-always-on-top", on),
  getAlwaysOnTop: () => ipcRenderer.invoke("get-always-on-top"),
  // The voice window (route /call-panel): ONE persistent see-through window
  // that holds everything with a microphone in it — the walkie's ear and its
  // strip, the idle team as circles, and the call in all four of its sizes.
  // `isCallPanelWindow` tells this renderer it IS that window.
  //
  // `closeCallPanel` hides it, like the palette; the huddle stays here.
  // `showCallPanel` raises it again from the rest of the app. `openCallPanel`
  // hands it a room — as a command when the renderer has declared itself the
  // host (`voiceHostReady`), in its URL otherwise.
  isCallPanelWindow: process.argv.includes("--call-panel-window"),
  openCallPanel: (roomKey, opts) => ipcRenderer.invoke("open-call-panel", roomKey, opts ?? {}),
  showCallPanel: () => ipcRenderer.invoke("show-call-panel"),
  closeCallPanel: (opts) => ipcRenderer.invoke("close-call-panel", opts ?? {}),
  reportCallPanelState: (state) => ipcRenderer.send("report-call-panel-state", state),
  onCallPanelHandback,
  onCallRingAccept,
  onCallPanelOpen,
  onCallPanelShow,
  // The host declares itself once its page is up: from then on rooms arrive
  // as commands, a hang-up is a hide, and every other window is a remote.
  voiceHostReady: () => ipcRenderer.send("voice-host-ready"),
  // Remotes. A press on a talk key, a join, an answered ring or a hang-up in
  // any other window is sent here and carried out by the host, which holds
  // the only microphone. Resolves false when no host took it, so the caller
  // can act locally on a shell (or in a moment) without one.
  voiceCommand: (cmd, args) => ipcRenderer.invoke("voice-command", cmd, args ?? []),
  onVoiceCommand,
  // The host mirrors its walkie and call facts to every other window, and
  // every other window reads them off this.
  voiceMirror: (payload) => ipcRenderer.send("voice-mirror", payload),
  onVoiceMirror,
  // The shapes. One window, because `transparent` and `frame` are decided
  // when a window is CONSTRUCTED: the voice window is born see-through and
  // frameless, and changing shape reshapes it in place rather than handing
  // the call to another window — a call changing shape must never be a call
  // re-joining a room.
  //
  //   panel     the stage, a card the person resizes by its edges
  //   circles   everybody, as a row of face circles over the work
  //   speaker   one circle, whoever is talking
  //   tiny      the same circle at the size of a menu bar icon
  //   walkie    the burst strip, in the bottom-right corner of the screen
  //   faces     the idle team as photo circles, at the call circles' spot
  //   idle      nothing: hidden
  //
  // The three setters are what the see-through shapes need and the stage
  // does not: `setCallWindowInteractive` decides whether the window takes the
  // mouse at all (off except over a circle, so a click on the desktop behind
  // reaches the desktop), `setCallWindowContentSize` keeps the window exactly
  // as big as its circles or its card, and `setCallWindowDragging` has the
  // shell follow the cursor while a circle is held — a drag region would eat
  // the mouse events the renderer needs to know the pointer left. The stage
  // and the strip drag by a real drag region instead, since nothing there is
  // competing for those events.
  setCallWindowSize: (size) => ipcRenderer.invoke("set-call-window-size", size),
  getCallWindowSize: () => ipcRenderer.invoke("get-call-window-size"),
  getVoiceWindowState: () => ipcRenderer.invoke("get-voice-window-state"),
  setCallWindowInteractive: (on) => ipcRenderer.send("set-call-window-interactive", on === true),
  setCallWindowContentSize: (size) => ipcRenderer.send("set-call-window-content-size", size),
  setCallWindowDragging: (on) => ipcRenderer.send("set-call-window-dragging", on === true),
  // The idle faces: the team as circles floating over the work when there is
  // no call — a shape of the voice window, at the call circles' spot. Opening
  // is a standing arrangement that persists across launches; the host reads
  // the flag off its window role and takes the shape itself.
  openFacesWindow: () => ipcRenderer.invoke("open-faces-window"),
  closeFacesWindow: () => ipcRenderer.invoke("close-faces-window"),
  getFacesWindowOpen: () => ipcRenderer.invoke("get-faces-window-open"),
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
  // The ring window: an incoming huddle as a small chromeless corner card
  // (route /call-ring). A ring is the one huddle surface that arrives
  // unannounced, so it cannot live inside an app window — the person it is
  // for is usually looking at something else.
  //
  // `callRingAnswer` hands the room to the CALL window rather than joining
  // here: the media plane is a per-renderer singleton, so answering in this
  // card would put the huddle in a corner with no stage and no controls.
  isCallRingWindow: process.argv.includes("--call-ring-window"),
  openCallRingWindow: () => ipcRenderer.invoke("open-call-ring-window"),
  callRingSize: (size) => ipcRenderer.send("call-ring-size", size),
  callRingHide: () => ipcRenderer.send("call-ring-hide"),
  callRingAnswer: (inviteId, roomKey) => ipcRenderer.send("call-ring-answer", inviteId, roomKey),
});
