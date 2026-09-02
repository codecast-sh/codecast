import { describe, expect, it } from "bun:test";
import { sameFilterExtras, sameInboxView, withInboxView, type InboxViewSnapshot } from "../inboxViewHistory";

const snap = (extra: Partial<InboxViewSnapshot> = {}): InboxViewSnapshot => ({
  bucket: "b1",
  project: null,
  projectPath: null,
  exclude: false,
  mode: "grouped",
  ...extra,
});

describe("sameInboxView with shift-added label terms", () => {
  it("treats a missing extras list (pre-feature entry) as empty", () => {
    expect(sameInboxView(snap(), snap({ extras: [] }))).toBe(true);
    expect(sameFilterExtras(undefined, [])).toBe(true);
  });

  it("a term added, removed, flipped, or reordered is a new view", () => {
    const base = snap({ extras: [{ id: "b2", exclude: false }] });
    expect(sameInboxView(base, snap({ extras: [{ id: "b2", exclude: false }] }))).toBe(true);
    expect(sameInboxView(base, snap())).toBe(false);
    expect(sameInboxView(base, snap({ extras: [{ id: "b2", exclude: true }] }))).toBe(false);
    expect(sameInboxView(base, snap({ extras: [{ id: "b2", exclude: false }, { id: "b3", exclude: true }] }))).toBe(false);
    const two = snap({ extras: [{ id: "b2", exclude: false }, { id: "b3", exclude: true }] });
    expect(sameInboxView(two, snap({ extras: [{ id: "b3", exclude: true }, { id: "b2", exclude: false }] }))).toBe(false);
  });
});

describe("withInboxView", () => {
  it("carries the current entry's view tag onto a session navigation state", () => {
    const g = globalThis as any;
    const saved = g.window;
    g.window = { history: { state: { inboxView: snap({ extras: [{ id: "b2", exclude: true }] }) } } };
    try {
      expect(withInboxView({ inboxId: "c1" })).toEqual({ inboxId: "c1", inboxView: snap({ extras: [{ id: "b2", exclude: true }] }) });
      g.window.history.state = { inboxId: "c0" };
      expect(withInboxView({ inboxId: "c1" })).toEqual({ inboxId: "c1" });
    } finally {
      if (saved === undefined) delete g.window; else g.window = saved;
    }
  });
});
