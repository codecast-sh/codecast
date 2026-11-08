import { spawn, type ChildProcessWithoutNullStreams } from "../proc.js";
import { ControlModeParser, toSendKeysHex, type ControlEvent } from "./controlProtocol.js";
import { tmuxRun, tmuxRunAsync } from "../tmux.js";
import { routeTmuxArgs } from "../tmuxRoute.js";

const ENRICHED_PATH = [process.env.PATH, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].filter(Boolean).join(":");
const COMMAND_TIMEOUT_MS = 5000;
// send-keys arg-list chunking: keeps each control-mode command line small.
const INPUT_CHUNK_BYTES = 256;

function parseTerminalColors(colors: unknown) {
  if (!colors || typeof colors !== "object") return [];
  return ([["foreground", 10, "fg"], ["background", 11, "bg"]] as const).flatMap(([key, code, style]) => {
    const value = (colors as Record<string, unknown>)[key];
    if (typeof value !== "string" || !/^#[\da-f]{6}$/i.test(value)) return [];
    return [{ value, code, style }];
  });
}

export function terminalColorReports(colors: unknown): string[] {
  return parseTerminalColors(colors).map(({ value, code }) => {
    const rgb = value.slice(1).match(/../g)!.map((channel) => channel.repeat(2)).join("/");
    return `\\033]${code};rgb:${rgb}\\007`;
  });
}

/**
 * The control-mode commands that hand tmux the viewer's default colours.
 *
 * tmux answers an application's OSC 10/11 query on the pane's behalf, but only
 * once a client has REPORTED what its colours are — `refresh-client -r` is that
 * report. Without it tmux answers from its own idea of the terminal (black),
 * which is what made Codex paint dark panels inside a light xterm.
 *
 * Pure, so the exact bytes we hand tmux are provable without a live server.
 * The pane id comes from tmux itself, but it is interpolated into a command
 * line, so it is validated here the way shellSafe guards session names.
 */
export function colorReportCommands(paneId: string, colors: unknown): string[] {
  if (!/^%\d+$/.test(paneId)) return [];
  return terminalColorReports(colors).map((report) => `refresh-client -r "${paneId}:${report}"`);
}

export interface ControlClientEvents {
  onOutput(data: Buffer): void;
  onExit(reason?: string): void;
  /** The pane's geometry changed (a client resized it, the daemon refreshed
   *  it). Debounced, since tmux fires layout-change repeatedly during a drag.
   *  The caller decides whether viewers need a fresh capture at the new size:
   *  without one, xterm keeps stale columns and every later repaint wraps
   *  wrong, splicing fragments of different frames into the same row. */
  onLayoutChange?(): void;
}

export type ControlClientMode =
  | { kind: "create"; sessionName: string; cwd?: string; fresh?: boolean }
  | { kind: "attach"; target: string };

/** A screen capture: the pane's geometry and the bytes that repaint it. */
export interface PaneCapture {
  cols: number;
  rows: number;
  seed: Buffer;
}

type Reply = { ok: boolean; lines: string[] };

/**
 * A tmux control-mode (`tmux -C`) client: full PTY semantics (streamed output,
 * injected input, resize) over plain piped stdio — no native pty module, which
 * matters because the CLI ships as a compiled Bun binary.
 *
 * One client drives one pane. `create` mode makes/reattaches a standalone
 * terminal session (the web panel's shells); `attach` mode joins an existing
 * session — an agent's pane — with `ignore-size`, so it never resizes the pane
 * out from under the agent (the daemon screen-scrapes those panes at a known
 * width) until setSizing(true) hands it the pane's size.
 *
 * There is no tmux `read-only` flag on the attach: tmux cannot clear it once
 * set (so a watched pane could never be handed to a controller without a new
 * client and a full repaint), and it never gated the commands a control client
 * writes itself, `send-keys` included (checked against tmux 3.6). Input is
 * gated where it always really was: the caller only forwards the controller's.
 */
// Pane state a screen capture cannot carry. capture-pane hands back cells;
// the modes the program set (cursor visibility, alternate screen, mouse
// tracking, keypad) live only in tmux's screen model. A seed that omits them
// leaves xterm guessing — and after a reseed's reset() it guesses "off",
// so a Claude Code pane in mouse mode lost its wheel and clicks, and a
// cursor hidden mid-frame stayed hidden. Replaying them makes the seed a
// faithful snapshot: what tmux shows, xterm shows.
export const SEED_STATE_FIELDS = [
  "cursor_x",
  "cursor_y",
  "cursor_flag",
  "alternate_on",
  "mouse_any_flag",
  "mouse_button_flag",
  "mouse_standard_flag",
  "mouse_sgr_flag",
  "keypad_cursor_flag",
  "keypad_flag",
] as const;

export interface SeedState {
  cursorX: number;
  cursorY: number;
  cursorVisible: boolean;
  alternate: boolean;
  /** tmux tracks one mouse mode at a time: 1003 (any), 1002 (button), 1000 (standard). */
  mouse: "any" | "button" | "standard" | null;
  mouseSgr: boolean;
  keypadCursor: boolean;
  keypad: boolean;
}

export function parseSeedState(line: string): SeedState {
  const v = line.split("|").map((x) => parseInt(x, 10) || 0);
  const at = (f: (typeof SEED_STATE_FIELDS)[number]) => v[SEED_STATE_FIELDS.indexOf(f)] ?? 0;
  return {
    cursorX: at("cursor_x"),
    cursorY: at("cursor_y"),
    // Missing/garbled state (an old tmux, an empty reply) reads as visible.
    cursorVisible: line === "" || at("cursor_flag") !== 0,
    alternate: at("alternate_on") === 1,
    mouse: at("mouse_any_flag") ? "any" : at("mouse_button_flag") ? "button" : at("mouse_standard_flag") ? "standard" : null,
    mouseSgr: at("mouse_sgr_flag") === 1,
    keypadCursor: at("keypad_cursor_flag") === 1,
    keypad: at("keypad_flag") === 1,
  };
}

/**
 * The bytes that repaint a captured screen into an xterm of `paneRows` rows:
 * alternate-screen switch first (so the content lands in the right buffer),
 * the captured rows padded to a full screen, the cursor walked into place,
 * then the modes tmux reports. Pure: what controlClient captures is what
 * this lays out.
 */
export function buildSeed(captured: string[], paneRows: number, state: SeedState): string {
  // Trim trailing blank rows, then pad back to a full screen so the visible
  // area occupies exactly `paneRows` xterm rows and cursor math is absolute.
  let lines = captured;
  let last = lines.length - 1;
  while (last >= 0 && lines[last] === "") last--;
  lines = lines.slice(0, last + 1);
  const pad = Math.max(0, paneRows - Math.max(lines.length, 1));

  let text = state.alternate ? "\x1b[?1049h" : "";
  text += lines.join("\r\n");
  if (pad > 0) text += "\r\n".repeat(pad);
  // Cursor sits at the last screen row after the write; walk it into place.
  const up = paneRows - 1 - Math.min(state.cursorY, paneRows - 1);
  text += "\x1b[0m\r"; // reset any dangling attributes from the capture
  if (up > 0) text += `\x1b[${up}A`;
  if (state.cursorX > 0) text += `\x1b[${state.cursorX}C`;
  if (state.mouse) text += `\x1b[?${state.mouse === "any" ? 1003 : state.mouse === "button" ? 1002 : 1000}h`;
  if (state.mouseSgr) text += "\x1b[?1006h";
  if (state.keypadCursor) text += "\x1b[?1h";
  if (state.keypad) text += "\x1b=";
  text += state.cursorVisible ? "\x1b[?25h" : "\x1b[?25l";
  return text;
}

export class TmuxControlClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private parser = new ControlModeParser();
  private pending: Array<{ resolve: (r: Reply) => void; timer: NodeJS.Timeout | null; onReply?: (r: Reply) => void }> = [];
  private paneId: string | null = null;
  private started = false;
  private closed = false;
  private layoutTimer: NodeJS.Timeout | null = null;
  /** Attach only: whether this client sizes the pane (setSizing). */
  private sizing = false;
  private sizingChain: Promise<void> = Promise.resolve();
  /** Attach while sizing: the window's size before this client reshaped it,
   *  put back when sizing ends or on detach (see close). */
  private restoreSize: string | null = null;
  private colorReportSupport: Promise<boolean> | null = null;

  constructor(
    private mode: ControlClientMode,
    private events: ControlClientEvents,
  ) {}

  get pane(): string | null {
    return this.paneId;
  }

  /** Interactive attach: the window size handed back on detach. */
  get restoresTo(): string | null {
    return this.restoreSize;
  }

  /**
   * Spawn the client. Returns pane geometry so the caller can size xterm
   * before any bytes render. Output streams from here on; a viewer that needs
   * the screen as it stands asks capture() for it.
   */
  async start(cols: number, rows: number, colors?: unknown): Promise<{ cols: number; rows: number; sessionName: string }> {
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
      // A watcher must never reshape the pane out from under the agent;
      // setSizing lifts ignore-size once someone takes control.
      args.push("attach-session", "-t", this.mode.target, "-f", "ignore-size");
    }

    const env: Record<string, string | undefined> = { ...process.env, PATH: ENRICHED_PATH };
    delete env.TMUX; // allow spawning from inside a tmux session (dev)
    delete env.TMUX_PANE;
    // Daemons under launchd have no locale in their environment, and a shell
    // spawned from a C-locale client breaks every multibyte-aware program
    // (vim: E1511, broken line-drawing). Force UTF-8 unless the user set one.
    if (!env.LANG && !env.LC_ALL && !env.LC_CTYPE) env.LANG = "en_US.UTF-8";

    // An agent session may live on a tmux server of its own (tmuxRoute.ts).
    this.child = spawn("tmux", routeTmuxArgs(args, env)[0], { stdio: ["pipe", "pipe", "pipe"], env: env as NodeJS.ProcessEnv });

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
    // A wedged tmux server never sends it — fail loudly rather than limping
    // on to a "ready" the client renders as a silently blank pane.
    const startup = await this.expectReply();
    if (!startup.ok) {
      throw new Error(startup.lines.join(" ").trim() || "tmux did not respond — the tmux server may be hung");
    }

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
    // No pane means the attach didn't take (hung server, vanished session).
    // Resolving anyway would seed nothing and render as a blank pane with a
    // healthy status dot — surface the failure instead.
    if (!info.ok || !this.paneId) throw new Error("tmux attach failed — could not read the pane");
    await this.setColors(colors);
    const paneCols = parseInt(parts[1] ?? "", 10) || cols;
    const paneRows = parseInt(parts[2] ?? "", 10) || rows;
    const sessionName = parts[3] || (this.mode.kind === "create" ? this.mode.sessionName : this.mode.target);

    this.started = true;
    return { cols: paneCols, rows: paneRows, sessionName };
  }

  /**
   * Interactive attach: whether this client sizes the agent's real pane, like
   * `tmux attach` from iTerm (the sanctioned manual flow, which the daemon's
   * screen-scraping already tolerates daily). The daemon-owned pane usually
   * has NO other client, so with `window-size largest` whatever size we leave
   * behind STICKS (a 6x11 pane was found this way: the hello carried a
   * pre-layout guess). So: never resize on taking the size, only on the
   * viewer's laid-out resize; and remember the size found so giving it up,
   * or detaching, puts it back.
   */
  setSizing(on: boolean): Promise<void> {
    // One at a time: a release that overtook a pending take would leave tmux
    // sizing the pane with nobody in control (the sticky-size bug class).
    const run = this.sizingChain.then(() => this.applySizing(on));
    this.sizingChain = run.catch(() => {});
    return run;
  }

  private async applySizing(on: boolean): Promise<void> {
    if (this.mode.kind !== "attach" || this.closed || on === this.sizing) return;
    this.sizing = on;
    if (on) {
      const size = await this.command("display-message -p -F '#{window_width}x#{window_height}'");
      const found = (size.lines[0] ?? "").trim();
      if (/^\d+x\d+$/.test(found)) this.restoreSize = found;
      await this.command("refresh-client -f !ignore-size");
      return;
    }
    const restore = this.restoreSize;
    this.restoreSize = null;
    if (restore) await this.command(`refresh-client -C ${restore}`);
    await this.command("refresh-client -f ignore-size");
  }

  /**
   * Screen + scrollback snapshot of the client's pane, plus the modes and
   * cursor a capture cannot carry. `onCaptured` runs synchronously at the
   * capture's own point in the output stream: every `%output` before it is
   * already in the picture and every one after is not, which is what lets a
   * caller splice the seed into a byte stream without a duplicate or a gap.
   * Resolves false when the capture failed (onCaptured never ran).
   */
  async capture(onCaptured: (capture: PaneCapture) => void): Promise<boolean> {
    // The state is read just before the capture; both target the client's
    // current pane, so a pane swapped under us is followed.
    let meta: Reply | null = null;
    let delivered = false;
    const metaReply = this.enqueue(
      `display-message -p -F '#{pane_id}|#{pane_width}|#{pane_height}|${SEED_STATE_FIELDS.map((f) => `#{${f}}`).join("|")}'`,
      (r) => { meta = r; },
    );
    // `-S -` = from the very start of the pane's history: the pane's own
    // history-limit is the real cap, and xterm's scrollback holds the rest.
    const capReply = this.enqueue("capture-pane -peqJ -S -", (cap) => {
      const m = meta as Reply | null;
      if (!m?.ok || !cap.ok) return;
      const [pane, w, h, ...state] = (m.lines[0] ?? "").split("|");
      const cols = parseInt(w ?? "", 10);
      const rows = parseInt(h ?? "", 10);
      if (!cols || !rows) return;
      if (pane) this.paneId = pane;
      delivered = true;
      onCaptured({ cols, rows, seed: Buffer.from(buildSeed(cap.lines, rows, parseSeedState(state.join("|"))), "utf8") });
    });
    await Promise.all([metaReply, capReply]);
    return delivered;
  }

  private handleEvent(ev: ControlEvent): void {
    switch (ev.type) {
      case "output":
        // Other panes' output (splits, other windows) is out of scope for a
        // single-pane view. A brand-new session streams from its very first
        // byte, before its pane id is known: a single-pane session has nothing
        // else that could be emitting, and waiting would DROP the shell's
        // first prompt. Anything else that early belongs to no viewer yet.
        if (this.paneId ? ev.paneId === this.paneId : this.mode.kind === "create" && !!this.mode.fresh) {
          this.events.onOutput(ev.data);
        }
        break;
      case "reply": {
        const p = this.pending.shift();
        if (p) {
          if (p.timer) clearTimeout(p.timer);
          const reply = { ok: ev.ok, lines: ev.lines };
          // Synchronous, in stream order: see capture().
          p.onReply?.(reply);
          p.resolve(reply);
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
      case "notification":
        if (ev.name === "layout-change" && this.started && this.events.onLayoutChange) {
          if (this.layoutTimer) clearTimeout(this.layoutTimer);
          this.layoutTimer = setTimeout(() => {
            this.layoutTimer = null;
            if (!this.closed) this.events.onLayoutChange?.();
          }, 300);
          this.layoutTimer.unref?.();
        }
        break;
      default:
        break;
    }
  }

  /** Write raw input bytes to the pane (hex-encoded send-keys, binary-safe).
   *  The caller decides whose input this is; this client writes whatever it
   *  is given. */
  sendInput(data: Buffer): void {
    if (this.closed || !this.paneId) return;
    for (let i = 0; i < data.length; i += INPUT_CHUNK_BYTES) {
      const chunk = data.subarray(i, i + INPUT_CHUNK_BYTES);
      void this.command(`send-keys -t ${this.paneId} -H ${toSendKeysHex(chunk).join(" ")}`);
    }
  }

  /** Report the viewer's default colours to tmux (startup and theme changes). */
  async setColors(colors: unknown): Promise<void> {
    if (this.closed || !this.paneId) return;
    let commands = colorReportCommands(this.paneId, colors);
    if (commands.length === 0) return;
    const supported = await (this.colorReportSupport ??= this.command("list-commands refresh-client").then((reply) => {
      if (!reply.ok) throw new Error(`Could not detect tmux color support: ${reply.lines.join(" ") || "tmux did not respond"}`);
      return reply.lines.some((line) => line.includes("[-r pane:report]"));
    }));
    if (!supported) {
      if (this.mode.kind !== "create") {
        throw new Error("Viewing an existing terminal with theme colors requires tmux 3.5 or newer. Upgrade tmux on the session's machine.");
      }
      const channels = parseTerminalColors(colors);
      commands = channels.map(({ value, style }) =>
        `set-option -p -t ${this.paneId} @codecast-terminal-${style} '${value}'`,
      );
      for (const option of ["window-style", "window-active-style"]) {
        const reply = await this.command(`show-options -pAv -t ${this.paneId} ${option}`);
        if (!reply.ok) throw new Error(`Could not read terminal colors: ${reply.lines.join(" ") || "tmux did not respond"}`);
        const current = reply.lines.join("");
        const additions = channels.map(({ style }) => `${style}=#{@codecast-terminal-${style}}`).filter((style) => !current.includes(style));
        const style = [current, ...additions].filter(Boolean).join(",").replace(/[\\"$]/g, "\\$&");
        commands.push(`set-option -p -t ${this.paneId} ${option} "${style}"`);
      }
    }
    for (const cmd of commands) {
      const reply = await this.command(cmd);
      if (!reply.ok) throw new Error(`Could not set terminal colors: ${reply.lines.join(" ") || "tmux did not respond"}`);
    }
  }

  resize(cols: number, rows: number): void {
    // A created shell is sized like any terminal; an attach only while it
    // holds the pane's size (setSizing).
    if (this.closed || (this.mode.kind === "attach" && !this.sizing)) return;
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
        // Hand the pane back at the size we found it. Sizing our own client
        // (not resize-window, which flips the window to manual sizing) lets
        // `window-size largest` snap the window back before we go, and a
        // client that attaches later still gets to impose its own size.
        const restore = this.restoreSize ? `refresh-client -C ${this.restoreSize}\n` : "";
        this.child.stdin.write(`${restore}detach-client\n`);
      } catch {}
      // detach-client ends the control client by itself; give the commands
      // a moment to reach the server before falling back to a signal, or
      // the restore races the kill.
      const child = this.child;
      const fallback = setTimeout(() => this.destroyChild(), 1000);
      fallback.unref?.();
      child.once("exit", () => {
        clearTimeout(fallback);
        if (this.child === child) this.child = null;
        void this.verifyRestore();
      });
    }
  }

  /**
   * Detach NOW, without the control channel: for daemon shutdown, where
   * close()'s in-band restore rides a stdin write the process won't live to
   * see drained, and verifyRestore — which runs on the child's exit event —
   * never gets its turn (a pane was left at 165x6 this way, 2026-08-21). Our
   * client is found by pid and detached from outside, then the window is
   * repaired the same way verifyRestore would.
   */
  closeSync(): void {
    if (this.closed) return;
    this.closed = true;
    this.failPending();
    const pid = this.child?.pid;
    if (pid && this.mode.kind === "attach") {
      try {
        const r = tmuxRun(["list-clients", "-t", this.mode.target, "-F", "#{client_name}|#{client_pid}"]);
        for (const line of r.stdout.split("\n")) {
          const [name, cpid] = line.split("|");
          if (name && parseInt(cpid ?? "", 10) === pid) tmuxRun(["detach-client", "-t", name]);
        }
      } catch {}
    }
    this.verifyRestoreSync();
    this.destroyChild();
  }

  /**
   * The in-band restore can be lost — the daemon shutting down under us, a
   * child killed before its stdin drained. Once our client is gone, check
   * the window and repair it from outside if needed: resize-window flips the
   * window to manual sizing, so the option is unset again right after and a
   * later real client still gets to impose its size.
   *
   * The check is one probe and the repairs its answer calls for, as data, so
   * the async path (a panel detach, on the daemon's loop) and the sync path
   * (daemon shutdown, which cannot wait for a promise) share one policy.
   */
  private restoreProbe(): { target: string; args: string[] } | null {
    if (!this.restoreSize || this.mode.kind !== "attach") return null;
    const target = this.mode.target;
    return { target, args: ["display-message", "-p", "-t", target, "#{window_width}x#{window_height}|#{session_attached}"] };
  }

  private restoreRepairs(target: string, probeOut: string): string[][] {
    const [size, attached] = probeOut.trim().split("|");
    // Another client is attached: the window is theirs to size.
    if (!size || size === this.restoreSize || parseInt(attached ?? "0", 10) > 0) return [];
    const [w, h] = this.restoreSize!.split("x");
    return [
      ["resize-window", "-t", target, "-x", w!, "-y", h!],
      ["set-option", "-w", "-t", target, "-u", "window-size"],
    ];
  }

  private async verifyRestore(): Promise<void> {
    const probe = this.restoreProbe();
    if (!probe) return;
    try {
      const now = (await tmuxRunAsync(probe.args)).stdout;
      for (const args of this.restoreRepairs(probe.target, now)) await tmuxRunAsync(args);
    } catch {}
  }

  private verifyRestoreSync(): void {
    const probe = this.restoreProbe();
    if (!probe) return;
    try {
      const now = tmuxRun(probe.args).stdout;
      for (const args of this.restoreRepairs(probe.target, now)) tmuxRun(args);
    } catch {}
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
  private expectReply(): Promise<Reply> {
    return this.enqueue(null);
  }

  private command(cmd: string): Promise<Reply> {
    return this.enqueue(cmd);
  }

  private enqueue(cmd: string | null, onReply?: (r: Reply) => void): Promise<Reply> {
    if (!this.child || this.closed) return Promise.resolve({ ok: false, lines: [] });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const idx = this.pending.findIndex((p) => p.timer === timer);
        if (idx >= 0) this.pending.splice(idx, 1);
        resolve({ ok: false, lines: [] });
      }, COMMAND_TIMEOUT_MS);
      timer.unref?.();
      this.pending.push({ resolve, timer, onReply });
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
