// The replay player and the DOM capture it plays (docs/architecture/external-data.md
// X5, "Playing a replay"). A replay's semantic stream (contracts/replay.ts) is
// what an agent reads as text; beside it a recording may keep its raw rrweb
// capture, the page itself, as "DOM chunks". One player renders that capture,
// and it never runs on codecast.sh's origin: customer DOM is untrusted markup,
// so the player is a page on its own origin (REPLAY_PLAYER_ORIGIN, the
// infra/replay-player worker), embedded by codecast in an iframe, and loading
// its events through a capability Convex mints for one replay. People use it
// interactively (the /ops replay page, an `rp-N@1:23` embed in markdown);
// agents get its frame mode, rendered server side by the same worker
// (`cast replay snap`), so a cloud host sees what a laptop sees.
//
// Every surface that builds a player URL, speaks to the player or asks for a
// frame imports this file: the Convex mint and manifest route, the worker and
// its page, the web embed and the CLI.

import { formatCallTime, parseCallTime, CALL_TIME_SOURCE } from "./callRecordings";

/** The origin the player is served from. Never codecast.sh itself. */
export const REPLAY_PLAYER_ORIGIN = "https://replay.codecast.sh";

/** The Convex origin the player page reads its manifest from. */
export const REPLAY_MANIFEST_ORIGIN = "https://convex.codecast.sh";

/** The manifest route a capability is exchanged at (GET ?cap=). */
export const REPLAY_PLAYER_MANIFEST_PATH = "/cli/replays/player";

/** The worker's frame route (POST ReplayFrameRequest, answers ReplayFrameResponse). */
export const REPLAY_FRAME_PATH = "/frame";

/**
 * Where the worker asks Convex to admit a frame request before it starts a
 * browser (POST { cap }): 204 when the capability opens and its budget has
 * room, 404 for a dead one, 429 with Retry-After past the budget. Nothing is
 * signed there, so a frame request costs Convex one query and two counters.
 */
export const REPLAY_FRAME_ADMIT_PATH = "/cli/replays/frame-admit";

/**
 * How long a capability opens its replay. Long enough to load the player and
 * render a batch of frames, short enough that a copied player URL is dead by
 * the time anyone else holds it. The page reads its events once, at load.
 */
export const REPLAY_CAP_TTL_MS = 10 * 60_000;

/** Limits on the DOM capture, apart from REPLAY_LIMITS (which the SDK copies and a drift test holds equal). */
export const REPLAY_DOM_LIMITS = {
  /** One gzipped DOM chunk. A full snapshot of a heavy page is a few MB of JSON; this holds one whole. */
  chunk_max_bytes: 8 * 1024 * 1024,
  /** Raw JSON packed into one chunk before gzip, so an import holds one chunk's text at a time. */
  chunk_target_raw_bytes: 6 * 1024 * 1024,
  /** What one DOM chunk may inflate to when read back. */
  chunk_max_inflated_bytes: 48 * 1024 * 1024,
  max_chunks_per_replay: 60,
} as const;

/** What the SDK sends on replay-sign to say which stream a chunk belongs to. Absent means "events". */
export const REPLAY_CHUNK_KINDS = ["events", "dom"] as const;
export type ReplayChunkKind = (typeof REPLAY_CHUNK_KINDS)[number];

/**
 * Why rrweb could not draw a capture, or null when it can. rrweb rebuilds a
 * page only from a full snapshot (type 2) that holds a serialized document;
 * anything else draws a blank frame, so the import keeps no such capture and
 * the player says this instead of showing white. A PostHog mobile recording
 * stored before the import converted its wireframes is the known case.
 */
export function replayCaptureProblem(events: readonly unknown[]): string | null {
  let snapshot = false;
  let wireframes = false;
  for (const e of events as readonly { type?: unknown; data?: any }[]) {
    if (e?.type !== 2) continue;
    snapshot = true;
    const node = e.data?.node;
    if (node && typeof node === "object" && node.type === 0 && Array.isArray(node.childNodes)) return null;
    if (Array.isArray(e.data?.wireframes)) wireframes = true;
  }
  if (!snapshot) return "This capture has no full snapshot of the page, so there is nothing to draw.";
  if (wireframes) return "This mobile recording was stored before its screens could be drawn. Reading the replay again (cast replay show, or its page) imports it in a form the player draws.";
  return "This recording is in a format the player cannot draw, so there is no frame to show. Its text timeline still reads.";
}

