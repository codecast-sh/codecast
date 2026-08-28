import { describe, expect, it } from "bun:test";
import {
  AT_MACHINE_MS,
  atTheMachine,
  chooseDoorWindow,
  machineInputAt,
  walkieDoorOpen,
  type DoorWindow,
} from "../calls/walkieDoor";

// THE DOOR, which is also the consent for a microphone.
//
// It used to gate only whether a voice reached this machine. With hot
// auto-listen it gates whether a mic opens untouched, so every clause is worth
// a test of its own — and the two newest clauses replaced the one that used to
// carry the whole weight, `document.visibilityState === "visible"`.

describe("walkie: the door", () => {
  const open = {
    callsOn: true,
    atMachine: true,
    leader: true,
    snoozed: false,
    pref: "team",
    status: "available",
  };

  it("is open by default, because a teammate reaching you is the point", () => {
    expect(walkieDoorOpen(open)).toBe(true);
    // Absent pref means "team": the product's default is the open door.
    expect(walkieDoorOpen({ ...open, pref: undefined })).toBe(true);
  });

  it("is shut by every one of the five ways to shut it", () => {
    expect(walkieDoorOpen({ ...open, callsOn: false })).toBe(false);
    expect(walkieDoorOpen({ ...open, atMachine: false })).toBe(false);
    expect(walkieDoorOpen({ ...open, leader: false })).toBe(false);
    expect(walkieDoorOpen({ ...open, snoozed: true })).toBe(false);
    expect(walkieDoorOpen({ ...open, pref: "off" })).toBe(false);
    expect(walkieDoorOpen({ ...open, status: "busy" })).toBe(false);
  });

  it("stays shut while snoozed even with everything else wide open", () => {
    // Snooze is pressed to stop a voice that is playing at that second, so it
    // has to outrank the pref rather than merely agree with it.
    expect(walkieDoorOpen({ ...open, snoozed: true, pref: "team", status: "available" })).toBe(false);
  });

  it("lets an away teammate through, and stops a busy one", () => {
    // "away" is a fact about the person's day; "busy" is a request. Only one of
    // them is an instruction to this door.
    expect(walkieDoorOpen({ ...open, status: "away" })).toBe(true);
    expect(walkieDoorOpen({ ...open, status: "busy" })).toBe(false);
  });

  it("never opens for a window that is not the one that sounds", () => {
    // The clause that replaced visibility as the thing keeping N windows out of
    // one room. Every other input can be perfect and it still refuses.
    for (const status of ["available", "away"]) {
      for (const pref of ["team", undefined]) {
        expect(walkieDoorOpen({ ...open, leader: false, status, pref })).toBe(false);
      }
    }
  });
});

// AT THE MACHINE, WHICH IS NOT THE SAME AS AT THIS WINDOW.
//
// The gate was `document.visibilityState === "visible"`, so a person working in
// another app heard nothing at all — which is the exact case the walkie exists
// for. The bar is now recent input on the MACHINE, from any window, which is
// true behind another app and false on a machine nobody is sitting at.
describe("walkie: at the machine", () => {
  it("is the last three minutes and not a second more", () => {
    expect(atTheMachine(0)).toBe(true);
    expect(atTheMachine(AT_MACHINE_MS - 1)).toBe(true);
    expect(atTheMachine(AT_MACHINE_MS)).toBe(false);
    expect(atTheMachine(AT_MACHINE_MS + 1)).toBe(false);
    // A machine nobody ever touched since the page loaded.
    expect(atTheMachine(Number.MAX_SAFE_INTEGER)).toBe(false);
  });

  it("decides the whole gate off the idle clock and the leader, and nothing else", () => {
    // The matrix that replaced `document.visibilityState === "visible"`. A
    // window can be buried behind another app for as long as it likes: what
    // decides is when this MACHINE was last touched, and whether this window is
    // the one that speaks for the app.
    const gate = (idleMs: number, leader: boolean) =>
      walkieDoorOpen({
        callsOn: true,
        atMachine: atTheMachine(idleMs),
        leader,
        snoozed: false,
        pref: "team",
        status: "available",
      });
    const second = 1_000;
    expect(gate(0, true)).toBe(true);
    expect(gate(45 * second, true)).toBe(true);
    expect(gate(AT_MACHINE_MS - 1, true)).toBe(true);
    expect(gate(AT_MACHINE_MS, true)).toBe(false);
    expect(gate(10 * 60 * second, true)).toBe(false);
    // And none of it matters in a window that is not the leader.
    for (const idle of [0, 45 * second, AT_MACHINE_MS - 1, AT_MACHINE_MS, 10 * 60 * second]) {
      expect(gate(idle, false)).toBe(false);
    }
  });
});

