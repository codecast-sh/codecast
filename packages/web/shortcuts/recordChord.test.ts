import { expect, test } from "bun:test";
import { chordFromEvent } from "./recordChord";

const ev = (init: Partial<KeyboardEvent>) => ({ ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, ...init }) as KeyboardEvent;

test("records chords by physical key", () => {
  expect(chordFromEvent(ev({ key: "j", code: "KeyJ", ctrlKey: true }), true)).toEqual({ chord: "ctrl+j" });
  expect(chordFromEvent(ev({ key: "K", code: "KeyK", metaKey: true, shiftKey: true }), true)).toEqual({ chord: "mod+shift+k" });
  expect(chordFromEvent(ev({ key: "∆", code: "KeyJ", altKey: true }), true)).toEqual({ chord: "alt+j" });
  expect(chordFromEvent(ev({ key: "{", code: "BracketLeft", ctrlKey: true, shiftKey: true }), true)).toEqual({ chord: "ctrl+shift+{" });
  expect(chordFromEvent(ev({ key: "?", code: "Slash", shiftKey: true }), true)).toEqual({ chord: "?" });
  expect(chordFromEvent(ev({ key: "Backspace", code: "Backspace", ctrlKey: true }), false)).toEqual({ chord: "ctrl+backspace" });
  expect(chordFromEvent(ev({ key: "k", code: "KeyK", metaKey: true }), false)).toEqual({ chord: "meta+k" });
});

test("waits while only modifiers are down", () => {
  expect(chordFromEvent(ev({ key: "Shift", code: "ShiftLeft", shiftKey: true }), true)).toBeNull();
});