// ── The player URL ──────────────────────────────────────────────────────────

export const REPLAY_PLAYER_MODES = ["interactive", "frame"] as const;
export type ReplayPlayerMode = (typeof REPLAY_PLAYER_MODES)[number];

export interface ReplayPlayerParams {
  /** The capability Convex minted (replays.playerLink). */
  cap: string;
  /** Where to open, in ms of the replay's own clock (the semantic stream's `t`). */
  t_ms?: number | null;
  mode?: ReplayPlayerMode;
  /** Interactive only: false hides the player's own control bar, for a host that drives it over postMessage. */
  controls?: boolean;
  /** Interactive only: start playing at once. */
  autoplay?: boolean;
  /**
   * Interactive only: let the replayed page load the images, stylesheets and
   * fonts it names from their own hosts. Off unless the viewer asks for it on
   * this view: a recording uploaded with a source's public ingest key names
   * any URL it likes, and loading one tells that host the viewer's IP and
   * that they opened the replay. Frame mode never loads them.
   */
  remote_assets?: boolean;
}

/**
 * `<origin>/p/<cap>?t=<ms>&mode=frame&controls=0&autoplay=1&assets=remote`. The capability
 * rides the path so the page reads it without a query parser and so it never
 * reaches the replayed document as a referrer (the page sends no-referrer).
 */
export function replayPlayerUrl(p: ReplayPlayerParams, origin: string = REPLAY_PLAYER_ORIGIN): string {
  const q = new URLSearchParams();
  if (p.t_ms != null && Number.isFinite(p.t_ms)) q.set("t", String(Math.max(0, Math.round(p.t_ms))));
  if (p.mode === "frame") q.set("mode", "frame");
  if (p.controls === false) q.set("controls", "0");
  if (p.autoplay) q.set("autoplay", "1");
  if (p.remote_assets && p.mode !== "frame") q.set("assets", "remote");
  const qs = q.toString();
  return `${origin.replace(/\/$/, "")}/p/${encodeURIComponent(p.cap)}${qs ? `?${qs}` : ""}`;
}

/** The player URL's parts, or null for anything else. */
export function parseReplayPlayerUrl(href: string): ReplayPlayerParams | null {
  let u: URL;
  try {
    u = new URL(href, REPLAY_PLAYER_ORIGIN);
  } catch {
    return null;
  }
  const m = /^\/p\/([^/]+)\/?$/.exec(u.pathname);
  if (!m) return null;
  const t = u.searchParams.get("t");
  const tMs = t !== null && /^\d+$/.test(t) ? Number(t) : null;
  const mode: ReplayPlayerMode = u.searchParams.get("mode") === "frame" ? "frame" : "interactive";
  return {
    cap: decodeURIComponent(m[1]),
    t_ms: tMs,
    mode,
    controls: u.searchParams.get("controls") !== "0",
    autoplay: u.searchParams.get("autoplay") === "1",
    remote_assets: mode === "interactive" && u.searchParams.get("assets") === "remote",
  };
}

// ── What the manifest route answers ─────────────────────────────────────────

/** GET REPLAY_MANIFEST_ORIGIN + REPLAY_PLAYER_MANIFEST_PATH?cap=<cap>. 404 for a dead or forged capability. */
export interface ReplayPlayerManifest {
  replay: {
    short_id: string;
    provider: string;
    url: string | null;
    started_at: number;
    duration_ms: number | null;
  };
  /**
   * The epoch ms the replay's clock counts from: the semantic stream's t = 0.
   * The player maps an rrweb timestamp to replay time as `timestamp - t0`.
   */
  t0: number;
  /** DOM chunks, in order, each a GET signed for a few minutes (gzipped JSON arrays of rrweb events). Empty when there is no capture. */
  dom_urls: string[];
  /** When the capability lapses (epoch ms). */
  expires_at: number;
}

/** What replays.playerLink answers (web action, and /cli/replays/player-link for the CLI). */
export interface ReplayPlayerLink {
  short_id: string;
  /** False when the replay keeps no DOM capture: there is nothing to play, only the semantic stream. */
  has_dom: boolean;
  /** Null when has_dom is false. */
  cap: string | null;
  /** The player at `t_ms` in the asked mode, or null when has_dom is false. */
  player_url: string | null;
  /** Where frames are rendered (REPLAY_PLAYER_ORIGIN + REPLAY_FRAME_PATH). */
  frame_url: string;
  expires_at: number;
}

