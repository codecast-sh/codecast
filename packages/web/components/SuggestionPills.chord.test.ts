import { describe, expect, test } from "bun:test";
import { suggestionChordIndex } from "./SuggestionPills";

// The chord must be Ctrl+Shift+digit exactly. Every lighter modifier set is
// owned upstream of the page: bare Ctrl+digit never reaches the browser on
// macOS (Mission Control's "Switch to Desktop N" — the original binding, dead
// on any machine with Spaces), Alt+digit is workbench switching, Meta+digit
// is the browser's own tab switcher.
const ev = (over: Partial<Parameters<typeof suggestionChordIndex>[0]> = {}) => ({
  ctrlKey: true,
  shiftKey: true,
  metaKey: false,
  altKey: false,
  code: "Digit1",
  ...over,
});

describe("suggestionChordIndex", () => {
  test("ctrl+shift+1/2/3 map to pill 0/1/2", () => {
    expect(suggestionChordIndex(ev())).toBe(0);
    expect(suggestionChordIndex(ev({ code: "Digit2" }))).toBe(1);
    expect(suggestionChordIndex(ev({ code: "Digit3" }))).toBe(2);
  });

  test("only three pills get chords", () => {
    expect(suggestionChordIndex(ev({ code: "Digit4" }))).toBe(-1);
  });

  test("bare ctrl+digit is not the chord (macOS Spaces owns it)", () => {
    expect(suggestionChordIndex(ev({ shiftKey: false }))).toBe(-1);
  });

  test("extra or different modifiers decline", () => {
    expect(suggestionChordIndex(ev({ ctrlKey: false }))).toBe(-1);
    expect(suggestionChordIndex(ev({ metaKey: true }))).toBe(-1);
    expect(suggestionChordIndex(ev({ altKey: true }))).toBe(-1);
  });
});
