import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

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
  acceptInvite: async (id: string) => void calls.push(`accept ${id}`),
  declineInvite: async (id: string) => void calls.push(`decline ${id}`),
  holdRing: async (id: string) => void calls.push(`hold ${id}`),
  releaseRing: async (inv: { _id: unknown }) => void calls.push(`release ${inv._id}`),
}));
let UI: Record<string, unknown> = {};
const storeHook = Object.assign(() => undefined, { getState: () => ({ callOccupancy: OCCUPANCY, clientState: { ui: UI } }) });
mock.module("../../store/inboxStore", () => ({ ...realStore, useInboxStore: storeHook }));

const gate = await import("./huddleStart");

describe("requestHuddleStart", () => {
  beforeEach(() => {
    calls.length = 0;
    OCCUPANCY = {};
    UI = {};
    gate.closeHuddleStart();
    calls.length = 0;
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

describe("the check can be turned off", () => {
  beforeEach(() => {
    calls.length = 0;
    OCCUPANCY = {};
    UI = { call_device_check: false };
  });

  test("a start goes straight in even with a dialog host", () => {
    const unregister = gate.registerHuddleStartHost();
    try {
      gate.requestHuddleStart({ roomKey: "dm:a:b", toUserIds: ["b"] });
      expect(calls).toEqual(["start dm:a:b b"]);
      expect(gate.pendingHuddleStart()).toBeNull();
    } finally {
      unregister();
    }
  });

  test("an answer picks up at once", () => {
    const unregister = gate.registerHuddleStartHost();
    try {
      gate.requestAnswer({ _id: "in1", room_key: "dm:a:b" });
      expect(calls).toEqual(["accept in1"]);
    } finally {
      unregister();
    }
  });
});

describe("requestAnswer", () => {
  const RING = { _id: "in1", room_key: "dm:a:b", from_name: "Samvit" };
  let unregister: () => void;
  beforeEach(() => {
    calls.length = 0;
    OCCUPANCY = {};
    UI = {};
    unregister = gate.registerHuddleStartHost();
  });
  afterEach(() => unregister());

  const settle = () => new Promise((r) => setTimeout(r, 0));

  test("holds the ring while the check is up, and Join answers it", async () => {
    gate.requestAnswer(RING);
    await settle();
    expect(calls).toEqual(["hold in1"]);
    gate.runHuddleStart(gate.pendingHuddleStart()!);
    await settle();
    expect(calls).toEqual(["hold in1", "accept in1"]);
    expect(gate.pendingHuddleStart()).toBeNull();
  });

  test("closing the check lets the ring back", async () => {
    gate.requestAnswer(RING);
    gate.closeHuddleStart();
    await settle();
    expect(calls).toEqual(["hold in1", "release in1"]);
  });

  test("Decline declines and does not ring again", async () => {
    gate.requestAnswer(RING);
    gate.declineAnswer(gate.pendingHuddleStart()!);
    await settle();
    expect(calls).toEqual(["hold in1", "decline in1"]);
  });
});
