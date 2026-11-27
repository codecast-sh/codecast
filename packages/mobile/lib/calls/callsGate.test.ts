import { describe, expect, test } from "bun:test";
import { callsOnForRoom, callsOnInWorkspace, peopleHuddle } from "./callsGate";

const on = { enabled: true, teams: ["t1"] };

describe("callsOnInWorkspace", () => {
  test("a team reads its own opt-in", () => {
    expect(callsOnInWorkspace(on, "t1")).toBe(true);
    expect(callsOnInWorkspace(on, "t2")).toBe(false);
  });
  test("Personal borrows when any team has calls on", () => {
    expect(callsOnInWorkspace(on, null)).toBe(true);
    expect(callsOnInWorkspace({ enabled: true, teams: [] }, null)).toBe(false);
  });
  test("no LiveKit, no calls anywhere", () => {
    expect(callsOnInWorkspace({ enabled: false, teams: ["t1"] }, null)).toBe(false);
    expect(callsOnInWorkspace(null, "t1")).toBe(false);
  });
});

describe("callsOnForRoom", () => {
  test("a team session follows its team", () => {
    expect(callsOnForRoom(on, "t1", ["t1", "t2"])).toBe(true);
    expect(callsOnForRoom(on, "t2", ["t1", "t2"])).toBe(false);
  });
  test("a session with no team borrows", () => {
    expect(callsOnForRoom(on, null, ["t1"])).toBe(true);
    expect(callsOnForRoom({ enabled: true, teams: [] }, null, ["t1"])).toBe(false);
  });
  test("a session routed to a team the viewer left borrows", () => {
    expect(callsOnForRoom(on, "gone", ["t1"])).toBe(true);
  });
  test("disabled deployment", () => {
    expect(callsOnForRoom({ enabled: false, teams: ["t1"] }, null, ["t1"])).toBe(false);
  });
});

describe("peopleHuddle", () => {
  test("yourself alone is your room of one, ringing nobody", () => {
    expect(peopleHuddle("me", ["me"])).toEqual({ roomKey: "dm:me", toUserIds: [] });
  });
  test("a teammate is your shared room, ringing them", () => {
    expect(peopleHuddle("me", ["ann"])).toEqual({ roomKey: "dm:ann:me", toUserIds: ["ann"] });
  });
});
