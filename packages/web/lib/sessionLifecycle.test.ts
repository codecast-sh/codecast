import { test, expect, describe } from "bun:test";
import {
  sessionStartupState,
  SESSION_STARTING_GRACE_MS,
  SESSION_STALL_THRESHOLD_MS,
} from "./sessionLifecycle";

describe("sessionStartupState", () => {
  test("a live daemon is Ready at any age", () => {
    expect(sessionStartupState({ isConnected: true, ageMs: 0 })).toBe("ready");
    expect(sessionStartupState({ isConnected: true, ageMs: 10 * 60_000 })).toBe("ready");
  });

  test("a brand-new session with no heartbeat shows the boot spinner", () => {
    expect(sessionStartupState({ isConnected: false, ageMs: 0 })).toBe("starting");
    expect(sessionStartupState({ isConnected: false, ageMs: SESSION_STARTING_GRACE_MS - 1 })).toBe("starting");
  });

  test("past the boot grace, trust elapsed time and call it Ready — no infinite spinner", () => {
    expect(sessionStartupState({ isConnected: false, ageMs: SESSION_STARTING_GRACE_MS })).toBe("ready");
    expect(sessionStartupState({ isConnected: false, ageMs: SESSION_STALL_THRESHOLD_MS - 1 })).toBe("ready");
  });

  test("only after a long window with still no connection is it genuinely stalled", () => {
    expect(sessionStartupState({ isConnected: false, ageMs: SESSION_STALL_THRESHOLD_MS })).toBe("stalled");
    expect(sessionStartupState({ isConnected: false, ageMs: 10 * 60_000 })).toBe("stalled");
  });

  // The composer (ConversationView) derives isSessionStarting / isSessionReady from
  // this same function. These cases pin the exact behavior it relies on so the inbox
  // row and the composer can never drift apart again.
  test("matches the composer's Starting/Ready boundaries", () => {
    // isSessionStarting === (state === "starting")
    expect(sessionStartupState({ isConnected: false, ageMs: 29_999 })).toBe("starting");
    // isSessionReady === (state === "ready" && age < 120s)
    expect(sessionStartupState({ isConnected: false, ageMs: 30_000 })).toBe("ready");
    expect(sessionStartupState({ isConnected: false, ageMs: 119_999 })).toBe("ready");
    expect(sessionStartupState({ isConnected: false, ageMs: 120_000 })).toBe("stalled");
  });
});
