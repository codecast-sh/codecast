// One live terminal shared by every socket viewing it.
//
// A socket used to own its tmux control client: a dropped socket (a phone
// asleep, a network change, a laptop lid) tore the client down, and the
// reconnect started over with a full capture-and-repaint. A hub instead owns
// the one control client for a terminal and outlives its sockets for a while,
// so a reconnecting viewer resumes where it left off.
//
// RESUME. Everything a viewer is sent after its first screen lives in an
// OutputRing at an absolute offset: pane output takes one offset per byte,
// and a repaint (a reseed, when the pane changed size) takes one. A viewer
// keeps the offset it has reached and presents it on reconnect, with the id
// of the stream it came from. If the ring still holds that offset, the hub
// replays from it, says `replay_complete`, and goes live; nothing is
// repainted. If the ring has moved past it, or the stream is not this hub's
// (the hub expired, the daemon restarted), the viewer gets a fresh capture
// marked `truncated` and repaints from scratch.
//
// ROLES. One viewer is the controller: its input reaches the pane, and its
// size is the pane's size. Everyone else observes: their input is dropped
// here, their size is ignored, and their xterm adopts the pane's. A viewer
// takes control explicitly (`takeover`); the previous controller is told,
// and becomes an observer. A controller that drops keeps its seat for a
// while, so its own reconnect resumes in control instead of losing the
// keyboard to whoever was watching.

import crypto from "crypto";
import { WebSocket } from "ws";
import { TmuxControlClient, type ControlClientEvents, type ControlClientMode, type PaneCapture } from "./controlClient.js";

/** What a hub needs from its control client. */
export type HubClient = Pick<
  TmuxControlClient,
  "start" | "capture" | "setSizing" | "sendInput" | "resize" | "setColors" | "pauseOutput" | "resumeOutput" | "killSession" | "close" | "closeSync" | "restoresTo"
>;

/** Bytes of output a hub keeps for viewers to resume from. */
export const RING_BYTES = 2 * 1024 * 1024;
/** How long a hub with no viewers keeps its control client and ring. An
 *  attach holds the agent's session attached (which defers the daemon's
 *  hibernation and pane heals), so it lets go sooner than a panel shell. */
export const HUB_LINGER_MS = { create: 5 * 60_000, attach: 60_000 } as const;
/** How long a dropped controller keeps its seat for its own reconnect. */
export const CONTROL_HOLD_MS = 30_000;
// Above this many unsent bytes a viewer stops being written to and catches up
// from the ring once it drains. tmux itself is paused only when EVERY viewer
// is that far behind: one slow phone must not stall the controller's shell.
const HIGH_WATER_BYTES = 1_000_000;
const DRAIN_POLL_MS = 50;

export type RingRecord =
  | { kind: "output"; start: number; data: Buffer }
  | { kind: "reseed"; start: number; cols: number; rows: number; seed: Buffer };

/** Bounded output history addressed by absolute offset. Pure. */
export class OutputRing {
  private records: RingRecord[] = [];
  private bytes = 0;
  private end = 0;
  /** The oldest offset a viewer can resume from. */
  private base = 0;

  constructor(private readonly limit = RING_BYTES) {}

  /** The offset the next record will take: everything before it was sent. */
  get offset(): number {
    return this.end;
  }

  /** The oldest offset still held. */
  get start(): number {
    return this.base;
  }

  appendOutput(data: Buffer): void {
    if (data.length === 0) return;
    this.push({ kind: "output", start: this.end, data }, data.length, data.length);
  }

  /**
   * A full repaint supersedes everything before it: any viewer behind it is
   * repainted by it, so the older records are dropped (a viewer still resumes
   * from any offset since `start`, starting with this repaint) rather than
   * crowding resumable output out of the ring.
   */
  appendReseed(capture: PaneCapture): RingRecord {
    const rec: RingRecord = { kind: "reseed", start: this.end, ...capture };
    this.records = [];
    this.bytes = 0;
    this.push(rec, 1, capture.seed.length);
    return rec;
  }

