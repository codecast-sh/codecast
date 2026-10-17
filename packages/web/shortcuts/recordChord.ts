// A pressed key as a chord the person can bind (shared/contracts/keyBindings
// canonical form). The physical key names the chord, so ⌥J on a Mac records as
// alt+j rather than the "∆" it types; the result is then proven against the
// very event with the catalog's own matcher, and refused when a chord made from
// it would not fire on this keyboard.
import { createShortcutCatalog } from "@platform/keys";
import { parseChord, resolveChord } from "@codecast/shared/contracts/keyBindings";

const CODE_KEYS: Record<string, string> = {
  BracketLeft: "[", BracketRight: "]", Backslash: "\\", Semicolon: ";", Quote: "'",
  Comma: ",", Period: ".", Slash: "/", Backquote: "`", Minus: "-", Equal: "=",
  Space: "space", Enter: "enter", NumpadEnter: "enter", Escape: "escape", Backspace: "backspace",
  Delete: "delete", Tab: "tab", ArrowUp: "arrowup", ArrowDown: "arrowdown",
  ArrowLeft: "arrowleft", ArrowRight: "arrowright", Home: "home", End: "end",
  PageUp: "pageup", PageDown: "pagedown",
};

const MODIFIER_KEYS = new Set(["Meta", "Control", "Alt", "Shift", "CapsLock", "Fn", "AltGraph", "OS"]);

export type RecordedChord = { chord: string } | { error: string } | null;

function keyFromCode(code: string): string | null {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1].toLowerCase();
  const digit = /^(?:Digit|Numpad)([0-9])$/.exec(code);
  if (digit) return digit[1];
  const fn = /^F([0-9]{1,2})$/.exec(code);
  if (fn) return `f${fn[1]}`;
  return CODE_KEYS[code] ?? null;
}

function chordFrom(e: KeyboardEvent, key: string, isMac: boolean): string | null {
  const mods = [
    e.ctrlKey && "ctrl",
    e.metaKey && (isMac ? "mod" : "meta"),
    e.altKey && "alt",
    e.shiftKey && "shift",
  ].filter(Boolean);
  const parsed = parseChord([...mods, key].join("+"));
  return parsed.ok ? parsed.chord : null;
}

function firesOn(e: KeyboardEvent, chord: string, isMac: boolean): boolean {
  const catalog = createShortcutCatalog([{ key: resolveChord(chord, isMac), action: "x", description: "" }], { isMac });
  return catalog.matchShortcut(e, catalog.shortcuts[0]);
}

/** null while only modifiers are down. */
export function chordFromEvent(e: KeyboardEvent, isMac: boolean): RecordedChord {
  if (MODIFIER_KEYS.has(e.key)) return null;
  const candidates = [keyFromCode(e.code), e.key && [...e.key].length === 1 ? e.key.toLowerCase() : null];
  for (const key of candidates) {
    if (!key) continue;
    const chord = chordFrom(e, key, isMac);
    if (chord && firesOn(e, chord, isMac)) return { chord };
  }
  return { error: "This key can't be bound on this keyboard" };
}
