import { describe, expect, test } from "bun:test";
import { updateNeedsRetry } from "../desktopUpdateState";

describe("updateNeedsRetry", () => {
  const idle = { ready: false, stalled: false, errored: false, updating: false, known: true };

  test("a staged update offers the restart alone, even after the no-progress timer fired", () => {
    expect(updateNeedsRetry({ ...idle, ready: true, stalled: true, updating: true })).toBe(false);
  });

  test("an update with no progress for 90s offers a retry", () => {
    expect(updateNeedsRetry({ ...idle, stalled: true, updating: true })).toBe(true);
  });

  test("a failed update offers a retry when this window asked for it or a version is known", () => {
    expect(updateNeedsRetry({ ...idle, errored: true, updating: true, known: false })).toBe(true);
    expect(updateNeedsRetry({ ...idle, errored: true })).toBe(true);
    expect(updateNeedsRetry({ ...idle, errored: true, known: false })).toBe(false);
  });

  test("a healthy download offers none", () => {
    expect(updateNeedsRetry({ ...idle, updating: true })).toBe(false);
  });
});
