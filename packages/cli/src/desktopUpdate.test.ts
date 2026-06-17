import { describe, expect, it } from "bun:test";
import { shouldApplyWhileRunning } from "./desktopUpdate";

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
