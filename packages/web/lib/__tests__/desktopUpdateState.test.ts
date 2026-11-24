import { describe, expect, test } from "bun:test";
import { updateCardState } from "../desktopUpdateState";

describe("updateCardState", () => {
  const idle = { status: undefined as string | undefined, requested: false, stalled: false, known: true };

  test("a staged update is not in progress, though this window asked for it", () => {
    const s = updateCardState({ ...idle, status: "ready", requested: true });
    expect(s.ready).toBe(true);
    expect(s.updating).toBe(false);
    expect(s.inProgress).toBe(false);
  });

  test("a staged update offers the restart alone, even while the no-progress flag is still set", () => {
    expect(updateCardState({ ...idle, status: "ready", requested: true, stalled: true }).showStalled).toBe(false);
  });

  test("a requested update with no report yet, and a download, are in progress", () => {
    expect(updateCardState({ ...idle, requested: true })).toMatchObject({ updating: true, inProgress: true, showStalled: false });
    expect(updateCardState({ ...idle, status: "downloading" })).toMatchObject({ downloading: true, updating: false, inProgress: true });
  });

  test("an update in progress with no progress for 90s offers a retry", () => {
    expect(updateCardState({ ...idle, requested: true, stalled: true }).showStalled).toBe(true);
    expect(updateCardState({ ...idle, status: "downloading", stalled: true }).showStalled).toBe(true);
  });

  test("a failed update offers a retry when this window asked for it or a version is known", () => {
    expect(updateCardState({ ...idle, status: "error", requested: true, known: false }).showStalled).toBe(true);
    expect(updateCardState({ ...idle, status: "error" }).showStalled).toBe(true);
    expect(updateCardState({ ...idle, status: "error", known: false }).showStalled).toBe(false);
  });

  test("nothing asked for and nothing reported is idle", () => {
    expect(updateCardState(idle)).toMatchObject({ ready: false, inProgress: false, showStalled: false });
  });
});