  /** Forget everything before now: a resume from earlier needs a fresh screen. */
  cut(): void {
    this.records = [];
    this.bytes = 0;
    this.base = this.end;
  }

  /**
   * What a viewer at `from` has not seen, oldest first, the first output
   * record trimmed to begin exactly at `from`. Null when `from` is no longer
   * held (or was never reached): the viewer needs a fresh screen.
   */
  since(from: number): RingRecord[] | null {
    if (!Number.isInteger(from) || from < this.start || from > this.end) return null;
    const out: RingRecord[] = [];
    for (const rec of this.records) {
      if (rec.kind === "reseed") {
        if (rec.start >= from) out.push(rec);
        continue;
      }
      const recEnd = rec.start + rec.data.length;
      if (recEnd <= from) continue;
      out.push(rec.start >= from ? rec : { kind: "output", start: from, data: rec.data.subarray(from - rec.start) });
    }
    return out;
  }

  private push(rec: RingRecord, width: number, size: number): void {
    this.records.push(rec);
    this.end += width;
    this.bytes += size;
    // Always keep the newest record, however large: the live edge must be
    // resumable even when one burst outgrew the ring.
    while (this.bytes > this.limit && this.records.length > 1) {
      const old = this.records.shift()!;
      this.bytes -= old.kind === "output" ? old.data.length : old.seed.length;
      this.base = this.records[0]!.start;
    }
  }
}

export type Role = "controller" | "observer";

export interface JoinRequest {
  /** Stable for one terminal view across its reconnects (client generated). */
  viewId: string | null;
  /** May this viewer ever hold control? (a created shell, or an attach that
   *  asked to be interactive) */
  canControl: boolean;
  resume: { stream: string; offset: number } | null;
}

export interface HubOptions {
  log: (msg: string) => void;
  /** Controller input on its way into an attached agent pane (see
   *  TerminalServerOptions.onInput). */
  onInput?: (target: string, data: Buffer) => void;
  /** The hub is gone; drop it from the registry. */
  onDispose: () => void;
  /** Overrides for tests. */
  makeClient?: (mode: ControlClientMode, events: ControlClientEvents) => HubClient;
  lingerMs?: number;
  controlHoldMs?: number;
  ringBytes?: number;
}

interface Viewer {
  ws: WebSocket;
  viewId: string | null;
  canControl: boolean;
  /** Has its first screen and is fed live output. */
  live: boolean;
  /** The ring offset everything before which this viewer has been sent. */
  sent: number;
  /** Over the high-water mark: catches up from the ring once drained. */
  lagging: boolean;
}

export interface StartInfo {
  cols: number;
  rows: number;
  sessionName: string;
}

export class TerminalHub {
  /** Names this hub's offset space: a resume from any other is a repaint. */
  readonly stream = crypto.randomBytes(6).toString("hex");
  readonly client: HubClient;
  private readonly ring: OutputRing;
  private readonly viewers = new Set<Viewer>();
  private controller: Viewer | null = null;
  /** A dropped controller's seat, kept for its own reconnect. */
  private held: { viewId: string; timer: NodeJS.Timeout } | null = null;
  /** A view whose held seat was taken while it was away: told on return. */
  private takenFrom: string | null = null;
  private lingerTimer: NodeJS.Timeout | null = null;
  private drainTimer: NodeJS.Timeout | null = null;
  private paused = false;
  private disposed = false;
  /** Some viewer has had a first screen: the ring no longer starts at a
   *  screen the next joiner could replay from. */
  private everLive = false;
  private started: Promise<StartInfo> | null = null;
  private cols = 80;
  private rows = 24;
  private sessionName = "?";

