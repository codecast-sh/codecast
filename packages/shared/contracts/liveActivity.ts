// The Lock Screen Live Activity: one merged strip per phone that shows every
// live session's work state. The server folds a user's sessions into ONE
// content state and pushes it through APNs; the phone never coordinates.
//
// This file is the wire contract with installed widget builds. The Swift
// twin lives in packages/mobile/targets/widget/CodecastActivityAttributes.swift
// (and its copy in the native module), so the rules follow from the fact that
// the server is always talking to phones older than itself:
//   - adding an OPTIONAL field is safe; the widget ignores what it does not know.
//   - renaming, removing or changing the meaning of a field bumps the version
//     and keeps the old field populated until the old builds are gone.
//
// PURE isomorphic data — safe to import from the Convex runtime and the app.

import type { WorkState } from "./workState";

export const LIVE_ACTIVITY_SCHEMA_VERSION = 1;

// The ActivityAttributes type name ActivityKit matches a push-to-start
// payload against (`attributes-type`). Must equal the Swift struct's name.
export const LIVE_ACTIVITY_ATTRIBUTES_TYPE = "CodecastActivityAttributes";

// How many session rows ride the content state. The Lock Screen shows at most
// three in the list form; the rest fold into `overflow`. Content state must
// stay under APNs' 4KB payload cap, which this comfortably does.
export const LIVE_ACTIVITY_DISPLAYED_SESSIONS = 4;

// Hard clips for the APNs payload. The widget truncates visually well before.
export const LIVE_ACTIVITY_TITLE_LIMIT = 70;
export const LIVE_ACTIVITY_DETAIL_LIMIT = 90;

// A finished session lingers so the strip reads "just finished" before the
// row leaves; a failure stays longer because it is the one thing worth a look.
export const LIVE_ACTIVITY_DONE_LINGER_MS = 90_000;
export const LIVE_ACTIVITY_FAILED_LINGER_MS = 10 * 60_000;

// staleDate is always set so a dead server greys the strip out instead of
// lying; a live server refreshes well inside this window.
export const LIVE_ACTIVITY_STALE_MS = 15 * 60_000;

// Routine pushes coalesce to one per interval; a status change bypasses it.
// APNs throttles Live Activity updates, and the strip is glanced at, not read.
export const LIVE_ACTIVITY_PUSH_INTERVAL_MS = 15_000;

// After a push-to-start goes out the device must report the activity id and
// update token before updates can address it. Until then updates wait; past
// this grace a start is allowed again (the phone dedupes duplicate activities).
export const LIVE_ACTIVITY_START_GRACE_MS = 10_000;

// An ended activity stays on the Lock Screen this long ("All clear") before
// the system removes it.
export const LIVE_ACTIVITY_DISMISS_AFTER_MS = 60_000;

// Per-user sweep cadence while an activity runs: catches linger expiry and a
// heartbeat that stopped, which no write ever announces.
export const LIVE_ACTIVITY_SWEEP_INTERVAL_MS = 60_000;

export const LIVE_ACTIVITY_STATUSES = ["working", "waiting", "done", "failed"] as const;
export type LiveActivityStatus = (typeof LIVE_ACTIVITY_STATUSES)[number];

// Lock Screen order: whoever needs the human first.
const STATUS_PRIORITY: Record<LiveActivityStatus, number> = {
  waiting: 0,
  failed: 1,
  done: 2,
  working: 3,
};

// One session as the server sees it before derivation. `updatedAt` is when
// the status last CHANGED (not the last heartbeat), because the linger clocks
// and the "most recent first" order both key off the transition.
export interface LiveActivitySessionInput {
  id: string;
  title: string;
  detail?: string | null;
  agent: string;
  project?: string | null;
  status: LiveActivityStatus;
  startedAt: number;
  updatedAt: number;
}

// One session on the wire. Dates are ISO strings because ActivityKit decodes
// the content state with a plain Codable and ISO is what its date strategy
// reads; numbers would need a custom decoder in every widget build.
export interface LiveActivitySession {
  id: string;
  title: string;
  detail?: string;
  agent: string;
  project?: string;
  status: LiveActivityStatus;
  startedAt: string;
  updatedAt: string;
}

export interface LiveActivityContentState {
  version: number;
  headline: string;
  detail: string | null;
  status: LiveActivityStatus;
  live: number;
  waiting: number;
  overflow: number;
  sessions: LiveActivitySession[];
  updatedAt: string;
}

// Which strip status a work state reads as, or null when the session has no
// place on the Lock Screen (parked, blank, retired). A needs_input row whose
// block is a dead process or an error banner reads as failed: the human is
// not being asked anything, something broke.
export function liveActivityStatusOf(
  workState: WorkState,
  opts: { failed?: boolean } = {},
): LiveActivityStatus | null {
  switch (workState) {
    case "working":
      return "working";
    case "needs_input":
      return opts.failed ? "failed" : "waiting";
    case "done":
      return "done";
    default:
      return null;
  }
}

