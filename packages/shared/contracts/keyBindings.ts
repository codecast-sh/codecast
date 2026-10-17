// A person's own keyboard bindings, layered over the defaults in
// shortcutCatalog.ts. One home: client_state.ui.key_bindings, a list of
// { action, keys } overrides, stamped last-writer-wins like every per-user
// preference, so a rebinding made in the app, or by an agent through `cast
// shortcuts`, follows the person to every device. An override replaces ALL of an
// action's default chords; `keys: []` is a deliberate "no binding". An action
// with no override keeps its defaults, so a default changed later reaches
// everyone who never touched it.
//
// Chords are lowercase tokens joined by "+", modifiers first in a fixed order:
// ctrl, mod, meta, alt, shift, then the key. `mod` is the platform's command
// key (⌘ on a Mac, Ctrl elsewhere), which is what makes a binding recorded on
// one machine mean the same gesture on the other.

import { SHORTCUTS, type ShortcutAction, type ShortcutDef } from "./shortcutCatalog";

export interface KeyBindingOverride {
  action: string;
  keys: string[];
}

const MODIFIER_ORDER = ["ctrl", "mod", "meta", "alt", "shift"] as const;
type Modifier = (typeof MODIFIER_ORDER)[number];

const MODIFIER_ALIASES: Record<string, Modifier> = {
  ctrl: "ctrl", control: "ctrl", ctl: "ctrl", "⌃": "ctrl", "^": "ctrl",
  mod: "mod", cmd: "mod", command: "mod", cmdorctrl: "mod", commandorcontrol: "mod", "⌘": "mod",
  meta: "meta", super: "meta", win: "meta", windows: "meta",
  alt: "alt", opt: "alt", option: "alt", "⌥": "alt",
  shift: "shift", "⇧": "shift",
};

const KEY_ALIASES: Record<string, string> = {
  esc: "escape", escape: "escape",
  return: "enter", enter: "enter", "↩": "enter", "⏎": "enter",
  backspace: "backspace", bksp: "backspace", "⌫": "backspace",
  delete: "delete", del: "delete", "⌦": "delete",
  tab: "tab", "⇥": "tab",
  space: "space", spacebar: "space", "␣": "space",
  up: "arrowup", arrowup: "arrowup", "↑": "arrowup",
  down: "arrowdown", arrowdown: "arrowdown", "↓": "arrowdown",
  left: "arrowleft", arrowleft: "arrowleft", "←": "arrowleft",
  right: "arrowright", arrowright: "arrowright", "→": "arrowright",
  home: "home", end: "end", pageup: "pageup", pagedown: "pagedown",
  plus: "+", minus: "-", comma: ",", period: ".", slash: "/", backslash: "\\",
  backquote: "`", backtick: "`", semicolon: ";", quote: "'", equal: "=",
  bracketleft: "[", bracketright: "]",
};

// What Shift turns each US-layout key into. The browser reports the shifted
// glyph as the key (Shift+/ arrives as "?"), so a chord names the glyph.
const SHIFTED: Record<string, string> = {
  "1": "!", "2": "@", "3": "#", "4": "$", "5": "%", "6": "^", "7": "&", "8": "*", "9": "(", "0": ")",
  "-": "_", "=": "+", "[": "{", "]": "}", "\\": "|", ";": ":", "'": '"', ",": "<", ".": ">", "/": "?", "`": "~",
};
const SHIFTED_GLYPHS = new Set(Object.values(SHIFTED));
const UNSHIFTED = Object.fromEntries(Object.entries(SHIFTED).map(([k, v]) => [v, k]));

const NAMED_KEYS = new Set([
  "escape", "enter", "backspace", "delete", "tab", "space",
  "arrowup", "arrowdown", "arrowleft", "arrowright", "home", "end", "pageup", "pagedown",
  ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
]);

function isKeyToken(k: string): boolean {
  return NAMED_KEYS.has(k) || [...k].length === 1;
}

export type ChordParse = { ok: true; chord: string } | { ok: false; error: string };