// ── postMessage between the player and the page embedding it ───────────────
//
// Every message is a plain object tagged with `source`, so either side can
// ignore everything else on the channel. Times are always replay time (ms,
// the semantic stream's clock), never rrweb offsets. The host checks
// event.origin === REPLAY_PLAYER_ORIGIN and event.source is its own iframe
// before trusting a message. The player obeys commands only from its parent
// window (any parent may embed it: whoever holds a capability can open the
// page anyway), and posts only to that parent's origin. It knows the origin
// from location.ancestorOrigins where the browser has it; elsewhere it holds
// its messages and posts a bare `hello` (no payload) until the parent sends
// any command, whose origin it then posts to. A host answers `hello` with
// `hello`.

export const REPLAY_PLAYER_SOURCE = "codecast-replay-player";
export const REPLAY_HOST_SOURCE = "codecast-replay-host";

/** Player to host. */
export type ReplayPlayerMessage =
  /** The player does not know its host's origin yet and holds every other message until a command arrives. Carries nothing. */
  | { source: typeof REPLAY_PLAYER_SOURCE; type: "hello" }
  /**
   * `duration_ms` is the replay's length on its clock (the row's duration).
   * `below_px` is what the player draws under the recorded page (its control
   * bar, the remote-assets strip): a host sizing the iframe to the page's
   * shape adds it. Absent from players older than the field.
   */
  | { source: typeof REPLAY_PLAYER_SOURCE; type: "ready"; duration_ms: number; width: number; height: number; t_ms: number; below_px?: number }
  /** Posted on every seek, and about four times a second while playing. */
  | { source: typeof REPLAY_PLAYER_SOURCE; type: "time"; t_ms: number; playing: boolean }
  | { source: typeof REPLAY_PLAYER_SOURCE; type: "state"; playing: boolean; speed: number }
  /** Frame mode: the page is drawn as it was at t_ms (images loaded or given up on). */
  | { source: typeof REPLAY_PLAYER_SOURCE; type: "frame"; t_ms: number; url: string | null; width: number; height: number }
  | { source: typeof REPLAY_PLAYER_SOURCE; type: "error"; message: string };

/** Host to player. */
export type ReplayHostMessage =
  /** The answer to the player's `hello`: it tells the player the host's origin and does nothing else. */
  | { source: typeof REPLAY_HOST_SOURCE; type: "hello" }
  | { source: typeof REPLAY_HOST_SOURCE; type: "seek"; t_ms: number; play?: boolean }
  | { source: typeof REPLAY_HOST_SOURCE; type: "play" }
  | { source: typeof REPLAY_HOST_SOURCE; type: "pause" }
  | { source: typeof REPLAY_HOST_SOURCE; type: "speed"; speed: number };

export const REPLAY_PLAYER_SPEEDS = [0.5, 1, 2, 4, 8] as const;

const isObj = (d: unknown): d is Record<string, unknown> => !!d && typeof d === "object";

export function isReplayPlayerMessage(d: unknown): d is ReplayPlayerMessage {
  return isObj(d) && d.source === REPLAY_PLAYER_SOURCE && typeof d.type === "string";
}

/** A host message, checked field by field (the player reads it from whatever page embeds it). */
export function parseReplayHostMessage(d: unknown): ReplayHostMessage | null {
  if (!isObj(d) || d.source !== REPLAY_HOST_SOURCE) return null;
  if (d.type === "seek" && typeof d.t_ms === "number" && Number.isFinite(d.t_ms)) {
    return { source: REPLAY_HOST_SOURCE, type: "seek", t_ms: Math.max(0, d.t_ms), ...(d.play === true ? { play: true } : {}) };
  }
  if (d.type === "play" || d.type === "pause" || d.type === "hello") return { source: REPLAY_HOST_SOURCE, type: d.type };
  if (d.type === "speed" && typeof d.speed === "number" && (REPLAY_PLAYER_SPEEDS as readonly number[]).includes(d.speed)) {
    return { source: REPLAY_HOST_SOURCE, type: "speed", speed: d.speed };
  }
  return null;
}

// ── Frames (the worker's POST /frame) ───────────────────────────────────────

