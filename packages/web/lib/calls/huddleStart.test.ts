import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

// The gate in front of every huddle start: an empty room waits for the
// confirm dialog, a live room is joined at once, and a window with no dialog
// to draw starts at once rather than queueing one nobody can see.

const calls: string[] = [];
let OCCUPANCY: Record<string, unknown[]> = {};

const realActions = { ...(await import("./actions")) };
const realStore = { ...(await import("../../store/inboxStore")) };
afterAll(() => {
  mock.module("./actions", () => realActions);
  mock.module("../../store/inboxStore", () => realStore);
});
mock.module("./actions", () => ({
  ...realActions,
  joinCall: async (roomKey: string) => void calls.push(`join ${roomKey}`),
  startHuddle: async (o: { roomKey: string; toUserIds: string[] }) => void calls.push(`start ${o.roomKey} ${o.toUserIds.join(",")}`),
}));
const storeHook = Object.assign(() => undefined, { getState: () => ({ callOccupancy: OCCUPANCY }) });
mock.module("../../store/inboxStore", () => ({ ...realStore, useInboxStore: storeHook }));

const gate = await import("./huddleStart");

describe("requestHuddleStart", () => {
  beforeEach(() => {
    calls.length = 0;
    OCCUPANCY = {};
    gate.closeHuddleStart();
  });

  test("without a dialog host the start runs at once", () => {
    gate.requestHuddleStart({ roomKey: "dm:a:b", toUserIds: ["b"] });
    expect(calls).toEqual(["start dm:a:b b"]);
  });

  test("a live room is joined without the dialog", () => {
    OCCUPANCY = { "channel:c1": [{ user_id: "x" }] };
    gate.requestHuddleStart({ roomKey: "channel:c1" });
    expect(calls).toEqual(["join channel:c1"]);
  });

  test("with a host the request waits, and confirming starts it", () => {
    const unregister = gate.registerHuddleStartHost();
    try {
      gate.requestHuddleStart({ roomKey: "dm:a:b", toUserIds: ["b"] });
      expect(calls).toEqual([]);
      const req = gate.pendingHuddleStart();
      expect(req?.roomKey).toBe("dm:a:b");
      gate.runHuddleStart(req!);
      expect(calls).toEqual(["start dm:a:b b"]);
      expect(gate.pendingHuddleStart()).toBeNull();
    } finally {
      unregister();
    }
  });

  test("an empty room with nobody to ring confirms, then joins", () => {
    const unregister = gate.registerHuddleStartHost();
    try {
      gate.requestHuddleStart({ roomKey: "session:s1" });
      expect(calls).toEqual([]);
      gate.runHuddleStart(gate.pendingHuddleStart()!);
      expect(calls).toEqual(["join session:s1"]);
    } finally {
      unregister();
    }
  });
});
