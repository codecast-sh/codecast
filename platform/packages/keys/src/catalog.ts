// The typed action catalog: flat chord definitions ("ctrl+shift+p", one mac
// variant, an optional context tag) matched directly against KeyboardEvents.
// This is the layer above the chord engine (engine.ts): the engine owns
// vim-style sequences and a context stack; the catalog owns an app's named
// actions, their default bindings, and the guards that decide when a chord may
// fire (focused inputs, open modals). The action id type is the app's — the
// catalog is generic over any string union.

export interface ShortcutDef<A extends string = string> {
  key: string;
  action: A;
  when?: string;
  mac?: string;
  // true = fire even while an input is focused; 'whenEmpty' = fire in a focused
  // input only when it has no content (see inputGuardBypass); absent = never
  // fire while an input is focused.
  skipInputCheck?: boolean | 'whenEmpty';
  // Fire even while a modal dialog is open. Reserved for app-chrome shortcuts
  // that cannot act on the surface behind the modal (zoom, a settings toggle
  // that closes the modal itself). Everything else stands down while a modal
  // is up; see hasOpenModal.
  worksInModal?: boolean;
  description: string;
}

// True while a modal layer is up. Radix Dialog/AlertDialog/Sheet content and
// custom modals render with aria-modal="true"; non-modal popovers and command
// palettes don't. :not([data-state="closed"]) keeps a force-mounted dialog's
// exit animation from counting as open. While a modal is open it owns keyboard
// and focus: the shortcut dispatcher stands down and background focus-stealers
// must not run.
//
// `host`: for a keyboard handler that itself lives INSIDE a modal. A modal
// that contains the host doesn't block it — only a modal stacked elsewhere (a
// confirm dialog, a settings modal) does. Without `host`, any open modal
// counts.
export function hasOpenModal(host?: Element | null): boolean {
  if (typeof document === 'undefined') return false;
  const modals = document.querySelectorAll('[aria-modal="true"]:not([data-state="closed"])');
  if (!host) return modals.length > 0;
  for (const m of modals) if (!m.contains(host)) return true;
  return false;
}

// True when the element holds a text caret (input, textarea, contenteditable).
// Narrower than the dispatcher's in-input guard: no key-owning-region check —
// use it where the question is "would this key edit or move a caret?".
export function isEditableTarget(el: EventTarget | null): boolean {
  const t = el as { tagName?: string; isContentEditable?: boolean } | null;
  if (!t) return false;
  return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable === true;
}

