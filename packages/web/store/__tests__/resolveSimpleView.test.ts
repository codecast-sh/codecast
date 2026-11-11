import { describe, expect, it } from "bun:test";
import { resolveInboxCompact, resolveSimpleView, resolveVisualStyle } from "../inboxStore";

// Codecast has one style, Minimal, whatever an old Classic preference says.
describe("resolveVisualStyle", () => {
  it("is always Minimal, ignoring a stored Classic choice", () => {
    expect(resolveVisualStyle()).toBe("minimal");
    expect(resolveVisualStyle(undefined)).toBe("minimal");
    expect(resolveVisualStyle({ visual_style: "classic" })).toBe("minimal");
  });
});

// Minimal has no dense variant, so it never reads the simple view toggle.
describe("resolveSimpleView", () => {
  it("is always on, whatever the toggle or an old style choice says", () => {
    expect(resolveSimpleView(undefined)).toBe(true);
    expect(resolveSimpleView({})).toBe(true);
    expect(resolveSimpleView({ simple_view: false })).toBe(true);
    expect(resolveSimpleView({ visual_style: "classic", simple_view: false })).toBe(true);
    expect(resolveSimpleView({ visual_style: "minimal", simple_view: false })).toBe(true);
  });
});

describe("resolveInboxCompact", () => {
  it("lists compactly until the person chooses", () => {
    expect(resolveInboxCompact(undefined)).toBe(true);
    expect(resolveInboxCompact({})).toBe(true);
    expect(resolveInboxCompact({ visual_style: "classic" })).toBe(true);
  });

  it("keeps the person's choice", () => {
    expect(resolveInboxCompact({ inbox_compact: false })).toBe(false);
    expect(resolveInboxCompact({ visual_style: "classic", inbox_compact: true })).toBe(true);
  });
});
