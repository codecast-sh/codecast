// Where the cursor has been, across files: back and forward (Ctrl-O / Ctrl-I
// in vim, Ctrl-- and Ctrl-Shift-- on a Mac, Alt-Left and Alt-Right
// elsewhere) walk it the way VS Code does. A move of JUMP_LINES or more, or
// into another file, is a new stop; a smaller move updates the current stop.
// While vim runs, its own jumps decide instead, as Neovim's jumplist does:
// G, gg, /, n, *, %, ' and ` start a stop however near, and 20j or a run of
// J moves the current one however far. An explicit jump (lib/code/jump.ts:
// definition, symbol, breadcrumb, `:line`) starts a stop in either mode.
//
// Plain module state, written from the editor's own events (never a store),
// so recording costs a comparison per cursor move.

export interface NavLocation {
  vaultId: string;
  path: string;
  /** 1-based. */
  line: number;
  col: number;
}

export const JUMP_LINES = 10;
const MAX = 100;

let stack: NavLocation[] = [];
let index = -1;
/** Set while a back/forward step is opening its stop: the stops it passes
 *  through update the target instead of starting new history. */
let walking: { target: NavLocation; until: number } | null = null;

const sameFile = (a: NavLocation, b: NavLocation) => a.vaultId === b.vaultId && a.path === b.path;

/** Set by a jump (vim's jumplist, or an explicit jumpTo) just before the
 *  cursor moves. */
let jumpPending = false;

/** The next move is a jump (vim's jumplist took one). */
export function noteJump(): void {
  jumpPending = true;
}

/** The cursor is here now. `byDistance: false` (vim) makes only a jump or
 *  another file a new stop. */
export function noteLocation(loc: NavLocation, now = Date.now(), opts: { byDistance?: boolean } = {}): void {
  const cur = stack[index];
  const jumped = jumpPending;
  jumpPending = false;
  if (walking) {
    if (now < walking.until && !sameFile(loc, walking.target)) return;
    if (sameFile(loc, walking.target)) {
      stack[index] = loc;
      if (Math.abs(loc.line - walking.target.line) < JUMP_LINES) walking = null;
      return;
    }
    walking = null;
  }
  const near = !jumped && (opts.byDistance === false || Math.abs((cur?.line ?? 0) - loc.line) < JUMP_LINES);
  if (cur && sameFile(cur, loc) && near) {
    stack[index] = loc;
    return;
  }
  stack = stack.slice(0, index + 1);
  stack.push(loc);
  if (stack.length > MAX) stack = stack.slice(stack.length - MAX);
  index = stack.length - 1;
}

/** Step back or forward; the stop to open, or null at the end. */
export function stepHistory(delta: -1 | 1, now = Date.now()): NavLocation | null {
  const next = index + delta;
  if (next < 0 || next >= stack.length) return null;
  index = next;
  walking = { target: stack[index], until: now + 1500 };
  return stack[index];
}

/** The stop a step would open, without taking it. */
export function peekHistory(delta: -1 | 1): NavLocation | null {
  return stack[index + delta] ?? null;
}

/** A file was renamed: its stops follow it. */
export function renameInHistory(vaultId: string, from: string, to: string): void {
  stack = stack.map((l) => (l.vaultId === vaultId && l.path === from ? { ...l, path: to } : l));
  if (walking && walking.target.vaultId === vaultId && walking.target.path === from) walking = { ...walking, target: { ...walking.target, path: to } };
}

/** A file was deleted: its stops go. */
export function forgetPath(vaultId: string, path: string): void {
  const before = stack[index];
  stack = stack.filter((l) => !(l.vaultId === vaultId && l.path === path));
  index = before ? stack.indexOf(before) : -1;
  if (index < 0) index = stack.length - 1;
}

export function _resetNavHistory(): void {
  jumpPending = false;
  stack = [];
  index = -1;
  walking = null;
}

export function _navHistory(): { stack: NavLocation[]; index: number } {
  return { stack, index };
}