// Resolves a keydown into a spatial ⌥-chord direction (for a surface that
// routes ⌥HJKL / ⌥-arrows between panes), or null when the event must be left
// alone. e.code, not e.key — mac Option+letter composes special characters
// into e.key. Arrow-key horizontals from a text caret return null: ⌥←/⌥→
// inside an input is word jump on macOS and must never be stolen. ⌥H/⌥L still
// cycle from anywhere, and arrows work once focus leaves the input. ⌥↑/⌥↓
// stay intercepted even from the caret — climbing out of the input is their
// whole purpose.
export function altChordDirection(e: {
  altKey: boolean; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean;
  code: string; target: EventTarget | null;
}): 'up' | 'down' | 'left' | 'right' | null {
  if (!e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return null;
  const horizontalArrow = e.code === 'ArrowLeft' || e.code === 'ArrowRight';
  if (horizontalArrow && isEditableTarget(e.target)) return null;
  if (e.code === 'KeyK' || e.code === 'ArrowUp') return 'up';
  if (e.code === 'KeyJ' || e.code === 'ArrowDown') return 'down';
  if (e.code === 'KeyH' || e.code === 'ArrowLeft') return 'left';
  if (e.code === 'KeyL' || e.code === 'ArrowRight') return 'right';
  return null;
}

// Decides whether a binding bypasses the in-input guard for the focused element.
// 'whenEmpty' exists for destructive backspace chords: while the user has text
// in the composer, backspace+modifier is almost certainly delete-word muscle
// memory and must reach the editor; with an empty input delete-word is
// meaningless, so the chord is unambiguous intent. Pseudo-inputs (a region
// marked input-like without a value) have no content notion — keep them
// suppressed.
export function inputGuardBypass(
  def: ShortcutDef<string>,
  el: { tagName?: string; isContentEditable?: boolean; value?: string; textContent?: string | null } | null,
): boolean {
  if (def.skipInputCheck === true) return true;
  if (def.skipInputCheck !== 'whenEmpty' || !el) return false;
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return (el.value ?? '') === '';
  if (el.isContentEditable) return !(el.textContent ?? '').trim();
  return false;
}

// The catalog detects mac from the user agent (the engine's isMac() reads
// navigator.platform; both agree on real browsers, but the catalog keeps the
// detection its donors shipped so bindings resolve identically).
export function detectMac(): boolean {
  return typeof navigator !== 'undefined' && /mac/i.test(navigator.userAgent);
}

const SHIFTED_KEYS = new Set(['?', '+', '!', '@', '#', '$', '%', '^', '&', '*', '(', ')', '_', '{', '}', '|', ':', '"', '<', '>', '~']);

interface ParsedKey {
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
  key: string;
}

function parseKeyCombo(combo: string): ParsedKey {
  const parts = combo.toLowerCase().split('+');
  const result: ParsedKey = { ctrl: false, meta: false, alt: false, shift: false, key: '' };
  for (const part of parts) {
    switch (part) {
      case 'ctrl': result.ctrl = true; break;
      case 'meta': result.meta = true; break;
      case 'alt': result.alt = true; break;
      case 'shift': result.shift = true; break;
      default: result.key = part;
    }
  }
  return result;
}

function normalizeEventKey(e: KeyboardEvent): string {
  if (!e.key) return '';
  const key = e.key.toLowerCase();
  if (key === ' ') return 'space';
  return key;
}

function formatPart(part: string, isMac: boolean): string {
  switch (part.toLowerCase()) {
    case 'ctrl': return isMac ? '⌃' : 'Ctrl';
    case 'meta': return isMac ? '⌘' : 'Ctrl';
    case 'alt': return isMac ? '⌥' : 'Alt';
    case 'shift': return isMac ? '⇧' : 'Shift';
    case 'backspace': return isMac ? '⌫' : 'Bksp';
    case 'escape': return 'Esc';
    case 'enter': return isMac ? '↩' : 'Enter';
    case 'tab': return isMac ? '⇥' : 'Tab';
    case 'arrowup': return '↑';
    case 'arrowdown': return '↓';
    case 'arrowleft': return '←';
    case 'arrowright': return '→';
    case 'space': return '␣';
    case 'delete': return isMac ? '⌦' : 'Del';
    case 'home': return 'Home';
    case 'end': return 'End';
    default: return part.toUpperCase();
  }
}

export interface ShortcutConflict<A extends string> {
  /** The colliding combo as resolved on this platform, modifiers in a fixed
      order. */
  combo: string;
  /** The shared context tag; undefined = the global bindings. */
  when?: string;
  defs: ShortcutDef<A>[];
}

export interface ShortcutCatalog<A extends string> {
  shortcuts: ShortcutDef<A>[];
  isMac: boolean;
  matchShortcut(e: KeyboardEvent, def: ShortcutDef<A>): boolean;
  getShortcutsForAction(action: A): ShortcutDef<A>[];
  getShortcutsByContext(when?: string): ShortcutDef<A>[];
  // Same-chord collisions: defs whose effective combo (after the mac variant
  // resolves) and context tag coincide. A report, never an error — catalog
  // order and handler decline semantics resolve these at dispatch, and some
  // overlaps are deliberate (one chord shared by two surfaces where at most
  // one claims it). For tests and settings UIs.
  conflicts(): ShortcutConflict<A>[];
  formatShortcutParts(def: ShortcutDef<A>): string[];
  formatAcceleratorParts(accelerator: string): string[];
  formatShortcutLabel(action: A): string | null;
}

export function createShortcutCatalog<A extends string>(
  shortcuts: ShortcutDef<A>[],
  opts?: { isMac?: boolean },
): ShortcutCatalog<A> {
  const isMac = opts?.isMac ?? detectMac();

  function matchShortcut(e: KeyboardEvent, def: ShortcutDef<A>): boolean {
    const combo = (isMac && def.mac) ? def.mac : def.key;
    const parsed = parseKeyCombo(combo);
    const eventKey = normalizeEventKey(e);

    // macOS composes Option+<letter> into a special character or dead key (⌥N
    // is the tilde dead key → e.key is "Dead"/"˜", never "n"), so an Alt chord
    // can't be matched on e.key alone. e.code reports the physical key
    // regardless of the composed glyph, so fall back to it for plain
    // alphanumeric Alt chords.
    let keyMatches = parsed.key === eventKey;
    if (!keyMatches && parsed.alt && /^[a-z0-9]$/.test(parsed.key)) {
      keyMatches = e.code === `Key${parsed.key.toUpperCase()}` || e.code === `Digit${parsed.key}`;
    }
    if (!keyMatches) return false;
    if (parsed.ctrl !== e.ctrlKey) return false;
    if (parsed.meta !== e.metaKey) return false;
    if (parsed.alt !== e.altKey) return false;
    if (SHIFTED_KEYS.has(e.key)) return true;
    if (parsed.shift !== e.shiftKey) return false;

    return true;
  }

  function getShortcutsForAction(action: A): ShortcutDef<A>[] {
    return shortcuts.filter(s => s.action === action);
  }

  function getShortcutsByContext(when?: string): ShortcutDef<A>[] {
    if (when === undefined) return shortcuts.filter(s => !s.when);
    return shortcuts.filter(s => s.when === when);
  }

  function conflicts(): ShortcutConflict<A>[] {
    const groups = new Map<string, ShortcutConflict<A>>();
    for (const def of shortcuts) {
      const combo = (isMac && def.mac) ? def.mac : def.key;
      const p = parseKeyCombo(combo);
      const canonical = [
        p.ctrl && 'ctrl', p.meta && 'meta', p.alt && 'alt', p.shift && 'shift', p.key,
      ].filter(Boolean).join('+');
      const key = `${def.when ?? ''} ${canonical}`;
      const group = groups.get(key);
      if (group) group.defs.push(def);
      else groups.set(key, { combo: canonical, when: def.when, defs: [def] });
    }
    return [...groups.values()].filter(g => g.defs.length > 1);
  }

  function formatShortcutParts(def: ShortcutDef<A>): string[] {
    const combo = (isMac && def.mac) ? def.mac : def.key;
    return combo.split('+').map(p => formatPart(p, isMac));
  }

  // Electron accelerator ("CommandOrControl+Shift+N") → the same display parts
  // as formatShortcutParts, so OS-global desktop shortcuts render identically
  // to in-app ones. CommandOrControl resolves per platform, like Electron does.
  function formatAcceleratorParts(accelerator: string): string[] {
    return accelerator.split('+').map(p => {
      const norm = p === 'CommandOrControl' || p === 'CmdOrCtrl' ? (isMac ? 'meta' : 'ctrl')
        : p === 'Command' || p === 'Cmd' || p === 'Super' ? 'meta'
        : p === 'Control' ? 'ctrl'
        : p;
      return formatPart(norm, isMac);
    });
  }

  function formatShortcutLabel(action: A): string | null {
    const defs = getShortcutsForAction(action);
    if (defs.length === 0) return null;
    // Mac glyphs (⌘⇧P) read as one unit; word modifiers need separators
    // (Ctrl+Shift+P).
    return formatShortcutParts(defs[0]).join(isMac ? '' : '+');
  }

  return {
    shortcuts,
    isMac,
    matchShortcut,
    getShortcutsForAction,
    getShortcutsByContext,
    conflicts,
    formatShortcutParts,
    formatAcceleratorParts,
    formatShortcutLabel,
  };
}