  constructor(
    readonly mode: ControlClientMode,
    private readonly opts: HubOptions,
  ) {
    this.ring = new OutputRing(opts.ringBytes ?? RING_BYTES);
    this.client = (opts.makeClient ?? ((m, e) => new TmuxControlClient(m, e)))(mode, {
      onOutput: (data) => this.onOutput(data),
      onExit: (reason) => {
        this.broadcast({ type: "exit", reason });
        this.dispose("exited");
      },
      onLayoutChange: () => this.onLayoutChange(),
    });
  }

  /** Start the control client once; every joiner waits on the same start. */
  start(cols: number, rows: number, colors?: unknown): Promise<StartInfo> {
    this.started ??= this.client.start(cols, rows, colors).then((info) => {
      this.cols = info.cols;
      this.rows = info.rows;
      this.sessionName = info.sessionName;
      return info;
    });
    return this.started;
  }

  get viewerCount(): number {
    return this.viewers.size;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * Add a socket. Resolves once it has its first screen (a replay or a fresh
   * capture) and is live. The caller has authenticated it already.
   */
  async join(ws: WebSocket, req: JoinRequest): Promise<void> {
    if (this.lingerTimer) clearTimeout(this.lingerTimer);
    this.lingerTimer = null;
    const viewer: Viewer = { ws, viewId: req.viewId, canControl: req.canControl, live: false, sent: 0, lagging: false };
    // The same view reconnecting while its old socket still looks open (a
    // half-dead TCP connection the server has not noticed): the new socket
    // replaces it, and inherits its seat.
    let inherit = false;
    if (req.viewId) {
      for (const v of this.viewers) {
        if (v.viewId !== req.viewId) continue;
        if (v === this.controller) inherit = true;
        this.removeViewer(v, { keepSeat: true, hold: false });
        try { v.ws.close(4001, "replaced"); } catch {}
      }
    }
    this.viewers.add(viewer);
    // A clean close (1000/1001) is the view leaving on purpose: a closed tab, a
    // reload, a navigation. Its seat is not held. Anything else is a drop.
    // 1001 is a page going away (a closed window or browser).
    ws.on("close", (code: number) => this.leave(viewer, code === 1000 || code === 1001));
    ws.on("error", () => this.leave(viewer, false));

    if (req.canControl && (inherit || (!this.controller && (!this.held || this.held.viewId === req.viewId)))) {
      this.seat(viewer);
    }
    if (this.controller === viewer && this.mode.kind === "attach") await this.client.setSizing(true);
    // A replaced controller whose replacement may not hold the seat.
    else if (!this.controller) await this.fillSeat();
    if (!this.viewers.has(viewer) || this.disposed) return;

    const fresh = this.mode.kind === "create" && !!this.mode.fresh && !this.everLive;
    const resume = req.resume?.stream === this.stream ? req.resume : null;
    const resuming = !!resume;
    const resumeFrom =
      resume
        ? resume.offset
        // A brand-new shell's first viewer: its whole life is still in the
        // ring, and replaying it from the first byte is exact, where a capture
        // could drop the prompt the shell is printing right now.
        : fresh && this.ring.start === 0 ? 0 : null;
    const backlog = resumeFrom === null ? null : this.ring.since(resumeFrom);
    if (backlog) {
      // A view that asked to resume some other stream (a shell that died and
      // was started again under its name) must clear its old screen.
      this.sendReady(viewer, { offset: resumeFrom!, resumed: resuming, ...(req.resume && !resuming ? { truncated: true } : {}), seedBytes: 0 });
      this.sendRecords(viewer, backlog);
      this.goLive(viewer);
      return;
    }
    // No usable offset: a fresh screen, spliced in at the capture's own point
    // in the stream so live output continues it with nothing doubled or lost.
    const truncated = !!req.resume;
    const ok = await this.client.capture((cap) => {
      if (!this.viewers.has(viewer)) return;
      this.cols = cap.cols;
      this.rows = cap.rows;
      this.sendReady(viewer, { offset: this.ring.offset, truncated, seedBytes: cap.seed.length });
      if (cap.seed.length) viewer.ws.send(cap.seed);
      this.goLive(viewer);
    });
    if (!ok && this.viewers.has(viewer) && !viewer.live) {
      // The capture failed (pane mid-respawn, a slow server): an empty screen
      // that streams beats a socket that never opens.
      this.sendReady(viewer, { offset: this.ring.offset, truncated, seedBytes: 0 });
      this.goLive(viewer);
    }
  }

  /** Input from a socket: only the controller's reaches the pane. */
  input(ws: WebSocket, data: Buffer): void {
    const v = this.viewerFor(ws);
    if (!v || v !== this.controller) return;
    this.client.sendInput(data);
    if (this.mode.kind === "attach") this.opts.onInput?.(this.mode.target, data);
  }

  /** A resize from a socket: only the controller's shapes the pane. */
  resize(ws: WebSocket, cols: number, rows: number): void {
    const v = this.viewerFor(ws);
    if (!v || v !== this.controller) return;
    this.client.resize(cols, rows);
    if (this.mode.kind === "create") {
      this.cols = cols;
      this.rows = rows;
    }
  }

  /** Colours are the controller's theme; tmux has one set per client. */
  setColors(ws: WebSocket, colors: unknown): Promise<void> {
    const v = this.viewerFor(ws);
    if (!v || v !== this.controller) return Promise.resolve();
    return this.client.setColors(colors);
  }

  /** An explicit take-control from a viewer allowed to hold it. */
  async takeover(ws: WebSocket): Promise<void> {
    const v = this.viewerFor(ws);
    if (!v || !v.canControl || v === this.controller) return;
    const previous = this.controller;
    if (!previous && this.held) this.takenFrom = this.held.viewId;
    this.seat(v);
    this.opts.log(`[TERM] takeover ${this.sessionName}${previous ? " (previous controller demoted)" : ""}`);
    if (this.mode.kind === "attach") await this.client.setSizing(true);
    this.broadcastRoles(previous ?? undefined);
  }

  /** Kill a created shell's session. An attach never kills the agent's. */
  async kill(ws: WebSocket): Promise<void> {
    const v = this.viewerFor(ws);
    if (!v || !v.canControl || this.mode.kind !== "create") return;
    await this.client.killSession();
    this.broadcast({ type: "exit", reason: "killed" });
    this.dispose("killed");
  }

  /** Daemon shutdown: hand the pane back now, outside the control channel. */
  shutdown(): void {
    this.dispose("shutdown", true);
  }

  /** The start failed: let go without blocking on a tmux that may be hung. */
  abort(): void {
    this.dispose("start failed");
  }

  private seat(v: Viewer): void {
    if (this.held) clearTimeout(this.held.timer);
    this.held = null;
    this.controller = v;
  }

  private viewerFor(ws: WebSocket): Viewer | null {
    for (const v of this.viewers) if (v.ws === ws) return v;
    return null;
  }

  private sendJson(v: Viewer, obj: Record<string, unknown>): void {
    if (v.ws.readyState === WebSocket.OPEN) v.ws.send(JSON.stringify(obj));
  }

  private roleOf(v: Viewer): Record<string, unknown> {
    return {
      role: v === this.controller ? "controller" : "observer",
      canControl: v.canControl,
      // Someone else holds the keyboard (or is about to reconnect to it).
      controlledElsewhere: (!!this.controller && this.controller !== v) || (!this.controller && !!this.held),
      viewers: this.viewers.size,
    };
  }

  private sendReady(v: Viewer, extra: Record<string, unknown>): void {
    const taken = !!v.viewId && v.viewId === this.takenFrom && v !== this.controller;
    if (taken) this.takenFrom = null;
    this.sendJson(v, {
      type: "ready",
      cols: this.cols,
      rows: this.rows,
      sessionName: this.sessionName,
      mode: this.mode.kind,
      // Older web builds read this flag alone: an observer is read-only to them.
      readOnly: v !== this.controller,
      stream: this.stream,
      ...this.roleOf(v),
      ...(taken ? { reason: "taken" } : {}),
      ...extra,
    });
  }

  private goLive(v: Viewer): void {
    this.everLive = true;
    v.live = true;
    v.sent = this.ring.offset;
    this.sendJson(v, { type: "replay_complete", offset: v.sent });
    this.broadcastRoles();
  }

  /** Tell every live viewer where it stands. `demoted` hears why. */
  private broadcastRoles(demoted?: Viewer): void {
    for (const v of this.viewers) {
      if (!v.live) continue;
      this.sendJson(v, { type: "role", ...this.roleOf(v), ...(v === demoted ? { reason: "taken" } : {}) });
    }
  }

  private broadcast(obj: Record<string, unknown>): void {
    for (const v of this.viewers) this.sendJson(v, obj);
  }

  /** Send ring records to one viewer, coalescing runs of output. */
  private sendRecords(v: Viewer, recs: RingRecord[]): void {
    let run: Buffer[] = [];
    const flush = () => {
      if (run.length) v.ws.send(run.length === 1 ? run[0]! : Buffer.concat(run));
      run = [];
    };
    for (const rec of recs) {
      if (v.ws.readyState !== WebSocket.OPEN) return;
      if (rec.kind === "output") {
        run.push(rec.data);
        continue;
      }
      flush();
      this.sendReseed(v, rec, rec.start + 1);
    }
    flush();
  }

  private sendReseed(v: Viewer, cap: PaneCapture, offset: number): void {
    // JSON first so the client resets + resizes before the seed bytes land;
    // the offset is where the viewer stands once it has them.
    this.sendJson(v, { type: "reseed", cols: cap.cols, rows: cap.rows, offset, seedBytes: cap.seed.length });
    if (cap.seed.length && v.ws.readyState === WebSocket.OPEN) v.ws.send(cap.seed);
  }

  private onOutput(data: Buffer): void {
    this.ring.appendOutput(data);
    this.deliver((v) => {
      v.ws.send(data);
    });
  }

  private onLayoutChange(): void {
    // An attach view is sized to the pane, so every viewer needs the new
    // geometry. A created shell's controller sized the pane itself; only
    // observers need repainting at its size.
    if (this.mode.kind === "create" && ![...this.viewers].some((v) => v !== this.controller)) {
      // Nobody else needs a repaint now, but output on either side of the
      // resize was drawn for different sizes: a view resuming from before
      // it gets a fresh screen instead of a replay across the two.
      this.ring.cut();
      return;
    }
    void this.client.capture((cap) => {
      this.cols = cap.cols;
      this.rows = cap.rows;
      const rec = this.ring.appendReseed(cap);
      this.deliver((v) => {
        // A shell's controller already has this geometry: repainting it on
        // its own resize would flicker every drag. It just steps past the
        // record, so a later resume does not replay it either.
        if (this.mode.kind === "create" && v === this.controller) this.sendJson(v, { type: "offset", offset: rec.start + 1 });
        else this.sendReseed(v, cap, rec.start + 1);
      });
    });
  }

  /** Hand the newest ring record to every live viewer keeping up. */
  private deliver(send: (v: Viewer) => void): void {
    for (const v of this.viewers) {
      if (!v.live || v.lagging || v.ws.readyState !== WebSocket.OPEN) continue;
      send(v);
      v.sent = this.ring.offset;
      if (v.ws.bufferedAmount > HIGH_WATER_BYTES) v.lagging = true;
    }
    this.balance();
  }

  /** Pause tmux only while every live viewer is behind; poll them back. */
  private balance(): void {
    const live = [...this.viewers].filter((v) => v.live);
    const anyLagging = live.some((v) => v.lagging);
    const allLagging = live.length > 0 && live.every((v) => v.lagging);
    if (allLagging && !this.paused) {
      this.paused = true;
      this.client.pauseOutput();
    } else if (!allLagging && this.paused) {
      this.paused = false;
      this.client.resumeOutput();
    }
    if (anyLagging && !this.drainTimer) {
      this.drainTimer = setInterval(() => this.drain(), DRAIN_POLL_MS);
      this.drainTimer.unref?.();
    } else if (!anyLagging && this.drainTimer) {
      clearInterval(this.drainTimer);
      this.drainTimer = null;
    }
  }

  private drain(): void {
    for (const v of this.viewers) {
      if (!v.lagging || v.ws.bufferedAmount >= HIGH_WATER_BYTES / 4) continue;
      const backlog = this.ring.since(v.sent);
      if (backlog) {
        v.lagging = false;
        this.sendRecords(v, backlog);
        v.sent = this.ring.offset;
        if (v.ws.bufferedAmount > HIGH_WATER_BYTES) v.lagging = true;
        continue;
      }
      // Fell out of the ring while behind: repaint it from a fresh capture.
      v.live = false;
      v.lagging = false;
      void this.client
        .capture((cap) => {
          if (!this.viewers.has(v)) return;
          this.sendReseed(v, cap, this.ring.offset);
          v.live = true;
          v.sent = this.ring.offset;
        })
        .then((ok) => {
          // No screen to give it: let it reconnect rather than sit frozen.
          if (!ok && this.viewers.has(v)) v.ws.close(4002, "lost its place");
        });
    }
    this.balance();
  }

  private leave(v: Viewer, deliberate: boolean): void {
    if (!this.viewers.has(v)) return;
    this.removeViewer(v, { keepSeat: false, hold: !deliberate });
    this.broadcastRoles();
    this.lingerIfIdle();
  }

  /** No viewers: keep the hub for a while, then let it go. Also for a hub
   *  whose only socket closed before it joined. */
  lingerIfIdle(): void {
    if (this.viewers.size === 0 && !this.disposed && !this.lingerTimer) {
      const linger = this.opts.lingerMs ?? HUB_LINGER_MS[this.mode.kind];
      this.lingerTimer = setTimeout(() => this.dispose("idle"), linger);
      this.lingerTimer.unref?.();
    }
  }

  private removeViewer(v: Viewer, { keepSeat, hold }: { keepSeat: boolean; hold: boolean }): void {
    this.viewers.delete(v);
    if (v !== this.controller) {
      this.balance();
      return;
    }
    this.controller = null;
    if (keepSeat) return;
    if (v.viewId && hold) {
      const viewId = v.viewId;
      const timer = setTimeout(() => {
        if (this.held?.viewId !== viewId) return;
        this.held = null;
        void this.fillSeat();
      }, this.opts.controlHoldMs ?? CONTROL_HOLD_MS);
      timer.unref?.();
      this.held = { viewId, timer };
    } else {
      void this.fillSeat();
    }
    this.balance();
  }

  /**
   * A free seat (no controller, none held) goes to the longest-standing view
   * that may hold it, so a terminal with someone able to type is never left
   * with nobody typing. With no such view, an attach hands the agent's pane
   * back its size.
   */
  private async fillSeat(): Promise<void> {
    if (this.controller || this.held || this.disposed) return;
    const next = [...this.viewers].find((v) => v.canControl);
    if (!next) {
      if (this.mode.kind === "attach") await this.client.setSizing(false);
      this.broadcastRoles();
      return;
    }
    this.seat(next);
    if (this.mode.kind === "attach") await this.client.setSizing(true);
    this.broadcastRoles();
  }

  private dispose(why: string, sync = false): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.lingerTimer) clearTimeout(this.lingerTimer);
    if (this.drainTimer) clearInterval(this.drainTimer);
    if (this.held) clearTimeout(this.held.timer);
    const back = this.client.restoresTo;
    this.opts.log(`[TERM] close ${this.sessionName} (${why}${back ? `, window back to ${back}` : ""})`);
    if (sync) this.client.closeSync();
    else this.client.close();
    for (const v of this.viewers) {
      try {
        if (sync) v.ws.terminate();
        else v.ws.close(1000);
      } catch {}
    }
    this.viewers.clear();
    this.opts.onDispose();
  }
}
