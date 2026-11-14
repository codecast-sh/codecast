// The phone terminal's keyboard model: a hidden native TextInput owns the
// keyboard, and every edit it reports becomes the bytes a terminal would have
// received. The field holds a sentinel character ahead of the typed text, so a
// backspace on an "empty" field still changes it and still reaches the pane
// as DEL. Edits are sent as a diff against what was already sent, which is
// what keeps iOS autocorrect and predictive text from typing garbage: a
// corrected word goes out as DEL for each dropped character plus the new
// suffix.

/** Zero-width space: invisible in the field, and never typed by a keyboard. */
export const SENTINEL = '\u200b';
export const DEL = '\x7f';
export const ENTER = '\r';

const SENTINEL_RE = /\u200b/g;

// iOS smart punctuation, back to what a terminal means: curly quotes are straight, an em dash is --.
const SMART: Record<string, string> = { '\u201c': '"', '\u201d': '"', '\u2018': "'", '\u2019': "'", '\u2014': '--', '\u2013': '-', '\u2026': '...', '\u00a0': ' ' };
const SMART_RE = /[\u201c\u201d\u2018\u2019\u2014\u2013\u2026\u00a0]/g;

/** The keyboard's text as the pane should receive it. */
export function plainKeyboardText(text: string): string {
  return text.replace(SMART_RE, (c) => SMART[c]);
}

export function bracketedPaste(text: string): string {
  return `\x1b[200~${text}\x1b[201~`;
}

// Ported from agentboard src/client/utils/mobileAutocorrect.ts (MIT).
/** Replace a tracked suffix using terminal DEL, without splitting Unicode code points. */
export function correctionDelta(previous: string, next: string, explicitReplacement = false): string {
  const before = Array.from(previous);
  const after = Array.from(next);
  let common = 0;
  while (common < before.length && common < after.length && before[common] === after[common]) common++;
  const inserted = after.slice(common).join('');
  // A bracketed replacement ends Codex's paste-burst Enter suppression, so an
  // autocorrect pick followed by Return is not read as a typed newline.
  return DEL.repeat(before.length - common) + (explicitReplacement && inserted ? bracketedPaste(inserted) : inserted);
}

export interface InputStep {
  /** Bytes for the pane, possibly empty. */
  bytes: string;
  /** What the field must hold now. */
  field: string;
}

/**
 * Tracks what the keyboard has sent since the last reset. `change` takes the
 * field's new value and returns the bytes to send plus the value to put back.
 */
export class SentinelInput {
  private sent = '';

  reset(): string {
    this.sent = '';
    return SENTINEL;
  }

  change(value: string): InputStep {
    // The sentinel itself was deleted: a backspace with nothing of ours left
    // to erase, which the pane must still receive.
    if (value === '') {
      // Erasing typed text took the sentinel with it (select-all, a word
      // delete): only that text goes. A bare sentinel gone is one backspace.
      const bytes = DEL.repeat(Array.from(this.sent).length || 1);
      this.sent = '';
      return { bytes, field: SENTINEL };
    }
    const text = plainKeyboardText(value.replace(SENTINEL_RE, ''));
    const nl = text.search(/[\r\n]/);
    if (nl >= 0) {
      // A newline inside the field (a paste, a hardware Return) ends the line.
      const bytes = this.delta(text.slice(0, nl)) + ENTER;
      this.sent = '';
      const rest = text.slice(nl + 1).replace(/^\n/, '');
      if (!rest) return { bytes, field: SENTINEL };
      const tail = this.change(SENTINEL + rest);
      return { bytes: bytes + tail.bytes, field: tail.field };
    }
    return { bytes: this.delta(text), field: SENTINEL + text };
  }

  /** Return: whatever is pending, then Enter, and a fresh line. */
  submit(value: string): InputStep {
    const step = this.change(value);
    this.sent = '';
    return { bytes: step.bytes + (step.field === SENTINEL && step.bytes.endsWith(ENTER) ? '' : ENTER), field: SENTINEL };
  }

  private delta(next: string): string {
    // Never bracketed: the pane may be a shell, a login or a password prompt
    // that did not ask for bracketed paste and would print the markers. An
    // explicit Paste (pasteBytes) is the one place that brackets.
    const bytes = correctionDelta(this.sent, next);
    this.sent = next;
    return bytes;
  }
}

/** The byte sequence each quick key sends. */
export const QUICK_KEY_BYTES = {
  enter: ENTER,
  esc: '\x1b',
  tab: '\t',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  ctrlC: '\x03',
  shiftTab: '\x1b[Z',
  pageUp: '\x1b[5~',
  pageDown: '\x1b[6~',
} as const;

/** Ctrl held with a quick key, where a terminal has a sequence for it (Ctrl-arrows move by word). */
export const CTRL_KEY_BYTES: Partial<Record<QuickKey, string>> = {
  up: '\x1b[1;5A',
  down: '\x1b[1;5B',
  right: '\x1b[1;5C',
  left: '\x1b[1;5D',
};

/** Ctrl plus one typed key, as a terminal sends it (Ctrl-D is 0x04), or null for a key Ctrl does not change. */
export function ctrlChord(key: string): string | null {
  if (key.length !== 1) return null;
  const c = key.toUpperCase().charCodeAt(0);
  if (c >= 0x40 && c <= 0x5f) return String.fromCharCode(c & 0x1f);
  if (key === ' ') return '\x00';
  if (key === '?') return DEL;
  return null;
}

export type QuickKey = keyof typeof QUICK_KEY_BYTES;

/**
 * A clipboard paste for the pane, control bytes dropped so it cannot end a
 * bracket early. Bracketed by default, so an agent takes it as one paste;
 * `raw` for a prompt that never asked for bracketed paste (sudo, ssh, a bare
 * read), which would print the markers into the secret.
 */
export function pasteBytes(text: string, raw = false): string {
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
  if (!clean) return '';
  return raw ? clean.replace(/\n/g, '\r') : bracketedPaste(clean);
}
