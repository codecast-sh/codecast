// tmux control-mode (`tmux -C`) protocol primitives, kept pure for testability.
//
// Control mode is a line-based text protocol over the client's stdio: command
// replies arrive framed by `%begin`/`%end` (or `%error`) lines, and
// notifications (`%output`, `%exit`, `%pause`, ...) arrive between blocks.
// Pane output mixes raw UTF-8 with octal-escaped bytes (`\015`, `\033`), so
// unescaping must produce a Buffer — decoding to a string first would mangle
// characters split between output messages.

/** Unescape tmux control-mode `%output` data (`\ooo` octal escapes) into raw bytes. */
export function unescapeControlData(data: string | Buffer): Buffer {
  const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  const out = Buffer.alloc(bytes.length);
  let w = 0;
  for (let i = 0; i < bytes.length; i++) {
    const ch = bytes[i]!;
    if (ch === 0x5c /* \ */ && i + 3 < bytes.length) {
      const o1 = bytes[i + 1]! - 0x30;
      const o2 = bytes[i + 2]! - 0x30;
      const o3 = bytes[i + 3]! - 0x30;
      if (o1 >= 0 && o1 <= 7 && o2 >= 0 && o2 <= 7 && o3 >= 0 && o3 <= 7) {
        out[w++] = (o1 << 6) | (o2 << 3) | o3;
        i += 3;
        continue;
      }
    }
    out[w++] = ch;
  }
  return out.subarray(0, w);
}

/** Encode raw input bytes as a `send-keys -H` argument list (hex bytes). */
export function toSendKeysHex(data: Buffer): string[] {
  const args: string[] = [];
  // The 0x prefix is required: bare "68" parses as the literal key string
  // "68", not a hex byte.
  for (const byte of data) args.push("0x" + byte.toString(16).padStart(2, "0"));
  return args;
}

export type ControlEvent =
  | { type: "output"; paneId: string; data: Buffer }
  | { type: "reply"; ok: boolean; lines: string[] }
  | { type: "exit"; reason?: string }
  | { type: "pause"; paneId: string }
  | { type: "continue"; paneId: string }
  | { type: "notification"; name: string; rest: string };

/**
 * Incremental parser for the control-mode stdout stream. Feed it raw chunks;
 * it emits one event per protocol unit. Reply blocks are framed by
 * `%begin <ts> <num> <flags>` ... `%end|%error <ts> <num> <flags>`; everything
 * inside the frame is command output (even lines starting with `%`).
 */
export class ControlModeParser {
  // Buffer bytes (not text): capture-pane reply blocks carry raw UTF-8, and a
  // read chunk can split a multibyte character mid-sequence.
  private buf: Buffer = Buffer.alloc(0);
  private inBlock = false;
  private blockLines: string[] = [];

  feed(chunk: Buffer | string, emit: (ev: ControlEvent) => void): void {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    this.buf = this.buf.length === 0 ? bytes : Buffer.concat([this.buf, bytes]);
    let idx: number;
    while ((idx = this.buf.indexOf(0x0a)) >= 0) {
      let end = idx;
      if (end > 0 && this.buf[end - 1] === 0x0d) end--;
      const line = this.buf.subarray(0, end);
      this.buf = this.buf.subarray(idx + 1);
      this.handleLine(line, emit);
    }
  }

  private handleLine(bytes: Buffer, emit: (ev: ControlEvent) => void): void {
    const line = bytes.toString("utf8");
    if (this.inBlock) {
      if (line.startsWith("%end ")) {
        this.inBlock = false;
        emit({ type: "reply", ok: true, lines: this.blockLines });
        this.blockLines = [];
      } else if (line.startsWith("%error ")) {
        this.inBlock = false;
        emit({ type: "reply", ok: false, lines: this.blockLines });
        this.blockLines = [];
      } else {
        this.blockLines.push(line);
      }
      return;
    }

    if (line.startsWith("%begin ")) {
      this.inBlock = true;
      this.blockLines = [];
      return;
    }
    if (line.startsWith("%output ")) {
      const sp = line.indexOf(" ", 8);
      if (sp > 0) {
        emit({ type: "output", paneId: line.slice(8, sp), data: unescapeControlData(bytes.subarray(sp + 1)) });
      }
      return;
    }
    // %extended-output %pane age ... : data  (emitted when pause-after is set)
    if (line.startsWith("%extended-output ")) {
      const colon = line.indexOf(" : ");
      const sp = line.indexOf(" ", 17);
      if (colon > 0 && sp > 0) {
        emit({ type: "output", paneId: line.slice(17, sp), data: unescapeControlData(bytes.subarray(colon + 3)) });
      }
      return;
    }
    if (line.startsWith("%exit")) {
      emit({ type: "exit", reason: line.length > 6 ? line.slice(6) : undefined });
      return;
    }
    if (line.startsWith("%pause ")) {
      emit({ type: "pause", paneId: line.slice(7) });
      return;
    }
    if (line.startsWith("%continue ")) {
      emit({ type: "continue", paneId: line.slice(10) });
      return;
    }
    if (line.startsWith("%")) {
      const sp = line.indexOf(" ");
      emit({
        type: "notification",
        name: sp > 0 ? line.slice(1, sp) : line.slice(1),
        rest: sp > 0 ? line.slice(sp + 1) : "",
      });
    }
    // Anything else (blank lines before the first %begin) is ignored.
  }
}