// A finished or failed row leaves once its linger has run out.
export function isLiveActivitySessionExpired(
  session: Pick<LiveActivitySessionInput, "status" | "updatedAt">,
  now: number,
): boolean {
  if (session.status === "done") return now - session.updatedAt >= LIVE_ACTIVITY_DONE_LINGER_MS;
  if (session.status === "failed") return now - session.updatedAt >= LIVE_ACTIVITY_FAILED_LINGER_MS;
  return false;
}

// When the next linger expiry lands, so the sweep can wake exactly then.
export function nextLiveActivityExpiry(
  sessions: Array<Pick<LiveActivitySessionInput, "status" | "updatedAt">>,
  now: number,
): number | null {
  let next: number | null = null;
  for (const s of sessions) {
    const at =
      s.status === "done"
        ? s.updatedAt + LIVE_ACTIVITY_DONE_LINGER_MS
        : s.status === "failed"
          ? s.updatedAt + LIVE_ACTIVITY_FAILED_LINGER_MS
          : null;
    if (at === null || at <= now) continue;
    if (next === null || at < next) next = at;
  }
  return next;
}

export function clipLiveActivityText(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= limit) return flat;
  return flat.slice(0, limit - 1).trimEnd() + "…";
}

function compareSessions(a: LiveActivitySessionInput, b: LiveActivitySessionInput): number {
  const byStatus = STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status];
  if (byStatus !== 0) return byStatus;
  // Working rows keep their place while agents report: oldest start first.
  if (a.status === "working") return a.startedAt - b.startedAt;
  // Everything else: the most recent transition on top.
  return b.updatedAt - a.updatedAt;
}

function resolveHeadline(ordered: LiveActivitySessionInput[], waiting: number, working: number, failed: number): string {
  if (ordered.length === 0) return "All clear";
  if (ordered.length === 1) return ordered[0].title;
  if (waiting > 0) return waiting === 1 ? "Waiting on you" : `${waiting} waiting on you`;
  if (failed > 0) return `${failed} failed`;
  if (working > 0) return `${working} ${working === 1 ? "agent" : "agents"} working`;
  return "Done";
}

function resolveDetail(ordered: LiveActivitySessionInput[]): string | null {
  if (ordered.length === 0) return null;
  if (ordered.length === 1) {
    return ordered[0].detail ? clipLiveActivityText(ordered[0].detail, LIVE_ACTIVITY_DETAIL_LIMIT) : null;
  }
  const leader = ordered[0];
  const text = leader.project ? `${leader.project} · ${leader.title}` : leader.title;
  return clipLiveActivityText(text, LIVE_ACTIVITY_DETAIL_LIMIT);
}

function serializeSession(s: LiveActivitySessionInput): LiveActivitySession {
  return {
    id: s.id,
    title: clipLiveActivityText(s.title, LIVE_ACTIVITY_TITLE_LIMIT),
    ...(s.detail ? { detail: clipLiveActivityText(s.detail, LIVE_ACTIVITY_DETAIL_LIMIT) } : {}),
    agent: s.agent,
    ...(s.project ? { project: s.project } : {}),
    status: s.status,
    startedAt: new Date(s.startedAt).toISOString(),
    updatedAt: new Date(s.updatedAt).toISOString(),
  };
}

// The merge. Expired rows are dropped first, so callers can hand in everything
// they know and let the clock decide.
export function deriveLiveActivityState(
  sessions: LiveActivitySessionInput[],
  now: number,
): LiveActivityContentState {
  const ordered = sessions
    .filter((s) => !isLiveActivitySessionExpired(s, now))
    .sort(compareSessions);
  const waiting = ordered.filter((s) => s.status === "waiting").length;
  const working = ordered.filter((s) => s.status === "working").length;
  const failed = ordered.filter((s) => s.status === "failed").length;
  const displayed = ordered.slice(0, LIVE_ACTIVITY_DISPLAYED_SESSIONS);
  return {
    version: LIVE_ACTIVITY_SCHEMA_VERSION,
    headline: clipLiveActivityText(resolveHeadline(ordered, waiting, working, failed), LIVE_ACTIVITY_TITLE_LIMIT),
    detail: resolveDetail(ordered),
    status: ordered[0]?.status ?? "done",
    live: waiting + working,
    waiting,
    overflow: ordered.length - displayed.length,
    sessions: displayed.map(serializeSession),
    updatedAt: new Date(now).toISOString(),
  };
}

// Nothing on the strip: the activity ends.
export function isLiveActivityQuiet(state: LiveActivityContentState): boolean {
  return state.sessions.length === 0;
}

// What a push is FOR. Everything but the clock: two states with the same key
// would render identically, so a push between them is wasted.
export function liveActivityStateKey(state: LiveActivityContentState): string {
  const { updatedAt: _u, ...rest } = state;
  return JSON.stringify({
    ...rest,
    sessions: rest.sessions.map(({ updatedAt: _su, ...s }) => s),
  });
}

// The per-session statuses, in wire order. A change here (a row entering,
// leaving or moving between statuses) is what makes a push urgent.
export function liveActivityStatusKey(state: LiveActivityContentState): string {
  return state.sessions.map((s) => `${s.id}:${s.status}`).join(",") + `|${state.overflow}`;
}
