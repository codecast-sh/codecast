// Which window a notification's click lands in, which window plays the sound,
// and which duplicate reports collapse into one banner. No Electron here —
// main.js feeds it plain window descriptors.
//
// The routing itself is @platform/desktop's now. Its default route table IS
// this one (the package was lifted from this file), so `areas` and
// `entityQueryParams` are left alone; what codecast adds on top is the people
// window, which the package knows nothing about and takes as two hooks.
//
// Window descriptors main.js supplies:
//   { id, isMain, isPeople, isCallPanel, focused, lastFocusedAt, active, open, inCall }
//   active:   the path this window shows now (main: its active tab; detached: its URL)
//   open:     [{ id, path }] every surface the window could switch to (main: its tabs)
//   inCall:   this renderer hosts a connected huddle
//   isPeople: the people window — the floating buddy list. It IS the phone: it
//             carries the roster, the call and walkie pumps and their sounds.
//
// Exports areaOf, classifyRoute, sameEntity, scoreWindow, pickWindow,
// chooseLeader and RecentKeys, unchanged.

const { createNotificationRouter } = require("@platform/desktop").notificationRouter;

module.exports = createNotificationRouter({
  // The people window answers every ring. Keyed on the banner's KIND, not its
  // route, because a call or walkie banner usually carries the DM route it came
  // from — which would otherwise send the click to whichever window shows that
  // conversation, away from the window hosting the audio.
  windowBonus: (win, target) => {
    const kind = (target && target.kind) || null;
    return win.isPeople && (kind === "call" || kind === "walkie") ? 110 : null;
  },

  // While a people window exists it plays the notification sounds, focused or
  // not: it is the phone, it mounts the call and walkie pumps, and its sounds
  // are the ones that must never be missed. With no people window the package's
  // rule stands: the focused window, else the main window, else the window
  // focused most recently.
  //
  // THE CALL PANEL DOES NOT TAKE LEADERSHIP, and that is a decision rather than
  // an omission. The two kinds of sound come apart cleanly:
  //
  //   The call's OWN sounds — someone joining or leaving the room — are not
  //   gated on the leader at all (lib/sounds soundCallJoin/soundCallLeave check
  //   only whether sounds are on). They fire in the renderer holding the room,
  //   which IS the panel. So the panel already sounds its own call, with no rule
  //   needed, and giving it leadership would change nothing about them.
  //
  //   What the leader gates is ANNOUNCEMENTS — a ring, a knock, a walkie burst,
  //   a message. Those are things arriving from outside the call, and the window
  //   that should announce them is the phone: the buddy list if there is one,
  //   else wherever the person is looking. Handing them to the panel would move
  //   the ringer into a window that appears when a call starts and disappears
  //   when it ends — a phone that comes and goes with the conversation.
  //
  // So the panel is an ordinary window here. It is in `appWindows` because
  // `anyInCall` is computed from these descriptors and that is what tells every
  // other window to show "in a huddle in another window", and because a focused
  // panel with no buddy list open should sound what it is looking at — which the
  // existing focused-window rule already gives it.
  preferredLeader: (windows) => windows.find((w) => w.isPeople) || null,
});
