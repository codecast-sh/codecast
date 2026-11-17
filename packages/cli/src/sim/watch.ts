/**
 * The simulator a session holds, as a watch engine: the same socket, relay
 * and viewer the agent's browser tab uses (browser/watchServer.ts), with the
 * device's screen for frames and a person's touches for input.
 *
 * Which device: the pool lock names the session that took it (sim/pool.ts),
 * and the viewer's hello names the session it is looking at, so the lookup is
 * one read of the lock files and never asks the simulator anything. A session
 * that releases its device, or takes another, is followed by the watch
 * session's owner poll like a browser tab that closed or moved.
 *
 * Input arrives in the browser watch's shape, a pointer at 0..1 of the frame,
 * and leaves as helper commands in points (sim/simstream.m): a press is a
 * finger down, a drag moves it, a release lifts it, so a swipe is live rather
 * than replayed. A trackpad scroll is a finger too: it lands where the pointer
 * is and moves against the wheel, which is how a scroll view expects to be
 * scrolled. Keys go as HID key codes, text as one key per character.
 *
 * The agent's own taps happen in another process (`cast sim tap`), so its
 * verbs leave their last action beside the lock (sim/activity.ts), and this
 * turns it into the watch protocol's action messages: the viewer draws the
 * agent's finger the way it draws its browser cursor.
 */

import type { FrameSource, FrameSourceHandlers, FrameSourceOptions, WatchAction, WatchEngine, WatchInput } from "../browser/watchSource.js";
import { WatchOpenError } from "../browser/watchSource.js";
import { heldBySession, readPool } from "./pool.js";
import { readSimAction, type SimAction } from "./activity.js";
import { startSimStream, type SimScreen, type SimStream, type SimStreamHandlers, type SimStreamOptions } from "./simstream.js";
import { deviceState, hasSimctl } from "./simctl.js";

