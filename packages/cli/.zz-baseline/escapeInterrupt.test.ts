import { describe, expect, test } from "bun:test";
import { ESCAPE_PRESS_MAX_AGE_MS, decideEscape, turnLooksActive } from "./escapeInterrupt.js";

const NOW = 1_800_000_000_000;

describe("decideEscape", () => {
  test("interrupts a running turn on a fresh press", () => {
    expect(decideEscape({ pressedAt: NOW - 500, now: NOW, lastInjectedAt: NOW - 10_000, turnActive: true }))
      .toEqual({ action: "interrupt" });
  });

  // The 2026-08-28 race: Escape pressed while a message was still pending, the
  // daemon pasted the message, and the Escape arrived 400ms after the paste.
  test("skips a press that predates the newest injection", () => {
    expect(decideEscape({ pressedAt: NOW - 1_000, now: NOW, lastInjectedAt: NOW - 400, turnActive: true }))
      .toEqual({ action: "skip", reason: "message_injected_after_press" });
  });

  test("a press right after the injection still interrupts the turn it started", () => {
    expect(decideEscape({ pressedAt: NOW - 300, now: NOW, lastInjectedAt: NOW - 400, turnActive: true }))
      .toEqual({ action: "interrupt" });
  });

  test("skips a press older than the freshness budget", () => {
    expect(decideEscape({ pressedAt: NOW - ESCAPE_PRESS_MAX_AGE_MS - 1, now: NOW, lastInjectedAt: null, turnActive: true }))
      .toEqual({ action: "skip", reason: "stale_press" });
  });

  test("skips when nothing is running", () => {
    expect(decideEscape({ pressedAt: NOW, now: NOW, lastInjectedAt: null, turnActive: false }))
      .toEqual({ action: "skip", reason: "no_active_turn" });
  });

  test("an unstamped press (older client, CLI) is judged on the turn alone", () => {
    expect(decideEscape({ pressedAt: undefined, now: NOW, lastInjectedAt: NOW - 100, turnActive: true }))
      .toEqual({ action: "interrupt" });
    expect(decideEscape({ pressedAt: null, now: NOW, lastInjectedAt: NOW - 100, turnActive: false }))
      .toEqual({ action: "skip", reason: "no_active_turn" });
  });
});

describe("turnLooksActive", () => {
  test("a busy pane is a turn whatever the hook says", () => {
    expect(turnLooksActive("idle", "busy")).toBe(true);
    expect(turnLooksActive(undefined, "busy")).toBe(true);
  });

  test("a mid-turn hook is a turn whatever the pane classifier says", () => {
    expect(turnLooksActive("working", "idle")).toBe(true);
    expect(turnLooksActive("permission_blocked", "unknown")).toBe(true);
    expect(turnLooksActive("thinking", "starting")).toBe(true);
    expect(turnLooksActive("working", "interrupted")).toBe(true);
  });

  test("an exited pane has nothing to interrupt", () => {
    expect(turnLooksActive("working", "exited")).toBe(false);
  });

  test("no turn when neither witness names one", () => {
    expect(turnLooksActive("idle", "idle")).toBe(false);
    expect(turnLooksActive("connected", "rewind")).toBe(false);
    expect(turnLooksActive("idle", null)).toBe(false);
    expect(turnLooksActive(undefined, undefined)).toBe(false);
  });

  test("no pane means the hook status is all there is", () => {
    expect(turnLooksActive("thinking", null)).toBe(true);
    expect(turnLooksActive("idle", undefined)).toBe(false);
  });
});
