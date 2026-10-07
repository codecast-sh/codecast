// One moment of a replay, as text (docs/architecture/external-data.md X5,
// "Playing a replay"): what `cast replay snap rp-N@1:23` prints beside the
// frame and `cast replay show rp-N --at 1:23` prints alone. The page's
// address then, its visible text outline, the last few things the person did,
// and the console and network around the moment.
//
// Times are on the replay clock: ms since the stream's first event, the clock
// the text timeline prints, the player shows and `rp-N@m:ss` names.
import { REPLAY_LIMITS, type ReplayEvent } from "../contracts/replay";
import { formatReplayTime, isFailedRequest, sortReplayEvents, urlPath } from "./events";
import { clip } from "../changes/headline";

export interface ReplayMoment {
  /** The asked time, held to the recording (replay clock, ms). */
  at_ms: number;
  duration_ms: number;
  url: string | null;
  title: string | null;
  /** The newest outline at or before the moment, and when it was taken (replay clock). */
  outline: string | null;
  outline_at_ms: number | null;
  /** The last few actions and navigations before the moment (no outlines, console or network), oldest first. */
  before: ReplayEvent[];
  /** Console lines and errors within the window around the moment. */
  console: ReplayEvent[];
  /** Requests the stream kept (failed or slow) within the window. */
  network: ReplayEvent[];
}

export interface ReplayMomentOptions {
  /** How many actions before the moment. */
  before?: number;
  /** How far either side of the moment console and network are read. */
  window_ms?: number;
}

const ACTIONS = new Set<ReplayEvent["type"]>(["nav", "click", "input", "submit", "key", "scroll", "mark"]);

/** The stream's clock zero: its first event's t. */
export function replayClockStart(events: readonly ReplayEvent[]): number {
  let min = Infinity;
  for (const e of events) if (e.t < min) min = e.t;
  return Number.isFinite(min) ? min : 0;
}

/** The recording's length on the replay clock. */
export function replayClockDuration(events: readonly ReplayEvent[]): number {
  let max = -Infinity;
  for (const e of events) if (e.t > max) max = e.t;
  return Number.isFinite(max) ? Math.max(0, max - replayClockStart(events)) : 0;
}

/** What the stream says about the moment `atMs` (replay clock). Events need not be sorted. */
export function replayMoment(input: readonly ReplayEvent[], atMs: number, opts: ReplayMomentOptions = {}): ReplayMoment {
  const events = sortReplayEvents(input);
  const start = replayClockStart(events);
  const duration = replayClockDuration(events);
  const at = Math.min(Math.max(0, atMs), duration);
  const raw = start + at;
  const win = opts.window_ms ?? 5_000;
  let nav: Extract<ReplayEvent, { type: "nav" }> | null = null;
  let view: Extract<ReplayEvent, { type: "view" }> | null = null;
  const before: ReplayEvent[] = [];
  for (const e of events) {
    if (e.t > raw) break;
    if (e.type === "nav") nav = e;
    if (e.type === "view") view = e;
    if (ACTIONS.has(e.type)) before.push(e);
  }
  // A moment before the first navigation is still on the page the recording opened on.
  if (!nav) nav = (events.find((e) => e.type === "nav") as Extract<ReplayEvent, { type: "nav" }> | undefined) ?? null;
  const near = (e: ReplayEvent) => Math.abs(e.t - raw) <= win;
  return {
    at_ms: at,
    duration_ms: duration,
    url: nav?.url ?? null,
    title: nav?.title ?? null,
    outline: view?.outline ?? null,
    outline_at_ms: view ? view.t - start : null,
    before: before.slice(-(opts.before ?? 8)),
    console: events.filter((e) => (e.type === "console" || e.type === "error") && near(e)),
    network: events.filter((e) => e.type === "network" && near(e)),
  };
}

const rel = (t: number, start: number) => formatReplayTime(t - start);

function eventLine(e: ReplayEvent, start: number): string {
  const at = rel(e.t, start);
  switch (e.type) {
    case "nav":
      return `${at} nav ${urlPath(e.url)}${e.title ? ` "${clip(e.title, 120)}"` : ""}`;
    case "click":
      return `${at} click ${e.role ? `${e.role} ` : ""}"${clip(e.label || "(unlabeled)", 120)}"`;
    case "input":
      return `${at} type into "${clip(e.label || "(unlabeled)", 120)}": ${e.length} chars`;
    case "submit":
      return `${at} submit "${clip(e.label || "(unlabeled)", 120)}"`;
    case "key":
      return `${at} key ${e.key}`;
    case "scroll":
      return `${at} scroll to ${Math.round(e.y)}${e.of ? ` of ${Math.round(e.of)}` : ""}`;
    case "console":
      return `${at} console.${e.level} ${clip(e.message, 300)}`;
    case "error":
      return `${at} ERROR ${clip(e.message, 300)}${e.stack ? `\n      ${clip(e.stack.split("\n").slice(1, 3).map((l) => l.trim()).join(" | "), 240)}` : ""}`;
    case "network":
      return `${at} ${isFailedRequest(e) ? "" : "slow "}${e.method} ${urlPath(e.url)} -> ${e.status || "failed"} (${Math.round(e.ms)} ms)`;
    case "view":
      return `${at} view`;
    case "mark":
      return `${at} mark ${e.name}`;
  }
}

/**
 * The moment as plain text. `start` is the stream's clock zero (replayClockStart):
 * every time printed is on the replay clock. `visible` is the text of the
 * rendered frame when there is one, which is what the page showed, and wins
 * over the stream's last outline.
 */
export function formatReplayMoment(m: ReplayMoment, start: number, opts: { visible?: string | null; frame_url?: string | null } = {}): string {
  const lines: string[] = [`at ${formatReplayTime(m.at_ms)} of ${formatReplayTime(m.duration_ms)}`];
  const url = opts.frame_url || m.url;
  if (url) lines.push(`url: ${url}${m.title ? `  "${clip(m.title, 120)}"` : ""}`);
  const outline = opts.visible?.trim() ? opts.visible.trim() : m.outline;
  if (outline) {
    const from = opts.visible?.trim() ? "visible text (rendered frame)" : `outline (taken at ${formatReplayTime(m.outline_at_ms ?? 0)})`;
    lines.push(`${from}:`, ...clip(outline, REPLAY_LIMITS.view_outline_max_chars).split("\n").map((l) => `  ${l}`));
  }
  lines.push(m.before.length ? "before:" : "before: nothing yet", ...m.before.map((e) => `  ${eventLine(e, start)}`));
  if (m.console.length) lines.push("console and errors nearby:", ...m.console.map((e) => `  ${eventLine(e, start)}`));
  if (m.network.length) lines.push("failed or slow requests nearby:", ...m.network.map((e) => `  ${eventLine(e, start)}`));
  return lines.join("\n");
}