/** The session uuids among a hello's owner keys (watchServer ownerCandidates). */
export function sessionsOf(candidates: string[]): string[] {
  const out: string[] = [];
  for (const key of candidates) {
    const m = /^(?:session|env):(.+)$/.exec(key);
    if (m && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/** HID usage codes for the keys the viewer forwards by name. */
const NAMED_KEYS: Record<string, number> = {
  Enter: 40, Escape: 41, Backspace: 42, Tab: 43, Delete: 76,
  ArrowRight: 79, ArrowLeft: 80, ArrowDown: 81, ArrowUp: 82,
  Home: 74, PageUp: 75, End: 77, PageDown: 78,
};

const SHIFT = 225;
const UNSHIFTED = "abcdefghijklmnopqrstuvwxyz1234567890";
const PUNCT: Record<string, [number, boolean]> = {
  " ": [44, false], "-": [45, false], "_": [45, true], "=": [46, false], "+": [46, true],
  "[": [47, false], "{": [47, true], "]": [48, false], "}": [48, true], "\\": [49, false], "|": [49, true],
  ";": [51, false], ":": [51, true], "'": [52, false], "\"": [52, true], "`": [53, false], "~": [53, true],
  ",": [54, false], "<": [54, true], ".": [55, false], ">": [55, true], "/": [56, false], "?": [56, true],
  "!": [30, true], "@": [31, true], "#": [32, true], "$": [33, true], "%": [34, true],
  "^": [35, true], "&": [36, true], "*": [37, true], "(": [38, true], ")": [39, true],
  "\n": [40, false], "\t": [43, false],
};

/** One character as a HID key and whether it needs shift; null for what a US keyboard cannot type. */
export function hidForChar(ch: string): [number, boolean] | null {
  const lower = ch.toLowerCase();
  const i = UNSHIFTED.indexOf(lower);
  if (i >= 0 && ch.length === 1) {
    // a-z are 4..29, 1-9 are 30..38, 0 is 39.
    const code = i < 26 ? 4 + i : i < 35 ? 30 + (i - 26) : 39;
    return [code, ch !== lower];
  }
  return PUNCT[ch] ?? null;
}

/** The helper lines that type `text`, one key at a time. */
export function typeLines(text: string): string[] {
  const out: string[] = [];
  for (const ch of text) {
    const k = hidForChar(ch);
    if (!k) continue;
    if (k[1]) out.push(`keydown ${SHIFT}`, `key ${k[0]}`, `keyup ${SHIFT}`);
    else out.push(`key ${k[0]}`);
  }
  return out;
}

const fmt = (n: number) => String(Math.round(n * 10) / 10);

/** How long a pause ends a trackpad scroll and lifts its finger. */
const WHEEL_SETTLE_MS = 140;

/**
 * Viewer input to helper commands. Stateful: it knows whether a finger is
 * down and where the scrolling finger is. Pure apart from the clock, so the
 * gestures are testable without a simulator.
 */
export class SimInputMapper {
  private pressed = false;
  private wheel: { x: number; y: number; startX: number; startY: number } | null = null;
  private wheelTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly send: (line: string) => void,
    private readonly screenPoints: () => { width: number; height: number } | null,
    private readonly timers: { set: typeof setTimeout; clear: typeof clearTimeout } = { set: setTimeout, clear: clearTimeout },
  ) {}

  input(ev: WatchInput): void {
    const size = this.screenPoints();
    switch (ev.kind) {
      case "mouse": {
        if (!size || ev.button === "right" || ev.button === "middle") return;
        const x = clamp01(ev.nx) * size.width;
        const y = clamp01(ev.ny) * size.height;
        if (ev.type === "mousePressed") {
          this.endWheel();
          this.pressed = true;
          this.send(`down ${fmt(x)} ${fmt(y)}`);
        } else if (ev.type === "mouseMoved") {
          if (this.pressed) this.send(`down ${fmt(x)} ${fmt(y)}`);
        } else if (ev.type === "mouseReleased") {
          if (!this.pressed) return;
          this.pressed = false;
          this.send(`up ${fmt(x)} ${fmt(y)}`);
        } else if (ev.type === "mouseWheel") {
          if (this.pressed) return;
          this.scroll(x, y, ev.deltaX ?? 0, ev.deltaY ?? 0, size);
        }
        return;
      }
      case "key": {
        if (ev.type !== "keyDown") return;
        const code = NAMED_KEYS[ev.key];
        if (code) this.send(`key ${code}`);
        else if (ev.key.length === 1) for (const l of typeLines(ev.key)) this.send(l);
        return;
      }
      case "insertText":
        for (const l of typeLines(ev.text)) this.send(l);
        return;
      case "button":
        this.endWheel();
        this.send(`button ${ev.button}`);
        return;
    }
  }

  /** A finger that follows the wheel: down where the pointer is, moved against the delta. */
  private scroll(x: number, y: number, dx: number, dy: number, size: { width: number; height: number }): void {
    if (!this.wheel) {
      this.wheel = { x, y, startX: x, startY: y };
      this.send(`down ${fmt(x)} ${fmt(y)}`);
    }
    const w = this.wheel;
    w.x -= dx;
    w.y -= dy;
    // Off the glass the finger lifts and lands again where it started, so a
    // long scroll keeps going instead of stopping at the screen's edge.
    const margin = 8;
    if (w.x < margin || w.x > size.width - margin || w.y < margin || w.y > size.height - margin) {
      const ex = Math.min(size.width - margin, Math.max(margin, w.x));
      const ey = Math.min(size.height - margin, Math.max(margin, w.y));
      this.send(`up ${fmt(ex)} ${fmt(ey)}`);
      w.x = w.startX;
      w.y = w.startY;
      this.send(`down ${fmt(w.x)} ${fmt(w.y)}`);
    } else {
      this.send(`down ${fmt(w.x)} ${fmt(w.y)}`);
    }
    if (this.wheelTimer) this.timers.clear(this.wheelTimer);
    this.wheelTimer = this.timers.set(() => this.endWheel(), WHEEL_SETTLE_MS);
  }

  endWheel(): void {
    if (this.wheelTimer) this.timers.clear(this.wheelTimer);
    this.wheelTimer = null;
    if (!this.wheel) return;
    this.send(`up ${fmt(this.wheel.x)} ${fmt(this.wheel.y)}`);
    this.wheel = null;
  }

  /** Lift whatever is down: the viewer left mid gesture. */
  release(): void {
    this.endWheel();
    this.pressed = false;
  }
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

/** An agent action as the watch protocol's action messages, in 0..1 of the screen. */
export function actionsFor(a: SimAction, size: { width: number; height: number }, last: { x: number; y: number }): WatchAction[] {
  const n = (x: number, y: number) => ({ x: clamp01(x / size.width), y: clamp01(y / size.height) });
  const msg = (kind: WatchAction["kind"], p: { x: number; y: number }, extra: Partial<WatchAction> = {}): WatchAction => ({ type: "action", kind, ...p, at: a.at, ...extra });
  switch (a.kind) {
    case "tap": {
      const p = n(a.x, a.y);
      return [msg("move", p), msg("down", p), msg("up", p)];
    }
    case "swipe": {
      const from = n(a.x, a.y);
      const to = n(a.x2, a.y2);
      return [msg("move", from), msg("down", from), msg("move", to), msg("up", to)];
    }
    case "type":
      return [msg("type", last, { text: a.text })];
    case "button":
      return [];
  }
}

export interface SimEngineDeps {
  /** The device a session holds: udid and name. Called on every owner poll, so cheap. */
  held(sessions: string[]): { udid: string; name: string } | null;
  /** Whether the machine can run simulators at all. */
  available(): boolean;
  booted(udid: string): boolean;
  start(udid: string, opts: SimStreamOptions, handlers: SimStreamHandlers): Promise<SimStream>;
  readAction(udid: string): SimAction | null;
  now(): number;
}

const realDeps: SimEngineDeps = {
  held(sessions) {
    const e = heldBySession(sessions);
    return e ? { udid: e.udid, name: e.name } : null;
  },
  available: () => hasSimctl() && readPool().length > 0,
  booted: (udid) => deviceState(udid) === "Booted",
  start: (udid, opts, handlers) => startSimStream(udid, opts, handlers),
  readAction: readSimAction,
  now: () => Date.now(),
};

/** How often the agent's last action is checked while someone watches. */
const ACTION_POLL_MS = 250;
/** The helper's own ceiling; the viewer's interval only lowers it. */
const MAX_FPS = 15;

export function simWatchEngine(deps: SimEngineDeps = realDeps): WatchEngine {
  let availableCache: { at: number; value: boolean } | null = null;
  const available = () => {
    const now = deps.now();
    if (!availableCache || now - availableCache.at > 60_000) availableCache = { at: now, value: deps.available() };
    return availableCache.value;
  };

  return {
    resolveTab(candidates) {
      const held = deps.held(sessionsOf(candidates));
      if (held) return { tabId: held.udid };
      return { error: available() ? "no-sim" : "no-simulators" };
    },

    async open(udid: string, opts: FrameSourceOptions, handlers: FrameSourceHandlers): Promise<FrameSource> {
      if (!deps.booted(udid)) throw new WatchOpenError("sim-not-booted", "the session's simulator is not booted");
      let screen: SimScreen | null = null;
      let stopped = false;

      // Trailing throttle: frames only come when the screen changed, so a
      // frame held back (a slow viewer, the interval) must still go out once
      // things settle, or the view freezes one step behind the device.
      let pending: { data: string; width: number; height: number } | null = null;
      let lastSentAt = 0;
      let flushTimer: ReturnType<typeof setTimeout> | null = null;
      const flush = () => {
        flushTimer = null;
        if (stopped || !pending) return;
        const wait = Math.max(0, opts.minIntervalMs - (deps.now() - lastSentAt));
        if (wait > 0 || opts.shouldHold()) {
          flushTimer = setTimeout(flush, Math.max(wait, 50));
          return;
        }
        const f = pending;
        pending = null;
        lastSentAt = deps.now();
        handlers.onFrame(f);
      };

      const fps = Math.max(1, Math.min(MAX_FPS, Math.round(1000 / Math.max(1, opts.minIntervalMs))));
      const stream = await deps.start(udid, { fps, quality: opts.quality / 100, maxDim: Math.max(opts.maxWidth, opts.maxHeight) }, {
        onFrame(f) {
          pending = f;
          if (!flushTimer) flush();
        },
        onScreen(s) {
          screen = s;
        },
        onExit() {
          if (stopped) return;
          cleanup();
          handlers.onGone();
        },
      });
      if (opts.signal.aborted) {
        stream.stop();
        throw new WatchOpenError("no-sim", "the viewer left");
      }

      const points = () => (screen ? { width: screen.widthPx / screen.scale, height: screen.heightPx / screen.scale } : null);
      const mapper = new SimInputMapper((line) => stream.send(line), points);

      // The agent's hand. The first read only learns where things stand: an
      // action older than the stream is replayed by the watch session's own
      // memory, not re-announced here.
      let lastActionAt = deps.readAction(udid)?.at ?? 0;
      let cursor = { x: 0.5, y: 0.5 };
      const actionTimer = setInterval(() => {
        const a = deps.readAction(udid);
        const size = points();
        if (!a || a.at <= lastActionAt || !size) return;
        lastActionAt = a.at;
        stream.wake();
        for (const msg of actionsFor(a, size, cursor)) {
          cursor = { x: msg.x, y: msg.y };
          handlers.onAction?.(msg);
        }
      }, ACTION_POLL_MS);
      actionTimer.unref?.();

      const name = (() => {
        try {
          return readPool().find((d) => d.udid === udid)?.name ?? "iOS Simulator";
        } catch {
          return "iOS Simulator";
        }
      })();

      function cleanup() {
        if (stopped) return;
        stopped = true;
        clearInterval(actionTimer);
        if (flushTimer) clearTimeout(flushTimer);
        mapper.release();
        stream.stop();
      }

      return {
        tab: { id: udid, title: name, url: "" },
        ...(stream.interactive
          ? {
              input(ev: WatchInput) {
                if (!stopped) mapper.input(ev);
              },
            }
          : {}),
        stop: cleanup,
      };
    },
  };
}
