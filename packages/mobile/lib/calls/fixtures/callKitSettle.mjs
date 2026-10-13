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

// getMyCalls as the server would push it: one watch, results set by the test.
let result;
let onUpdate = null;
let watches = 0;
mock.module("../../convex", () => ({
  convex: {
    mutation: async () => {},
    watchQuery: () => {
      watches++;
      return {
        localQueryResult: () => result,
        onUpdate: (fn) => {
          onUpdate = fn;
          return () => {
            onUpdate = null;
          };
        },
      };
    },
  },
}));
const push = async (inviteIds) => {
  result = { incoming: inviteIds.map((id) => ({ _id: id })), outgoing: [], membership: null };
  onUpdate?.();
  await flush();
};

const { startCallKitBridge, notifyCallKitAuth } = await import("../callKit");
startCallKitBridge();
notifyCallKitAuth(true);

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

// 1. Answered on the desktop two seconds into the ring: the only update that
// says so lands inside the grace window, and the ring still ends when it closes.
await ring("ck1", "inv1");
await push(["inv1"]);
await advance(2_000);
await push([]);
assert.deepEqual(ended, [], "inside the grace window absence proves nothing yet");
await advance(3_000);
assert.deepEqual(ended, [{ id: "ck1", reason: "remoteEnded" }]);
assert.equal(onUpdate, null, "the watch stops with the ring");

// 2. A ring still live past the grace keeps ringing, and ends on the update
// that drops it.
ended.length = 0;
await ring("ck2", "inv2");
await push(["inv2"]);
await advance(6_000);
assert.deepEqual(ended, []);
await push([]);
assert.deepEqual(ended, [{ id: "ck2", reason: "remoteEnded" }]);

// 3. No result yet (the watch has not answered): the grace closing alone
// never ends a ring.
ended.length = 0;
result = undefined;
await ring("ck3", "inv3");
await advance(10_000);
assert.deepEqual(ended, []);
await push(["inv3"]);
assert.deepEqual(ended, []);
assert.equal(watches, 3, "one watch per ring");

process.exitCode = 0;
console.log("callKit settle: ok");