/**
 * Reads a chord the way a person or an agent writes it ("cmd+shift+k",
 * "Ctrl-J", "⌘⇧K", "opt+enter", "?") into the canonical form. A Shift that
 * changes the key is folded into the glyph's spelling: "shift+/" is "?".
 */
export function parseChord(input: string): ChordParse {
  const raw = input.trim();
  if (!raw) return { ok: false, error: "empty chord" };
  // Glyph modifiers run together ("⌘⇧K"); split them off first.
  const spaced = raw.replace(/([⌘⌃⌥⇧])/g, "$1+");
  // "+", "-" and spaces separate tokens, except a trailing "+" or "-" that is
  // the key itself ("ctrl++", "ctrl+-", a bare "-").
  let body = spaced;
  let tailKey: string | null = null;
  if (/[+-]$/.test(body) && (body.length === 1 || /[+\-\s]$/.test(body.slice(0, -1)))) {
    tailKey = body.slice(-1);
    body = body.slice(0, -1);
  }
  const tokens = body.split(/[+\-\s]+/).filter(Boolean);
  if (tailKey) tokens.push(tailKey);
  const mods = new Set<Modifier>();
  let key: string | null = null;
  for (const t of tokens) {
    const low = t.toLowerCase();
    const mod = MODIFIER_ALIASES[low];
    if (mod) { mods.add(mod); continue; }
    if (key !== null) return { ok: false, error: `two keys in one chord: "${key}" and "${t}"` };
    key = KEY_ALIASES[low] ?? low;
  }
  if (key === null) return { ok: false, error: "a chord needs a key, not only modifiers" };
  if (!isKeyToken(key)) return { ok: false, error: `unknown key "${key}"` };
  if (mods.has("shift") && SHIFTED[key]) key = SHIFTED[key];
  if (SHIFTED_GLYPHS.has(key) && !mods.has("ctrl") && !mods.has("mod") && !mods.has("meta") && !mods.has("alt")) mods.delete("shift");
  if (key === "+" && [...mods].length === 0) return { ok: false, error: "use a modifier with +" };
  return { ok: true, chord: [...MODIFIER_ORDER.filter((m) => mods.has(m)), key].join("+") };
}

/** A canonical chord in the catalog's own terms on this platform: `mod`
 *  becomes meta on a Mac and ctrl elsewhere. */
export function resolveChord(chord: string, isMac: boolean): string {
  const parts = chord.split("+");
  const key = parts.pop()!;
  const mods = new Set(parts.map((p) => (p === "mod" ? (isMac ? "meta" : "ctrl") : p)));
  return [...["ctrl", "meta", "alt", "shift"].filter((m) => mods.has(m)), key].join("+");
}

/** The identity two chords share when the same press fires both: modifiers in
 *  order, and Shift dropped when the key is a glyph Shift already made (the
 *  matcher ignores Shift for those). */
export function comboIdentity(combo: string): string {
  const parts = combo.toLowerCase().split("+");
  const key = parts.length > 1 && parts[parts.length - 1] === "" ? "+" : parts.pop()!;
  const mods = new Set(parts.filter(Boolean));
  const glyph = mods.has("shift") && SHIFTED[key] ? SHIFTED[key] : key;
  if (SHIFTED_GLYPHS.has(glyph)) mods.delete("shift");
  return [...["ctrl", "meta", "alt", "shift"].filter((m) => mods.has(m)), glyph].join("+");
}

/** The chord a def answers to on this platform; null = unbound here. */
export function defCombo(def: Pick<ShortcutDef<string>, "key" | "mac">, isMac: boolean): string | null {
  return !isMac || def.mac === undefined ? def.key : def.mac;
}

/** True when the chord has a modifier that cannot type text, so it may fire
 *  from a focused text field without eating a keystroke. */
export function chordIsCommand(chord: string): boolean {
  const parts = chord.split("+");
  const key = parts.pop()!;
  if (parts.some((p) => p === "ctrl" || p === "mod" || p === "meta" || p === "alt")) return true;
  return NAMED_KEYS.has(key) && key !== "space";
}

