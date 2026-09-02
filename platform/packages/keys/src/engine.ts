// The keyboard engine. One window listener, a binding registry, vim-style
// multi-key sequences with a visible pending buffer, and a context stack so
// each surface (list, thread, compose, palette…) owns its keys without
// stealing anyone else's.
//
// Key spec grammar, space-separated for sequences:
//   "j"            single key
//   "g i"          sequence (g then i, 600ms window)
//   "I"            shift+i (printables fold shift into the char)
//   "#"            shift+3 arrives as "#" from the browser — spec what you mean
//   "cmd+enter"    modifier chords; cmd = meta on mac, ctrl elsewhere
//   "ctrl+d"       explicit ctrl always means ctrl

export type KeyContext =
  | "list"
  | "thread"
  | "compose"
  | "palette"
  | "help"
  | "labelPicker"
  | "categoryPicker"
  | "timePicker"
  | "memories"
  | "settings"
  | "sweep"
  | "search"
  | "welcome";

export type Binding = {
  keys: string;
  /** Contexts this binding is active in; "global" fires in every context. */
  context: KeyContext | KeyContext[] | "global";
  description: string;
  /** Help-overlay group heading. */
  group: string;
  handler: () => void;
  /** Fire even when focus is in an input/textarea (e.g. cmd+enter to send). */
  allowInInput?: boolean;
  /** Omit from help/palette (internal or duplicate aliases). */
  hidden?: boolean;
  when?: () => boolean;
};

const SEQUENCE_WINDOW_MS = 600;

export function isMac(): boolean {
  return typeof navigator !== "undefined" && /Mac|iP(hone|ad|od)/.test(navigator.platform);
}

const MOD_ORDER = ["cmd", "ctrl", "alt", "shift"];

/** Normalize a KeyboardEvent to a token comparable with spec tokens.
 *  Modifiers are PHYSICAL: meta→"cmd", ctrl→"ctrl", alt→"alt". A spec that
 *  wants the platform primary chord uses "mod" (see normalizeSpecToken), which
 *  resolves to "cmd" on mac and "ctrl" elsewhere — so a physical ctrl+d matches
 *  "ctrl+d" on every platform (the old code folded the Windows ctrl into "cmd",
 *  leaving ctrl+d/ctrl+u dead there and colliding with the browser). */
export function eventToken(e: KeyboardEvent): string | null {
  let key = e.key;
  if (key === "Dead" || key === "Unidentified") return null;
  if (["Shift", "Meta", "Control", "Alt"].includes(key)) return null;
  const mods: string[] = [];
  if (e.metaKey) mods.push("cmd");
  if (e.ctrlKey) mods.push("ctrl");
  if (e.altKey) mods.push("alt");
  const printable = key.length === 1;
  if (!printable) {
    key = key.toLowerCase(); // "Enter" → "enter", "Escape" → "escape"
    if (e.shiftKey) mods.push("shift");
  } else if (e.shiftKey && (mods.length > 0) && /[a-z]/i.test(key)) {
    // A chorded shifted letter: normalize case and record shift explicitly so
    // "mod+shift+d" matches regardless of how the layout cased the key.
    key = key.toLowerCase();
    mods.push("shift");
  }
  if (printable && mods.length === 0) return key; // "#", "I" already shift-applied
  mods.sort((a, b) => MOD_ORDER.indexOf(a) - MOD_ORDER.indexOf(b));
  return [...mods, key].join("+");
}

function normalizeSpecToken(token: string): string {
  const parts = token.split("+");
  const key = parts.pop()!;
  // "mod" = platform primary chord: cmd on mac, ctrl elsewhere.
  const primary = isMac() ? "cmd" : "ctrl";
  const mods = parts.map((m) => (m === "mod" ? primary : m));
  // "shift+i" spelled with no other modifier → the browser delivers "I".
  if (mods.length === 1 && mods[0] === "shift" && /^[a-z]$/.test(key)) {
    return key.toUpperCase();
  }
  mods.sort((a, b) => MOD_ORDER.indexOf(a) - MOD_ORDER.indexOf(b));
  return [...mods, key.length === 1 ? key : key.toLowerCase()].join("+");
}

