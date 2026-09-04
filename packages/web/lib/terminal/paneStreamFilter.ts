// Byte filter for pane output on its way into xterm.
//
// The terminal panel shows a tmux pane's RAW output stream (control mode
// forwards the bytes the program wrote), so xterm sees everything the program
// asked its terminal — and xterm, being a real terminal, answers. Two of those
// habits are wrong here and one is worth exploiting:
//
// 1. Capability queries (DA1/DA2, XTVERSION, DSR) are already answered by
//    tmux on the pane's behalf. xterm's reply would then be typed INTO the
//    pane a moment later as a second, unexpected answer — the classic
//    `^[[?1;2c` / `^[[12;1R` garbage on a command line, or stray keys to a
//    TUI. Those queries are removed before xterm can see them. DECRQM stays:
//    xterm's reply is how Claude Code learns that synchronized output works.
//
// 2. Frames are bracketed. Full-screen TUIs (Claude Code, Ink apps, vim) hide
//    the cursor while they paint a frame and show it when done. tmux through
//    3.6 never reports synchronized-output support, so the app never
//    brackets its frames itself, and xterm paints whatever chunk boundary
//    happens to land on an animation frame — half-updated screens read as
//    flicker and torn rows. Wrapping the hide…show span in DEC 2026 makes
//    xterm hold the paint until the frame is complete. xterm releases a
//    bracket on its own after 1s, so a program that hides the cursor for good
//    costs one short stall, never a frozen pane.
//
// Only COMPLETE sequences are ever touched, so a sequence split across two
// chunks is never corrupted: a trailing prefix that could still become one
// of the patterns is held back and prepended to the next chunk.

const ESC = 0x1b;

const enc = (s: string) => new TextEncoder().encode(s);

const SYNC_START = enc("\x1b[?2026h");
const SYNC_END = enc("\x1b[?2026l");
const CURSOR_HIDE = enc("\x1b[?25l");
const CURSOR_SHOW = enc("\x1b[?25h");

/** Queries tmux answers itself; xterm must not answer them a second time. */
const DROP: Uint8Array[] = [
  "\x1b[c", "\x1b[0c", "\x1b[>c", "\x1b[>0c", "\x1b[>q", "\x1b[>0q", "\x1b[5n", "\x1b[6n",
  ...[10, 11].flatMap((code) => ["\x07", "\x1b\\"].map((end) => `\x1b]${code};?${end}`)),
].map(enc);

const PATTERNS = [...DROP, CURSOR_HIDE, CURSOR_SHOW];
const MAX_PATTERN = Math.max(...PATTERNS.map((p) => p.length));

function startsWithAt(buf: Uint8Array, at: number, pat: Uint8Array): boolean {
  if (at + pat.length > buf.length) return false;
  for (let i = 0; i < pat.length; i++) if (buf[at + i] !== pat[i]) return false;
  return true;
}

/** Could bytes [at, end) still grow into one of the patterns? */
function isPatternPrefix(buf: Uint8Array, at: number): boolean {
  const len = buf.length - at;
  outer: for (const pat of PATTERNS) {
    if (len >= pat.length) continue;
    for (let i = 0; i < len; i++) if (buf[at + i] !== pat[i]) continue outer;
    return true;
  }
  return false;
}

export class PaneStreamFilter {
  private carry: Uint8Array | null = null;

  constructor(private readonly opts: { syncFrames: boolean }) {}

  process(chunk: Uint8Array): Uint8Array {
    let buf = chunk;
    if (this.carry) {
      const joined = new Uint8Array(this.carry.length + chunk.length);
      joined.set(this.carry, 0);
      joined.set(chunk, this.carry.length);
      buf = joined;
      this.carry = null;
    }

    // Hold back a trailing partial match; it completes with the next chunk.
    let end = buf.length;
    for (let i = Math.max(0, buf.length - MAX_PATTERN + 1); i < buf.length; i++) {
      if (buf[i] === ESC && isPatternPrefix(buf, i)) {
        this.carry = buf.slice(i);
        end = i;
        break;
      }
    }

    // Fast path: nothing to rewrite.
    let firstEsc = -1;
    for (let i = 0; i < end; i++) {
      if (buf[i] === ESC) { firstEsc = i; break; }
    }
    if (firstEsc < 0) return end === buf.length ? buf : buf.subarray(0, end);

    const parts: Uint8Array[] = [];
    let total = 0;
    const push = (p: Uint8Array) => { parts.push(p); total += p.length; };
    let from = 0;
    let i = firstEsc;
    while (i < end) {
      if (buf[i] !== ESC) { i++; continue; }
      let matched = 0;
      for (const pat of DROP) {
        if (startsWithAt(buf, i, pat)) {
          push(buf.subarray(from, i));
          matched = pat.length;
          break;
        }
      }
      if (!matched && this.opts.syncFrames) {
        if (startsWithAt(buf, i, CURSOR_HIDE)) {
          push(buf.subarray(from, i));
          push(SYNC_START);
          push(CURSOR_HIDE);
          matched = CURSOR_HIDE.length;
        } else if (startsWithAt(buf, i, CURSOR_SHOW)) {
          push(buf.subarray(from, i));
          push(CURSOR_SHOW);
          push(SYNC_END);
          matched = CURSOR_SHOW.length;
        }
      }
      if (matched) {
        i += matched;
        from = i;
      } else {
        i++;
      }
    }
    if (parts.length === 0) return end === buf.length ? buf : buf.subarray(0, end);
    push(buf.subarray(from, end));
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.length; }
    return out;
  }
}