/** The default chords of an action on this platform, canonical. */
export function defaultChords(action: string, isMac: boolean, defs: ShortcutDef<string>[] = SHORTCUTS): string[] {
  const out: string[] = [];
  for (const d of defs) {
    if (d.action !== action) continue;
    const combo = defCombo(d, isMac);
    if (combo === null) continue;
    const id = comboIdentity(combo);
    if (!out.some((c) => comboIdentity(c) === id)) out.push(combo);
  }
  return out;
}

/**
 * The live defs: the defaults with each override applied. An overridden
 * action's defs move to the front, one per chord, keeping the first default's
 * flags, so where a person's chord meets a default one, theirs wins. A chord
 * that can type text never fires from a text field, whatever the default did.
 */
export function applyKeyBindings<D extends ShortcutDef<string>>(
  defs: D[],
  overrides: KeyBindingOverride[] | undefined,
  isMac: boolean,
): D[] {
  if (!overrides?.length) return defs;
  const byAction = new Map<string, string[]>();
  for (const o of overrides) {
    if (!o || typeof o.action !== "string" || !Array.isArray(o.keys)) continue;
    if (!defs.some((d) => d.action === o.action && !d.fixed)) continue;
    byAction.set(o.action, o.keys.filter((k) => typeof k === "string" && k));
  }
  if (byAction.size === 0) return defs;
  const front: D[] = [];
  for (const [action, keys] of byAction) {
    const template = defs.find((d) => d.action === action)!;
    for (const chord of keys) {
      const key = resolveChord(chord, isMac);
      // A shifted glyph arrives as either spelling depending on the browser
      // and layout (Shift+[ as "{" or "["), so a Shift chord on one gets both,
      // as the defaults register them.
      const parts = key.split("+");
      const glyph = parts[parts.length - 1];
      const spellings = parts.includes("shift") && UNSHIFTED[glyph] ? [key, [...parts.slice(0, -1), UNSHIFTED[glyph]].join("+")] : [key];
      for (const spelling of spellings) {
        const def: D = { ...template, key: spelling, mac: undefined };
        if (def.skipInputCheck && !chordIsCommand(chord)) delete def.skipInputCheck;
        front.push(def);
      }
    }
  }
  return [...front, ...defs.filter((d) => !byAction.has(d.action))];
}

/** Two bindings collide when one press could fire both: the same combo with a
 *  context that can be live at once (the same one, or either is global). */
function contextsOverlap(a?: string, b?: string): boolean {
  return !a || !b || a === b;
}

export interface KeyConflict {
  action: string;
  description: string;
  when?: string;
  chord: string;
}

/** The other actions a chord would collide with for `action`, in live defs. */
export function findConflicts(
  liveDefs: ShortcutDef<string>[],
  action: string,
  chord: string,
  isMac: boolean,
): KeyConflict[] {
  const self = liveDefs.find((d) => d.action === action) ?? SHORTCUTS.find((d) => d.action === action);
  const id = comboIdentity(resolveChord(chord, isMac));
  const out: KeyConflict[] = [];
  for (const d of liveDefs) {
    if (d.action === action || out.some((c) => c.action === d.action)) continue;
    const combo = defCombo(d, isMac);
    if (combo === null || comboIdentity(combo) !== id) continue;
    if (!contextsOverlap(self?.when, d.when)) continue;
    out.push({ action: d.action, description: d.description, when: d.when, chord: combo });
  }
  return out;
}

/** The actions bound to a chord in live defs (any context). */
export function actionsForChord(liveDefs: ShortcutDef<string>[], chord: string, isMac: boolean): ShortcutDef<string>[] {
  const id = comboIdentity(resolveChord(chord, isMac));
  const seen = new Set<string>();
  return liveDefs.filter((d) => {
    const combo = defCombo(d, isMac);
    if (combo === null || comboIdentity(combo) !== id || seen.has(d.action)) return false;
    seen.add(d.action);
    return true;
  });
}

