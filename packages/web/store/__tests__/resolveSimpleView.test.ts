import { describe, expect, it } from "bun:test";
import { resolveInboxCompact, resolveSimpleView } from "../inboxStore";

// Minimal has no dense variant, so it never reads the simple view toggle. The
// stored toggle is left alone, so Classic gets the person's own choice back.
describe("resolveSimpleView", () => {
  it("defaults on, and honors the toggle in Classic", () => {
    expect(resolveSimpleView(undefined)).toBe(true);
    expect(resolveSimpleView({})).toBe(true);
    expect(resolveSimpleView({ visual_style: "classic", simple_view: false })).toBe(false);
    expect(resolveSimpleView({ simple_view: false })).toBe(false);
  });

  it("is always on in Minimal, whatever the toggle says", () => {
    expect(resolveSimpleView({ visual_style: "minimal", simple_view: false })).toBe(true);
    expect(resolveSimpleView({ visual_style: "minimal" })).toBe(true);
  });
});

describe("resolveInboxCompact", () => {
  it("lets the style decide until the person chooses", () => {
    expect(resolveInboxCompact(undefined)).toBe(false);
    expect(resolveInboxCompact({ visual_style: "classic" })).toBe(false);
    expect(resolveInboxCompact({ visual_style: "minimal" })).toBe(true);
  });

  it("keeps the person's choice in either style", () => {
    expect(resolveInboxCompact({ visual_style: "minimal", inbox_compact: false })).toBe(false);
    expect(resolveInboxCompact({ visual_style: "classic", inbox_compact: true })).toBe(true);
  });
});