// THE WINDOWS, and the two questions asked across them.
const NOW = 1_700_000_000_000;
const win = (id: string, over: Partial<DoorWindow> = {}): DoorWindow => ({
  id,
  inputAt: NOW,
  focusedAt: NOW,
  aliveAt: NOW,
  ...over,
});

describe("walkie: the machine's last gesture, across windows", () => {
  it("is the newest one any window saw", () => {
    // A browser tab sees input on its own page and nowhere else. The maximum is
    // what lifts a quiet window to the gesture its sibling saw, which is what
    // makes typing in one window hold the door open in the other.
    const windows = [win("a", { inputAt: NOW - 120_000 }), win("b", { inputAt: NOW - 5_000 })];
    expect(machineInputAt(windows, NOW)).toBe(NOW - 5_000);
  });

  it("ignores a window that stopped saying it exists", () => {
    // A tab that was killed leaves its record behind. Believing its stamp would
    // keep a microphone opening on a machine nobody is at, for as long as the
    // row survived.
    const dead = win("dead", { inputAt: NOW, aliveAt: NOW - 61_000 });
    expect(machineInputAt([dead], NOW)).toBe(0);
    expect(atTheMachine(NOW - machineInputAt([dead], NOW))).toBe(false);
  });

  it("is zero when no window has ever seen a gesture", () => {
    expect(machineInputAt([], NOW)).toBe(0);
    expect(machineInputAt([win("a", { inputAt: 0 })], NOW)).toBe(0);
  });
});

describe("walkie: which window speaks for the app", () => {
  it("is the frontmost one", () => {
    const windows = [win("a", { focusedAt: NOW - 60_000 }), win("b", { focusedAt: NOW })];
    expect(chooseDoorWindow(windows, NOW)).toBe("b");
  });

  it("is the last frontmost one when the app is behind another app", () => {
    // Nothing is focused now, which is the ordinary case for a burst arriving
    // while somebody works elsewhere. The window they used last is the one the
    // strip should appear in.
    const windows = [win("a", { focusedAt: NOW - 600_000 }), win("b", { focusedAt: NOW - 9_000 })];
    expect(chooseDoorWindow(windows, NOW)).toBe("b");
  });

  it("never splits: two windows opened in the same instant still agree", () => {
    // Both windows run this same function over the same records, so a tie that
    // resolved by scan order would elect two leaders — two seats in the room and
    // two voices over each other. The id breaks it the same way in both.
    const windows = [win("b", { focusedAt: NOW }), win("a", { focusedAt: NOW })];
    expect(chooseDoorWindow(windows, NOW)).toBe("a");
    expect(chooseDoorWindow([...windows].reverse(), NOW)).toBe("a");
  });

  it("hands leadership on when the window holding it dies", () => {
    // The failure this staleness rule exists for: the last focused window
    // crashes, its record survives, and nothing anywhere would ever play a
    // burst again.
    const ghost = win("ghost", { focusedAt: NOW, aliveAt: NOW - 61_000 });
    const live = win("live", { focusedAt: NOW - 300_000 });
    expect(chooseDoorWindow([ghost, live], NOW)).toBe("live");
  });

  it("elects nobody when every window is gone", () => {
    expect(chooseDoorWindow([win("a", { aliveAt: NOW - 61_000 })], NOW)).toBe(null);
  });

  it("elects exactly one window out of a crowd", () => {
    // One strip, one sound, stated as a count rather than as a rule.
    const windows = [win("a", { focusedAt: NOW - 3 }), win("b", { focusedAt: NOW - 2 }), win("c", { focusedAt: NOW - 1 })];
    const elected = windows.filter((w) => chooseDoorWindow(windows, NOW) === w.id);
    expect(elected.length).toBe(1);
    expect(elected[0].id).toBe("c");
  });
});
