import { describe, expect, it } from "bun:test";
import { sameBucketExtras, sameInboxView, type InboxViewSnapshot } from "../inboxViewHistory";

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
    expect(sameBucketExtras(undefined, [])).toBe(true);
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