/** An action's chords as they stand: its override, else its defaults. */
export function currentChords(overrides: KeyBindingOverride[] | undefined, action: string, isMac: boolean): string[] {
  const o = overrides?.find((x) => x.action === action);
  return o ? [...o.keys] : defaultChords(action, isMac);
}

/**
 * Sets an action's chords, returning the new override list. Chords equal to
 * the defaults drop the override, so a later default change reaches this
 * person again. `steal` takes the chord away from each colliding action.
 */
export function setActionChords(
  overrides: KeyBindingOverride[] | undefined,
  action: string,
  keys: string[],
  isMac: boolean,
  steal: string[] = [],
): KeyBindingOverride[] {
  let list = (overrides ?? []).filter((o) => o.action !== action);
  const sameAsDefault = (a: string, ks: string[]) => {
    const d = defaultChords(a, isMac).map(comboIdentity).sort();
    const k = ks.map((c) => comboIdentity(resolveChord(c, isMac))).sort();
    return d.length === k.length && d.every((x, i) => x === k[i]);
  };
  const dedup = keys.filter((k, i) => keys.findIndex((x) => comboIdentity(resolveChord(x, isMac)) === comboIdentity(resolveChord(k, isMac))) === i);
  if (!sameAsDefault(action, dedup)) list.push({ action, keys: dedup });
  for (const other of steal) {
    const ids = new Set(dedup.map((k) => comboIdentity(resolveChord(k, isMac))));
    const theirs = currentChords(list, other, isMac).filter((c) => !ids.has(comboIdentity(resolveChord(c, isMac))));
    list = setActionChords(list, other, theirs, isMac);
  }
  return list;
}

/** Drops an action's override, back to its defaults. */
export function resetAction(overrides: KeyBindingOverride[] | undefined, action: string): KeyBindingOverride[] {
  return (overrides ?? []).filter((o) => o.action !== action);
}

/** An action id from what someone typed: the exact id, else a unique match on
 *  the id or the description ("next session"). */
export function resolveAction(query: string, defs: ShortcutDef<string>[] = SHORTCUTS): { ok: true; action: ShortcutAction } | { ok: false; matches: string[] } {
  const q = query.trim().toLowerCase();
  const actions = [...new Set(defs.map((d) => d.action))];
  const exact = actions.find((a) => a.toLowerCase() === q);
  if (exact) return { ok: true, action: exact as ShortcutAction };
  const words = q.split(/\s+/).filter(Boolean);
  const hay = (a: string) => `${a} ${defs.find((d) => d.action === a)!.description}`.toLowerCase();
  const matches = actions.filter((a) => words.every((w) => hay(a).includes(w)));
  const byDesc = matches.filter((a) => defs.find((d) => d.action === a)!.description.toLowerCase() === q);
  if (byDesc.length === 1) return { ok: true, action: byDesc[0] as ShortcutAction };
  if (matches.length === 1) return { ok: true, action: matches[0] as ShortcutAction };
  return { ok: false, matches };
}

const MAC_RESERVED = new Set(["meta+q", "meta+tab", "meta+space", "meta+h", "meta+m", "meta+`"]);
const BROWSER_RESERVED = new Set(["meta+shift+w", "ctrl+shift+w"]);
const BROWSER_TAB_RESERVED = ["t", "n", "w"];

/** Why a chord would never reach the app on this platform (the OS or the
 *  browser keeps it), or null. The desktop app receives the tab chords a
 *  browser tab does not. */
export function reservedReason(chord: string, isMac: boolean, desktop: boolean): string | null {
  const id = comboIdentity(resolveChord(chord, isMac));
  if (isMac && MAC_RESERVED.has(id)) return "macOS keeps this chord";
  if (BROWSER_RESERVED.has(id)) return "the browser keeps this chord";
  const cmd = isMac ? "meta" : "ctrl";
  if (!desktop && BROWSER_TAB_RESERVED.some((k) => id === `${cmd}+${k}`)) return "the browser keeps this chord in a tab";
  return null;
}

