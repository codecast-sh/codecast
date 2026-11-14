// Keeps a lone Esc from reaching the pane glued to the next key.
//
// Keys go out through the relay, which queues them on the pane's row; the far
// loop drains everything queued in one write. Esc and the next key drained
// together read as a Meta chord (Esc then Enter is Alt-Enter), and the relay
// cannot split them for us: web viewers send real Meta chords as Esc-prefixed
// bytes through the same row. So after an Esc, later keys wait until the
// relay has accepted the Esc AND the far loop has been heard from since: every
// push drains the row in its own transaction, and one that the phone sees
// after its own send was accepted committed after it, so it took the Esc.
// MAX_WAIT_MS bounds it for a loop that has gone quiet.

export const ESC = '\x1b';
export const ESC_MAX_WAIT_MS = 4_500;

export class EscGate {
  private queue: string[] = [];
  /** seen: the far loop's newest stamp when the relay accepted the Esc (Infinity until then). */
  private waiting: { seen: number } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly write: (bytes: string, onQueued?: () => void) => void,
    private readonly newestSeen: () => number,
    private readonly timers: { set: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>; clear: (t: ReturnType<typeof setTimeout>) => void } = { set: setTimeout, clear: clearTimeout },
  ) {}

  send(bytes: string): void {
    if (!bytes) return;
    this.queue.push(bytes);
    this.pump();
  }

  /** The far loop pushed (a frame or a heartbeat) stamped `seenAt`. */
  heard(seenAt: number): void {
    if (!this.waiting || seenAt <= this.waiting.seen) return;
    this.release();
  }

  /** The relay refused or failed a send: nothing will drain the Esc, so the keys behind it go now. */
  unblock(): void {
    if (this.waiting) this.release();
  }

  dispose(): void {
    if (this.timer) this.timers.clear(this.timer);
    this.timer = null;
    this.queue = [];
    this.waiting = null;
  }

  private release(): void {
    if (this.timer) this.timers.clear(this.timer);
    this.timer = null;
    this.waiting = null;
    this.pump();
  }

  private pump(): void {
    while (!this.waiting && this.queue.length) {
      const chunk = this.queue.shift()!;
      if (chunk !== ESC) {
        this.write(chunk);
        continue;
      }
      const waiting = { seen: Infinity };
      this.waiting = waiting;
      this.timer = this.timers.set(() => this.release(), ESC_MAX_WAIT_MS);
      this.write(chunk, () => {
        if (this.waiting === waiting) waiting.seen = this.newestSeen();
      });
    }
  }
}