export function parseSpec(spec: string): string[] {
  return spec.trim().split(/\s+/).map(normalizeSpecToken);
}

export type EngineState = {
  pending: string[]; // tokens buffered toward a sequence
};

export class KeyEngine {
  private bindings: Binding[] = [];
  private parsed = new Map<Binding, string[]>();
  private pending: string[] = [];
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private contextFn: () => KeyContext = () => "list";
  private onPendingChange: (pending: string[]) => void = () => {};

  register(bindings: Binding[]): void {
    for (const b of bindings) {
      this.bindings.push(b);
      this.parsed.set(b, parseSpec(b.keys));
    }
  }

  setContextSource(fn: () => KeyContext): void {
    this.contextFn = fn;
  }

  setPendingListener(fn: (pending: string[]) => void): void {
    this.onPendingChange = fn;
  }

  all(): Binding[] {
    return this.bindings;
  }

  activeFor(context: KeyContext): Binding[] {
    return this.bindings.filter((b) => {
      if (b.context === "global") return true;
      const ctxs = Array.isArray(b.context) ? b.context : [b.context];
      return ctxs.includes(context);
    });
  }

  private clearPending(): void {
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pendingTimer = null;
    if (this.pending.length > 0) {
      this.pending = [];
      this.onPendingChange([]);
    }
  }

  /** Returns true when the event was consumed. */
  handle(e: KeyboardEvent): boolean {
    const token = eventToken(e);
    if (!token) return false;

    const target = e.target as HTMLElement | null;
    const inInput =
      !!target &&
      (target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable);

    const context = this.contextFn();
    const candidates = this.activeFor(context).filter(
      (b) => (!inInput || b.allowInInput) && (!b.when || b.when()),
    );

    const attempt = [...this.pending, token];
    let exact: Binding | null = null;
    let prefix = false;
    for (const b of candidates) {
      const seq = this.parsed.get(b)!;
      if (seq.length === attempt.length && seq.every((t, i) => t === attempt[i])) {
        exact = exact ?? b;
      } else if (
        seq.length > attempt.length &&
        attempt.every((t, i) => t === seq[i])
      ) {
        prefix = true;
      }
    }

    // Prefer letting a longer sequence complete only when nothing exact exists;
    // vim behavior: an exact match fires immediately (gg vs g would conflict —
    // avoid such specs).
    if (exact) {
      this.clearPending();
      e.preventDefault();
      e.stopPropagation();
      exact.handler();
      return true;
    }

    if (prefix) {
      this.pending = attempt;
      this.onPendingChange(attempt);
      if (this.pendingTimer) clearTimeout(this.pendingTimer);
      this.pendingTimer = setTimeout(() => this.clearPending(), SEQUENCE_WINDOW_MS);
      e.preventDefault();
      e.stopPropagation();
      return true;
    }

    // A buffered sequence that dead-ends (e.g. "g" then an unmapped key):
    // CANCEL it and swallow the key. Re-firing the key alone was dangerous —
    // "g" then "e" would archive, "g" then Escape would exit the view. Vim
    // cancels a pending operator on an invalid follow key; so do we.
    if (this.pending.length > 0) {
      this.clearPending();
      e.preventDefault();
      e.stopPropagation();
      return true;
    }
    return false;
  }

  attach(win: Window): () => void {
    const listener = (e: KeyboardEvent) => {
      this.handle(e);
    };
    win.addEventListener("keydown", listener);
    return () => win.removeEventListener("keydown", listener);
  }
}

export const keyEngine = new KeyEngine();

/** Render a normalized token as user-facing keycap parts, mac-aware. */
export function tokenParts(token: string): string[] {
  const map: Record<string, string> = {
    cmd: isMac() ? "⌘" : "Ctrl",
    ctrl: isMac() ? "⌃" : "Ctrl",
    alt: isMac() ? "⌥" : "Alt",
    shift: "⇧",
    enter: "↵",
    escape: "esc",
    backspace: "⌫",
    arrowup: "↑",
    arrowdown: "↓",
    arrowleft: "←",
    arrowright: "→",
  };
  return token.split("+").map((p) => map[p] ?? p);
}
