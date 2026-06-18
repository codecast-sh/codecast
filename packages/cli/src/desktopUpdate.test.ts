import { describe, expect, it } from "bun:test";
import { shouldApplyWhileRunning, shouldAttemptDesktopUpdate } from "./desktopUpdate";

// Gate at the very top of checkForDesktopUpdate. The dev-mode skip exists so a
// developer's source checkout (cast/daemon under `bun src/…`) doesn't auto-swap
// the installed app — but an explicit force must still work from a dev env,
// otherwise a dev machine can never update at all (the bug that left the in-app
// banner stuck on "Updating…" forever).
describe("shouldAttemptDesktopUpdate", () => {
  it("only runs on macOS", () => {
    expect(shouldAttemptDesktopUpdate("linux", false, false)).toBe(false);
    expect(shouldAttemptDesktopUpdate("win32", false, true)).toBe(false);
    expect(shouldAttemptDesktopUpdate("darwin", false, false)).toBe(true);
  });

  it("skips automatic checks in dev mode", () => {
    expect(shouldAttemptDesktopUpdate("darwin", true, false)).toBe(false);
  });

  it("an explicit force runs even in dev mode (the unblock)", () => {
    expect(shouldAttemptDesktopUpdate("darwin", true, true)).toBe(true);
  });

  it("runs normally when not in dev mode", () => {
    expect(shouldAttemptDesktopUpdate("darwin", false, true)).toBe(true);
    expect(shouldAttemptDesktopUpdate("darwin", false, false)).toBe(true);
  });
});

// The trigger that makes the rollout reach always-open clients: when the
// installed app is below the server-pinned floor, the daemon applies WHILE the
// app is running instead of deferring forever. The apply mechanism itself
// (quit + swap + relaunch) is the existing `--force` path; this guards only the
// decision.
describe("shouldApplyWhileRunning", () => {
  it("never applies while running without force or a floor", () => {
    expect(shouldApplyWhileRunning("1.1.76", {})).toBe(false);
    expect(shouldApplyWhileRunning("1.1.76", { minVersion: null })).toBe(false);
    expect(shouldApplyWhileRunning("1.1.76", { minVersion: undefined })).toBe(false);
  });

  it("manual --force always applies, regardless of versions", () => {
    expect(shouldApplyWhileRunning("9.9.9", { force: true })).toBe(true);
    expect(shouldApplyWhileRunning("1.1.76", { force: true, minVersion: "1.1.78" })).toBe(true);
  });

  it("applies when the installed app is below the pinned floor", () => {
    expect(shouldApplyWhileRunning("1.1.76", { minVersion: "1.1.78" })).toBe(true);
    expect(shouldApplyWhileRunning("1.0.99", { minVersion: "1.1.0" })).toBe(true);
  });

  it("does NOT apply once at or above the floor (no relaunch loop)", () => {
    expect(shouldApplyWhileRunning("1.1.78", { minVersion: "1.1.78" })).toBe(false);
    expect(shouldApplyWhileRunning("1.2.0", { minVersion: "1.1.78" })).toBe(false);
  });
});
