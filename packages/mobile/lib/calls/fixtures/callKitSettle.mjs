import assert from "node:assert/strict";
import { mock } from "bun:test";

process.exitCode = 1;
globalThis.__DEV__ = false;

// A hand-driven clock: the ring's settle grace is real time on device.
let now = 1_000_000;
Date.now = () => now;
let timers = [];
globalThis.setTimeout = (fn, ms) => {
  const t = { fn, at: now + (ms ?? 0) };
  timers.push(t);
  return t;
};
globalThis.clearTimeout = (t) => {
  timers = timers.filter((x) => x !== t);
};
async function advance(ms) {
  now += ms;
  const due = timers.filter((t) => t.at <= now);
  timers = timers.filter((t) => t.at > now);
  for (const t of due) t.fn();
  await flush();
}
const flush = () => new Promise((r) => setImmediate(r));

const listeners = {};
const ended = [];
mock.module("react-native", () => ({ AppState: {} }));
mock.module("expo-callkit-telecom", () => {
  const on = (name) => (fn) => {
    listeners[name] = fn;
    return { remove() {} };
  };
  return {
    addCallSessionAddedListener: on("sessionAdded"),
    addCallSessionUpdatedListener: on("sessionUpdated"),
    addCallSessionRemovedListener: on("sessionRemoved"),
    addCallAnsweredListener: on("answered"),
    addCallEndedListener: on("ended"),
    addReportedCallEndedListener: on("reportedEnded"),
    addIncomingCallReportedListener: on("incomingReported"),
    addSetMutedActionListener: on("setMuted"),
    addVoIPPushTokenUpdatedListener: on("voipToken"),
    getActiveCallSession: async () => null,
    getVoIPPushToken: () => null,
    reportCallEnded: async (id, reason) => void ended.push({ id, reason }),
  };
});
mock.module("../../optionalNative", () => ({ nativeModulePresent: () => true }));
mock.module("../../analytics", () => ({ captureError: () => {} }));
mock.module("../callManager", () => ({
  acceptInvite: async () => {},
  declineInvite: async () => {},
  getCallSnapshot: () => ({ phase: "idle", muted: true }),
  joinCall: async () => {},
  leaveCall: async () => {},
  setMuted: async () => {},
  subscribeCall: () => () => {},
}));

// calls.ringLive as the server would push it: one watch per ring, keyed by the
// invite id, with the live value set by the test.
const live = new Map();
const watching = new Map();
let watches = 0;
mock.module("../../convex", () => ({
  convex: {
    mutation: async () => {},
    watchQuery: (_fn, args) => {
      watches++;
      return {
        localQueryResult: () => live.get(args.invite_id),
        onUpdate: (fn) => {
          watching.set(args.invite_id, fn);
          return () => watching.delete(args.invite_id);
        },
      };
    },
  },
}));
const push = async (inviteId, value) => {
  live.set(inviteId, value);
  watching.get(inviteId)?.();
  await flush();
};

// Never signed in: a VoIP push woke the app on a locked phone, where the
// keychain holding the session cannot be read.
const { startCallKitBridge } = await import("../callKit");
startCallKitBridge();

const ring = async (ckId, inviteId) => {
  listeners.sessionAdded({
    session: {
      id: ckId,
      origin: "incoming",
      incomingCallEvent: { serverCallId: inviteId, metadata: { type: "huddle_ring", invite_id: inviteId, room_key: "dm:a:b" } },
    },
  });
  await flush();
};

// 1. Answered on the desktop while the phone is signed out: the ring ends on
// the update that says so, and its watch stops.
await ring("ck1", "inv1");
await push("inv1", true);
assert.deepEqual(ended, []);
await push("inv1", false);
assert.deepEqual(ended, [{ id: "ck1", reason: "remoteEnded" }]);
assert.equal(watching.size, 0, "the watch stops with the ring");

// 2. Already settled by the time the phone looks: ends on the first read.
ended.length = 0;
live.set("inv2", false);
await ring("ck2", "inv2");
assert.deepEqual(ended, [{ id: "ck2", reason: "remoteEnded" }]);

// 3. No answer from the server yet: nothing ends the ring, however long.
ended.length = 0;
await ring("ck3", "inv3");
await advance(60_000);
assert.deepEqual(ended, []);

// 4. Answered on the phone: a later settle (the invite is now "accepted")
// must not end the call the person is on.
listeners.answered({ id: "ck3", requestId: "r3" });
await flush();
await push("inv3", false);
assert.deepEqual(ended, []);

// 5. The same session reported twice (cold start read + listener) watches once.
await ring("ck4", "inv4");
await ring("ck4", "inv4");
assert.equal(watches, 4, "one watch per ring");

process.exitCode = 0;
console.log("callKit settle: ok");
