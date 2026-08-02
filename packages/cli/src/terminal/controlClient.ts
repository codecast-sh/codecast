import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { ControlModeParser, toSendKeysHex, type ControlEvent } from "./controlProtocol.js";

const ENRICHED_PATH = [process.env.PATH, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].filter(Boolean).join(":");
const COMMAND_TIMEOUT_MS = 5000;
// send-keys arg-list chunking: keeps each control-mode command line small.
const INPUT_CHUNK_BYTES = 256;

export interface ControlClientEvents {
  onOutput(data: Buffer): void;
  onExit(reason?: string): void;
}

export type ControlClientMode =
  | { kind: "create"; sessionName: string; cwd?: string; fresh?: boolean }
  | { kind: "attach"; target: string; readOnly: boolean };

/**
 * A tmux control-mode (`tmux -C`) client: full PTY semantics (streamed output,
 * injected input, resize) over plain piped stdio — no native pty module, which
 * matters because the CLI ships as a compiled Bun binary.
 *
 * One client drives one pane. `create` mode makes/reattaches a standalone
 * terminal session (the web panel's shells); `attach` mode joins an existing
 * session — an agent's pane — with `ignore-size` so a viewer never resizes the
 * pane out from under the agent (the daemon screen-scrapes those panes at a
 * known width), and `read-only` unless interaction was explicitly requested.
 */