const GLYPHS: Record<string, [mac: string, other: string]> = {
  ctrl: ["⌃", "Ctrl"], meta: ["⌘", "Win"], alt: ["⌥", "Alt"], shift: ["⇧", "Shift"],
  backspace: ["⌫", "Backspace"], delete: ["⌦", "Del"], enter: ["↩", "Enter"], tab: ["⇥", "Tab"],
  escape: ["Esc", "Esc"], space: ["Space", "Space"],
  arrowup: ["↑", "↑"], arrowdown: ["↓", "↓"], arrowleft: ["←", "←"], arrowright: ["→", "→"],
};

/** A chord as text for a terminal: "⌘⇧K" on a Mac, "Ctrl+Shift+K" elsewhere. */
export function formatChord(chord: string, isMac: boolean): string {
  const parts = resolveChord(chord, isMac).split("+");
  const key = parts.pop()!;
  const words = [...parts, key].map((p) => GLYPHS[p]?.[isMac ? 0 : 1] ?? (p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1)));
  return words.join(isMac ? "" : "+");
}

// The desktop app's menu bar repeats a few of these chords as native
// accelerators, and on a Mac the menu takes its key before the page. So a
// rebinding has to reach the menu too, or the old chord keeps firing there.
export const DESKTOP_MENU_ACTIONS = ["ui.openSettings", "session.create", "nav.back", "nav.forward", "ui.undo", "ui.redo"] as const;

const ACCELERATOR_KEYS: Record<string, string> = {
  arrowup: "Up", arrowdown: "Down", arrowleft: "Left", arrowright: "Right", enter: "Return",
  escape: "Escape", space: "Space", backspace: "Backspace", delete: "Delete", tab: "Tab",
  home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown",
};

/** A platform combo ("meta+shift+k") as an Electron accelerator
 *  ("Command+Shift+K"); null for a key a menu cannot show. */
export function comboToAccelerator(combo: string, isMac: boolean): string | null {
  const parts = combo.split("+");
  const key = parts.pop()!;
  const name = ACCELERATOR_KEYS[key]
    ?? (/^f([1-9]|1[0-9]|2[0-4])$/.test(key) ? key.toUpperCase() : null)
    ?? (/^[a-z0-9]$/.test(key) ? key.toUpperCase() : null)
    ?? (/^[,./;'[\]\\`=-]$/.test(key) ? key : null);
  if (!name) return null;
  const mods: Record<string, string> = { ctrl: "Control", meta: isMac ? "Command" : "Super", alt: "Alt", shift: "Shift" };
  if (parts.some((p) => !mods[p])) return null;
  return [...parts.map((p) => mods[p]), name].join("+");
}

export interface DesktopMenuKeys {
  /** Live accelerators of each menu action the person rebound. */
  keys: Partial<Record<(typeof DESKTOP_MENU_ACTIONS)[number], string[]>>;
  /** Accelerators the person gave to other actions: a menu item whose
   *  default is one of these gives it up. */
  claimed: string[];
}

/** What the desktop menu must change to follow the person's bindings; null
 *  when they have none, so the menu keeps its own defaults. */
export function desktopMenuKeys(overrides: KeyBindingOverride[] | undefined, liveDefs: ShortcutDef<string>[], isMac: boolean): DesktopMenuKeys | null {
  if (!overrides?.length) return null;
  const accelerators = (action: string) => [...new Set(liveDefs
    .filter((d) => d.action === action)
    .map((d) => defCombo(d, isMac))
    .map((c) => (c === null ? null : comboToAccelerator(c, isMac)))
    .filter((a): a is string => a !== null))];
  const menu = new Set<string>(DESKTOP_MENU_ACTIONS);
  const keys: DesktopMenuKeys["keys"] = {};
  const claimed = new Set<string>();
  for (const o of overrides) {
    if (menu.has(o.action)) keys[o.action as (typeof DESKTOP_MENU_ACTIONS)[number]] = accelerators(o.action);
    else for (const a of accelerators(o.action)) claimed.add(a);
  }
  return { keys, claimed: [...claimed] };
}