export const REPLAY_FRAME_LIMITS = {
  /** Frames one request renders, in one browser session. */
  max_frames_per_request: 12,
  /** Frames one `cast replay snap` takes across a range. */
  max_frames: 50,
  /** The visible text of a rendered frame, as returned. */
  outline_max_chars: 4 * 1024,
  /** The widest frame rendered; a wider recording is scaled down to it. */
  max_width: 1600,
  max_height: 1600,
  /** How long a frame waits for the replayed page's images and fonts. */
  settle_ms: 4_000,
  /**
   * Frame requests (each a browser session) one capability may make in its
   * lifetime: a 50 frame snap is 5, so this leaves room for its retries.
   */
  requests_per_cap: 8,
  /** Frame requests one person may make per window, across every capability they mint. */
  requests_per_person: 30,
  budget_window_ms: REPLAY_CAP_TTL_MS,
} as const;

export interface ReplayFrameRequest {
  cap: string;
  /** Replay times to render, ascending. */
  times_ms: number[];
}

export interface ReplayFrame {
  t_ms: number;
  /** PNG, base64. Absent when this time could not be drawn (then `error` says why). */
  png_base64?: string;
  /** The page's address at t (from the capture's own meta events). */
  url: string | null;
  /** The visible text of the drawn page, at most outline_max_chars. */
  outline: string;
  width: number;
  height: number;
  error?: string;
}

export interface ReplayFrameResponse {
  frames: ReplayFrame[];
}

// ── References: rp-12, rp-12@1:23, rp-12@1:00-2:30 ──────────────────────────
//
// A replay is quoted by its short id; a MOMENT of it is the replay plus a
// time on its own clock, written the way a call moment is (`cl-42@12:34`):
// `rp-12@1:23`, `rp-12@83s`. A stretch, for frames across it, is two times:
// `rp-12@1:00-2:30`. The clock is the replay's (ms since its first event),
// the same one the semantic timeline prints and the player shows.

/** A moment of a replay, as prose writes it. */
export const REPLAY_MOMENT_REF_SOURCE = `rp-\\d+@(?:${CALL_TIME_SOURCE})`;

export interface ReplayRef {
  replay: string;
  /** A moment: ms into the replay. */
  at_ms?: number;
  /** A stretch: both ends, ms into the replay. */
  range?: { from_ms: number; to_ms: number };
}

/** A replay reference split into the replay and its moment or stretch, or null. */
export function parseReplayRef(text: string | null | undefined): ReplayRef | null {
  const s = (text || "").trim();
  const m = /^(rp-\d+)(?:@([^-\s]+)(?:-([^-\s]+))?)?$/i.exec(s);
  if (!m) return null;
  const replay = m[1].toLowerCase();
  if (!m[2]) return { replay };
  const a = parseCallTime(m[2]);
  if (a === null) return null;
  if (!m[3]) return { replay, at_ms: a };
  const b = parseCallTime(m[3]);
  if (b === null) return null;
  return { replay, range: { from_ms: Math.min(a, b), to_ms: Math.max(a, b) } };
}

/** The prose form: `rp-12`, `rp-12@1:23`. Whole seconds, rounded down, like every player clock. */
export function replayRefId(replay: string, atMs?: number | null): string {
  return atMs == null ? replay : `${replay}@${formatCallTime(atMs)}`;
}

/**
 * The words a frame an agent looked at becomes before its transcript syncs
 * (the CLI's callFrameRefs): a frame of a customer's page is as private as
 * the replay, so the picture never reaches a session row, only this line,
 * which a reader renders under the replay's own access rule.
 */
export function replayFrameSeenText(ref: string): string {
  return `Frame of the replay: ${ref}`;
}

/** The moment a tool result's text says the agent looked at, or null. */
export function replayFrameSeenRef(text: string | null | undefined): string | null {
  const m = /(?:^|\n)Frame of the replay: (rp-\d+@[0-9:]+s?)[ \t]*(?:\n|$)/.exec(text ?? "");
  return m ? m[1] : null;
}

/** The times a stretch is sampled at: every `everyMs` from its start, its end included, at most `max`. */
export function replayFrameTimes(range: { from_ms: number; to_ms: number }, everyMs: number, max: number = REPLAY_FRAME_LIMITS.max_frames): number[] {
  const step = Math.max(1000, everyMs);
  const out: number[] = [];
  for (let t = range.from_ms; t <= range.to_ms && out.length < max; t += step) out.push(t);
  if (out[out.length - 1] !== range.to_ms && out.length < max) out.push(range.to_ms);
  return out;
}