export class TmuxControlClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private parser = new ControlModeParser();
  private pending: Array<{ resolve: (r: { ok: boolean; lines: string[] }) => void; timer: NodeJS.Timeout | null }> = [];
  private paneId: string | null = null;
  private seeded = false;
  private closed = false;

  constructor(
    private mode: ControlClientMode,
    private events: ControlClientEvents,
  ) {}

  get pane(): string | null {
    return this.paneId;
  }

  get isReadOnly(): boolean {
    return this.mode.kind === "attach" && this.mode.readOnly;
  }

  /**
   * Spawn the client and seed the screen. Returns pane geometry so the caller
   * can size xterm before any bytes render. Live `%output` received before the
   * capture-pane reply is discarded — it is already reflected in the capture
   * (the stdout stream is chronological), which is what makes the seed
   * duplicate-free.
   */
  async start(cols: number, rows: number): Promise<{ cols: number; rows: number; seed: Buffer; sessionName: string }> {
    const args = ["-u", "-C"]; // -u: force UTF-8 regardless of client locale
    if (this.mode.kind === "create") {
      args.push("new-session", "-A", "-s", shellSafe(this.mode.sessionName), "-x", String(cols), "-y", String(rows));
      if (this.mode.cwd) args.push("-c", this.mode.cwd);
      // Session env, not client env: a new session inherits the tmux SERVER's
      // environment (LANG is not in update-environment), and a server first
      // started by the launchd daemon has no locale at all — every multibyte
      // program in the shell then misbehaves (vim E1511, broken box drawing).
      args.push("-e", `LANG=${process.env.LC_ALL || process.env.LANG || "en_US.UTF-8"}`);
    } else {
      const flags = ["ignore-size"];
      if (this.mode.readOnly) flags.push("read-only");
      args.push("attach-session", "-t", this.mode.target, "-f", flags.join(","));
    }

    const env: Record<string, string | undefined> = { ...process.env, PATH: ENRICHED_PATH };
    delete env.TMUX; // allow spawning from inside a tmux session (dev)
    delete env.TMUX_PANE;
    // Daemons under launchd have no locale in their environment, and a shell
    // spawned from a C-locale client breaks every multibyte-aware program
    // (vim: E1511, broken line-drawing). Force UTF-8 unless the user set one.
    if (!env.LANG && !env.LC_ALL && !env.LC_CTYPE) env.LANG = "en_US.UTF-8";

    this.child = spawn("tmux", args, { stdio: ["pipe", "pipe", "pipe"], env: env as NodeJS.ProcessEnv });

    this.child.stdout.on("data", (chunk: Buffer) => {
      this.parser.feed(chunk, (ev) => this.handleEvent(ev));
    });
    let stderrTail = "";
    this.child.stderr.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-500);
    });
    const die = (reason?: string) => {
      if (this.closed) return;
      this.closed = true;
      this.failPending();
      this.events.onExit(reason);
    };
    this.child.on("exit", () => die(stderrTail.trim() || undefined));
    this.child.on("error", (err) => die(err.message));

    // Control mode emits one (empty) %begin/%end reply block on startup.
    // Consume it before issuing commands or every reply pairs off-by-one.
    await this.expectReply();

    // A brand-new session has no history to seed, so stream from the very
    // first byte instead of capture-seeding. Waiting for the capture would
    // DROP the shell's initial prompt: it usually prints after capture-pane
    // runs but before the seeded flag flips, leaving the terminal blank until
    // the user's first Enter forces a new prompt.
    if (this.mode.kind === "create" && this.mode.fresh) this.seeded = true;

    if (this.mode.kind === "create") {
      // No status line for panel terminals: control clients never render it,
      // and without this the window reserves a row for a bar nobody sees.
      await this.command(`set-option -q -t ${shellSafe(this.mode.sessionName)} status off`);
      await this.command(`refresh-client -C ${cols}x${rows}`);
    }

    // NB: separator must be printable — tmux sanitizes control chars (tabs
    // included) to "_" in display-message output. "|" can't appear in pane
    // ids, dimensions, or shellSafe session names.
    const info = await this.command(
      "display-message -p -F '#{pane_id}|#{pane_width}|#{pane_height}|#{session_name}'",
    );
    const parts = (info.lines[0] ?? "").split("|");
    this.paneId = parts[0] || null;
    const paneCols = parseInt(parts[1] ?? "", 10) || cols;
    const paneRows = parseInt(parts[2] ?? "", 10) || rows;
    const sessionName = parts[3] || (this.mode.kind === "create" ? this.mode.sessionName : this.mode.target);

    const seed = this.seeded ? Buffer.alloc(0) : await this.captureSeed(paneRows);
    this.seeded = true;
    return { cols: paneCols, rows: paneRows, seed, sessionName };
  }

  /** Screen + scrollback snapshot, plus a cursor-restore tail. */
  private async captureSeed(paneRows: number): Promise<Buffer> {
    if (!this.paneId) return Buffer.alloc(0);
    const target = this.paneId;
    const cap = await this.command(`capture-pane -peqJ -t ${target} -S -2000`);
    const cur = await this.command(`display-message -p -t ${target} -F '#{cursor_x}|#{cursor_y}'`);
    if (!cap.ok) return Buffer.alloc(0);

    // Trim trailing blank rows, then pad back to a full screen so the visible
    // area occupies exactly `paneRows` xterm rows and cursor math is absolute.
    let lines = cap.lines;
    let last = lines.length - 1;
    while (last >= 0 && lines[last] === "") last--;
    lines = lines.slice(0, last + 1);
    const pad = Math.max(0, paneRows - Math.max(lines.length, 1));

    const [cxs, cys] = (cur.lines[0] ?? "").split("|");
    const cursorX = parseInt(cxs ?? "", 10) || 0;
    const cursorY = parseInt(cys ?? "", 10) || 0;

    let text = lines.join("\r\n");
    if (pad > 0) text += "\r\n".repeat(pad);
    // Cursor sits at the last screen row after the write; walk it into place.
    const up = paneRows - 1 - Math.min(cursorY, paneRows - 1);
    text += "\x1b[0m\r"; // reset any dangling attributes from the capture
    if (up > 0) text += `\x1b[${up}A`;
    if (cursorX > 0) text += `\x1b[${cursorX}C`;
    return Buffer.from(text, "utf8");
  }

  private handleEvent(ev: ControlEvent): void {
    switch (ev.type) {
      case "output":
        // Pre-seed output is folded into the capture; other panes' output
        // (splits, other windows) is out of scope for a single-pane view.
        // paneId is still null in the fresh-create stream-from-start window —
        // a single-pane session has nothing else that could be emitting.
        if (this.seeded && (!this.paneId || ev.paneId === this.paneId)) this.events.onOutput(ev.data);
        break;
      case "reply": {
        const p = this.pending.shift();
        if (p) {
          if (p.timer) clearTimeout(p.timer);
          p.resolve({ ok: ev.ok, lines: ev.lines });
        }
        break;
      }
      case "exit":
        if (!this.closed) {
          this.closed = true;
          this.failPending();
          this.events.onExit(ev.reason?.trim() || undefined);
          this.destroyChild();
        }
        break;
      default:
        break;
    }
  }

  /** Write raw input bytes to the pane (hex-encoded send-keys, binary-safe). */
  sendInput(data: Buffer): void {
    if (this.closed || !this.paneId || this.isReadOnly) return;
    for (let i = 0; i < data.length; i += INPUT_CHUNK_BYTES) {
      const chunk = data.subarray(i, i + INPUT_CHUNK_BYTES);
      void this.command(`send-keys -t ${this.paneId} -H ${toSendKeysHex(chunk).join(" ")}`);
    }
  }

  resize(cols: number, rows: number): void {
    if (this.closed || this.mode.kind === "attach") return; // never resize someone else's pane
    void this.command(`refresh-client -C ${Math.max(2, cols)}x${Math.max(2, rows)}`);
  }

  /** Backpressure: stop reading tmux output while the websocket is congested. */
  pauseOutput(): void {
    this.child?.stdout.pause();
  }

  resumeOutput(): void {
    this.child?.stdout.resume();
  }

  /** Kill the underlying tmux session (create-mode terminals only). */
  async killSession(): Promise<void> {
    if (this.mode.kind !== "create") return;
    await this.command(`kill-session -t ${shellSafe(this.mode.sessionName)}`);
  }

  /** Detach the client, leaving the tmux session running. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.failPending();
    if (this.child) {
      try {
        this.child.stdin.write("detach-client\n");
      } catch {}
      this.destroyChild();
    }
  }

  private destroyChild(): void {
    const child = this.child;
    this.child = null;
    if (!child) return;
    // A tmux client whose server dies can wedge in a busy loop ignoring
    // SIGTERM (see tmux.ts) — escalate to SIGKILL if it lingers.
    const killTimer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
    }, 2000);
    killTimer.unref?.();
    child.once("exit", () => clearTimeout(killTimer));
    try { child.kill("SIGTERM"); } catch {}
  }

  /** Wait for the next reply block without writing a command (startup guard). */
  private expectReply(): Promise<{ ok: boolean; lines: string[] }> {
    return this.enqueue(null);
  }

  private command(cmd: string): Promise<{ ok: boolean; lines: string[] }> {
    return this.enqueue(cmd);
  }

  private enqueue(cmd: string | null): Promise<{ ok: boolean; lines: string[] }> {
    if (!this.child || this.closed) return Promise.resolve({ ok: false, lines: [] });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const idx = this.pending.findIndex((p) => p.timer === timer);
        if (idx >= 0) this.pending.splice(idx, 1);
        resolve({ ok: false, lines: [] });
      }, COMMAND_TIMEOUT_MS);
      timer.unref?.();
      this.pending.push({ resolve, timer });
      if (cmd !== null) {
        try {
          this.child!.stdin.write(cmd + "\n");
        } catch {
          const idx = this.pending.findIndex((p) => p.timer === timer);
          if (idx >= 0) this.pending.splice(idx, 1);
          clearTimeout(timer);
          resolve({ ok: false, lines: [] });
        }
      }
    });
  }

  private failPending(): void {
    for (const p of this.pending.splice(0)) {
      if (p.timer) clearTimeout(p.timer);
      p.resolve({ ok: false, lines: [] });
    }
  }
}

/** Names/targets we pass inline in control commands: strict allowlist. */
export function shellSafe(name: string): string {
  if (!/^[A-Za-z0-9_@%.:-]+$/.test(name)) throw new Error(`Unsafe tmux name: ${name}`);
  return name;
}
