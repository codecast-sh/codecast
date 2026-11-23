import { describe, expect, test } from "bun:test";
import { statusFlipEndsTurn } from "./daemon.js";

// The settle a slash command held for the turn's end waits on (injectViaTmuxInner).
describe("statusFlipEndsTurn", () => {
  test("a turn settling ends it, whatever it settles as", () => {
    expect(statusFlipEndsTurn("thinking", "idle")).toBe(true);
    expect(statusFlipEndsTurn("working", "waiting")).toBe(true);
    expect(statusFlipEndsTurn("working", "done")).toBe(true);
    expect(statusFlipEndsTurn("compacting", "stopped")).toBe(true);
    expect(statusFlipEndsTurn("permission_blocked", "idle")).toBe(true);
  });
  test("moving within a turn, or between settles, ends nothing", () => {
    expect(statusFlipEndsTurn("thinking", "working")).toBe(false);
    expect(statusFlipEndsTurn("working", "permission_blocked")).toBe(false);
    expect(statusFlipEndsTurn("idle", "idle")).toBe(false);
    expect(statusFlipEndsTurn("waiting", "idle")).toBe(false);
    expect(statusFlipEndsTurn(undefined, "idle")).toBe(false);
  });
});
