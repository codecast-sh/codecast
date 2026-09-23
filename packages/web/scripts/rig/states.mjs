// Every state of the row as a recipe for the engine fake
// (window.__faceRow.fake, lib/faces/faceRow.ts): the walkie's status, the
// join announcement and a store side overlay (seats, rings, the call plane),
// with no store write and no second person on the line. The same recipes
// serve the headless shots (shots.mjs) and the founder's Chrome
// (`cast browser eval --file` on a file written by statesFile()).
//
// The people are read from the signed in roster: me, the first teammate
// (them) and the next one (a third party in a call elsewhere).

export const STATE_NAMES = [
  "idle",
  "ring-out",
  "ring-in",
  "holding",
  "incoming",
  "two-way",
  "live",
  "muted",
  "speaking",
  "joining",
  "reconnecting",
  "in-call-elsewhere",
];

export const STATES_LIB = String.raw`
(() => {
  const st = window.__inboxStore.getState();
  const me = String(st.currentUser?._id ?? "");
  const others = (st.teamMembers ?? []).filter((m) => String(m._id) !== me);
  const them = others[0];
  const third = others[1] ?? others[0];
  if (!me || !them) throw new Error("no roster to fake against");
  const id = (m) => String(m._id);
  const name = (m) => m?.name ?? m?.email ?? "Teammate";
  const dm = "dm:" + [me, id(them)].sort().join(":");
  const seat = (uid, over = {}) => ({ user_id: uid, ...over });
  const call = (over = {}) => ({ phase: "connected", roomKey: dm, muted: false, micDenied: false, camera: false, speaking: [], ...over });
  const together = { [dm]: [seat(me), seat(id(them))] };
  const walkieRoom = (now, mode, over = {}) => ({ liveRoom: { key: dm, mode, since: now - 3000 }, sending: null, incoming: null, canReply: false, ...over });
  const tx = { roomKey: dm, live: true, heardLive: true };
  const rx = { fromUserId: id(them), roomKey: dm };
  // Built when applied: the join notice and a room's age are clocks.
  const recipes = (now) => ({
    idle: null,
    "ring-out": { input: { call: call(), occupancy: { [dm]: [seat(me)] }, rings: { incoming: [], outgoing: [{ to_user: id(them), room_key: dm, to_name: name(them), status: "ringing" }] } } },
    "ring-in": { input: { rings: { incoming: [{ from_user: id(them), room_key: dm, from_name: name(them) }], outgoing: [] } } },
    holding: { walkie: walkieRoom(now, "burst", { sending: tx }), input: { call: call(), occupancy: together } },
    incoming: { walkie: walkieRoom(now, "listen", { incoming: rx, canReply: true }), input: { call: call(), occupancy: together } },
    "two-way": { walkie: walkieRoom(now, "burst", { sending: tx, incoming: rx, canReply: true }), input: { call: call(), occupancy: together } },
    live: { walkie: walkieRoom(now, "call"), input: { call: call(), occupancy: together } },
    muted: { walkie: walkieRoom(now, "call"), input: { call: call({ muted: true }), occupancy: together } },
    speaking: { walkie: walkieRoom(now, "call"), input: { call: call({ speaking: [id(them)] }), occupancy: together } },
    joining: { walkie: walkieRoom(now, "call"), announcement: { roomKey: dm, text: name(them) + " joined", at: now }, input: { call: call(), occupancy: together } },
    reconnecting: { walkie: walkieRoom(now, "call"), input: { call: call({ phase: "connecting" }), occupancy: together } },
    "in-call-elsewhere": { input: { liveRooms: [{ room_key: "channel:elsewhere", seat: "call", members: [seat(id(third))] }] } },
  });
  const names = Object.keys(recipes(0));
  window.__rigStates = {
    names,
    people: { me, them: id(them), third: id(third) },
    apply(n) {
      const R = recipes(Date.now());
      if (!(n in R)) throw new Error("no state " + n);
      window.__faceRow.fake(R[n]);
      return n;
    },
    clear() { window.__faceRow.fake(null); },
  };
  return names;
})()
`;

/** A file for \`cast browser eval --file\`: install the recipes, apply one state. */
export function statesFile(name) {
  return `${STATES_LIB};\nwindow.__rigStates.apply(${JSON.stringify(name)});`;
}

/**
 * A stand in for the desktop shell, installed before the app boots: it makes
 * /call-panel the voice host with the row popped out, which is the only host
 * of the float density (VoiceHostPanel). Every switch the float throws is a
 * no-op here; the row itself is the same component the desktop draws.
 */
export const FAKE_BRIDGE = String.raw`
window.__CODECAST_ELECTRON__ = {
  isCallPanelWindow: true,
  voiceHostReady() {},
  onWindowRole(cb) {
    window.__rigRole = cb;
    queueMicrotask(() => cb({ leader: true, appFocused: false, anyInCall: false, peopleWindow: false, callPanel: true, voiceWindow: true, facesOverlay: true, peopleWall: false }));
  },
  onCallPanelOpen() {},
  setCallWindowInteractive() {},
  setCallWindowContentSize() {},
  setCallWindowDragging() {},
  setCallWindowSize() { return true; },
};
`;
