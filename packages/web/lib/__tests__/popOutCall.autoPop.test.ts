import { afterEach, describe, expect, it } from "bun:test";
import {
  clearAutoPopSuppress,
  isAutoPopSuppressed,
  shouldAutoPopCall,
  suppressAutoPopOut,
} from "../calls/popOutCall";

// Closing the call panel hands the huddle back. Auto-popping that same room
// would reopen the panel forever — the call would never be allowed to sit in
// the window the person just closed it onto.

afterEach(() => clearAutoPopSuppress());

describe("auto-pop suppress", () => {
  it("blocks the room the panel just closed onto", () => {
    suppressAutoPopOut("team/cam");
    expect(isAutoPopSuppressed("team/cam")).toBe(true);
    expect(isAutoPopSuppressed("team/other")).toBe(false);
  });

  it("clears for a room, or for all rooms when the call ends", () => {
    suppressAutoPopOut("a");
    suppressAutoPopOut("b");
    clearAutoPopSuppress("a");
    expect(isAutoPopSuppressed("a")).toBe(false);
    expect(isAutoPopSuppressed("b")).toBe(true);
    clearAutoPopSuppress();
    expect(isAutoPopSuppressed("b")).toBe(false);
  });

  it("treats an empty room as nothing to suppress", () => {
    suppressAutoPopOut("");
    expect(isAutoPopSuppressed("")).toBe(false);
    expect(isAutoPopSuppressed(null)).toBe(false);
  });
});

describe("shouldAutoPopCall", () => {
  const live = {
    canPopOut: true,
    phase: "connected",
    roomKey: "team/cam",
    walkieHolds: false,
    suppressed: false,
  };

  it("sends a desktop huddle to its own window", () => {
    expect(shouldAutoPopCall(live)).toBe(true);
    expect(shouldAutoPopCall({ ...live, phase: "connecting" })).toBe(true);
  });

  it("never pops a browser — there is no real window to go to", () => {
    expect(shouldAutoPopCall({ ...live, canPopOut: false })).toBe(false);
  });

  it("leaves a walkie burst on the strip", () => {
    expect(shouldAutoPopCall({ ...live, walkieHolds: true })).toBe(false);
  });

  it("does not reopen a panel the person just closed", () => {
    expect(shouldAutoPopCall({ ...live, suppressed: true })).toBe(false);
  });

  it("does nothing when there is no call", () => {
    expect(shouldAutoPopCall({ ...live, phase: "idle", roomKey: null })).toBe(false);
    expect(shouldAutoPopCall({ ...live, roomKey: null })).toBe(false);
  });
});
