import { expect, test } from "bun:test";
import { SOURCE_LOADED_MAX_DEFER_MS, SOURCE_RESTART_SPACING_MS, SOURCE_SETTLE_MS, decideSourceRestart } from "./sourceRestart.js";

test("a changed source restarts only once it has held still, and never twice inside the spacing", () => {
  let s = { bootId: "a" };
  let r = decideSourceRestart(s, "a", 0);
  expect(r.restart).toBe(false);
  r = decideSourceRestart(r.state, "b", 1000);
  expect(r.restart).toBe(false);
  r = decideSourceRestart(r.state, "c", 2000);
  expect([r.restart, r.state.pendingId]).toEqual([false, "c"]);
  r = decideSourceRestart(r.state, "c", 2000 + SOURCE_SETTLE_MS - 1);
  expect(r.restart).toBe(false);
  r = decideSourceRestart(r.state, "c", 2000 + SOURCE_SETTLE_MS);
  expect(r.restart).toBe(true);

  const recent = { bootId: "a", pendingId: "b", pendingSince: 0, lastRestartAt: SOURCE_SETTLE_MS };
  expect(decideSourceRestart(recent, "b", SOURCE_SETTLE_MS * 2).restart).toBe(false);
  expect(decideSourceRestart(recent, "b", SOURCE_SETTLE_MS + SOURCE_RESTART_SPACING_MS).restart).toBe(true);
});

test("a source edited back to what is running cancels the pending restart", () => {
  const r = decideSourceRestart({ bootId: "a", pendingId: "b", pendingSince: 0, lastRestartAt: 5 }, "a", SOURCE_SETTLE_MS * 10);
  expect(r).toEqual({ state: { bootId: "a", lastRestartAt: 5 }, restart: false });
});

test("an overloaded machine holds a due restart, but not past the deferral cap", () => {
  const due = { bootId: "a", pendingId: "b", pendingSince: 0 };
  expect(decideSourceRestart(due, "b", SOURCE_SETTLE_MS, true).restart).toBe(false);
  expect(decideSourceRestart(due, "b", SOURCE_SETTLE_MS, false).restart).toBe(true);
  expect(decideSourceRestart(due, "b", SOURCE_LOADED_MAX_DEFER_MS, true).restart).toBe(true);
});
