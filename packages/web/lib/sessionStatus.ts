// One status vocabulary for every surface that lists sessions in the Modern
// style (the inbox rail and its cards, the fleet board, /sessions, /windows,
// the palette): nine states, each with one word, one colour and one mark.
//
// It reads the same facts the inbox already decides with, never a rule of its
// own. A surface that groups rows by status (the rail's sections, the board's
// bands) hands in the SECTION the row is drawn in, and the section decides the
// state, so the word on a card always agrees with the header above it. The
// row's own facts only refine inside a section: Needs you from Error in Needs
// You, Starting from Idle in New. A surface with no sections hands in the
// row's placement (store/inboxStore sessionPlacement, or the placements map of
// placeInboxRows), the same verdict the rail would file it under.
//
// Where the old surfaces disagreed (the inbox audit's INBOX-1), this settles it:
//   - A turn that ended with something for the person (an open question or
//     permission prompt, a pending `cast decide`, the agent's declared block,
//     or the settle classifier reading an ask in its last message) is Needs
//     you everywhere. The board used to call those FINISHED; it now bands by
//     the rail's placement.
//   - A failure that leaves it to the person (an API error banner, a crash, an
//     unresponsive or dead agent, a hosted turn that stopped) is Error, red,
//     not a yellow "needs you" and not an amber chip.
//   - Delivered work is Done, cyan; never yellow, never grey.
//   - Idle is grey and means nothing is happening and nothing is asked; the
//     board's yellow idle dot is gone.
//   - Parked on a wake (or a snooze) is Dormant, blue-grey.
//   - Process liveness (/sessions' "active / idle 2h+ / dead / hibernated") is
//     a different axis; it stays on that page as process facts, not a status.

import { DEAD_AGENT_STATUSES, deriveLiveAt, isExitAfterDone, personStateOf, rowLastTurnAllowsPark, type InboxBucket, type WorkState } from "@codecast/shared/contracts";
import { rowParkedWakeLive, rowPinPredatesTurn, rowWakeInputs } from "@codecast/shared/contracts/inboxPlacement";
import type { PlanState } from "@codecast/shared/tasks";
import { agentStatusAt, liveFactsOf } from "./liveness";
import { apiErrorBadge } from "./apiErrorBadge";
import { sessionStartupState } from "./sessionLifecycle";

export const SESSION_STATUSES = ["needs_you", "error", "working", "starting", "done", "dormant", "idle", "stashed", "killed"] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

/** The mark a state draws (components/inbox/SessionStatusMark): a shape, so the
 *  state reads without its colour. Every one is static. */
export type StatusMarkShape = "dot" | "ask" | "alert" | "dashed" | "check" | "moon" | "ring" | "aside" | "cross";

export type SessionStatusMeta = {
  word: string;
  /** Text colour class for the word and the mark (currentColor). */
  text: string;
  /** The same colour as a CSS value, for surfaces that paint inline. */
  color: string;
  mark: StatusMarkShape;
  /** What the word means, for its tooltip. */
  meaning: string;
};

// Blue-grey, from the two theme tokens it sits between.
const DORMANT_COLOR = "color-mix(in srgb, var(--sol-class-blue) 55%, var(--sol-text-dim))";

export const SESSION_STATUS: Record<SessionStatus, SessionStatusMeta> = {
  working: { word: "Working", text: "text-sol-green", color: "var(--sol-class-green)", mark: "dot", meaning: "The agent is running now" },
  needs_you: { word: "Needs you", text: "text-sol-yellow", color: "var(--sol-class-yellow)", mark: "ask", meaning: "The agent asked you something" },
  error: { word: "Error", text: "text-sol-red", color: "var(--sol-class-red)", mark: "alert", meaning: "It stopped on a failure you have to clear" },
  starting: { word: "Starting", text: "text-sol-green", color: "var(--sol-class-green)", mark: "dashed", meaning: "The agent is starting up" },
  done: { word: "Done", text: "text-sol-cyan", color: "var(--sol-class-cyan)", mark: "check", meaning: "Finished, waiting for you to review" },
  dormant: { word: "Sleeping", text: "text-[color:color-mix(in_srgb,var(--sol-class-blue)_55%,var(--sol-text-dim))]", color: DORMANT_COLOR, mark: "moon", meaning: "Asleep until something wakes it" },
  idle: { word: "Idle", text: "text-sol-text-dim", color: "var(--sol-text-dim)", mark: "ring", meaning: "Nothing running, nothing asked" },
  stashed: { word: "Stashed", text: "text-sol-text-dim", color: "var(--sol-text-dim)", mark: "aside", meaning: "Set aside; the agent may still run" },
  killed: { word: "Closed", text: "text-sol-text-dim", color: "var(--sol-text-dim)", mark: "cross", meaning: "Stopped and filed away" },
};

/** A plan's derived state (shared derivePlanState) in the session vocabulary:
 *  the mark its group header wears and the word beside it. */
export const PLAN_STATE_STATUS: Record<PlanState, { status: SessionStatus; word: string }> = {
  needs_you: { status: "needs_you", word: "Needs you" },
  moving: { status: "working", word: "Moving" },
  parked: { status: "dormant", word: "Parked" },
  finished: { status: "done", word: "Finished" },
  stalled: { status: "idle", word: "Stalled" },
  closed: { status: "idle", word: "Closed" },
};

/** Where a surface that groups by status draws a row: the inbox rail's
 *  sections (GlobalSessionPanel renderSection keys and hidden buckets) and the
 *  placement buckets they come from. */
export type StatusSection =
  | "questions" | "pinned" | "new" | "needs_input" | "hosted_stopped" | "done" | "working" | "dormant"
  | "snoozed" | "stashed" | "dismissed";

/** The states a row may wear in each section. The mapping never leaves these. */
export const SECTION_STATUSES: Record<StatusSection, readonly SessionStatus[]> = {
  questions: ["needs_you"],
  needs_input: ["needs_you", "error"],
  hosted_stopped: ["error"],
  working: ["working"],
  done: ["done"],
  dormant: ["dormant"],
  snoozed: ["dormant"],
  new: ["starting", "idle"],
  stashed: ["stashed"],
  dismissed: ["killed"],
  // A pinned row keeps its own verdict: pinned is where, not what.
  pinned: ["needs_you", "error", "working", "starting", "done", "dormant", "idle", "killed"],
};

/** The mark a rail section header carries: the state its rows wear. */
export const SECTION_HEADER_STATUS: Partial<Record<string, SessionStatus>> = {
  questions: "needs_you",
  needs_input: "needs_you",
  hosted_stopped: "error",
  working: "working",
  done: "done",
  dormant: "dormant",
  new: "starting",
};

/** The board's bands in Modern, in reading order: the rail's sections, so a
 *  tile and a card agree. Error rides with Needs you, as it does in the rail. */
export type StatusBand = "needs_you" | "working" | "done" | "dormant" | "idle";
export const STATUS_BANDS: readonly StatusBand[] = ["needs_you", "working", "done", "dormant", "idle"];
export function bandOfStatus(status: SessionStatus): StatusBand | null {
  if (status === "needs_you" || status === "error") return "needs_you";
  if (status === "working" || status === "starting") return "working";
  if (status === "stashed" || status === "killed") return null;
  return status;
}

/** The row fields the mapping reads. Every inbox row carries them. */
export type StatusRow = {
  message_count?: number | null;
  agent_status?: string | null;
  agent_type?: string | null;
  updated_at?: number;
  started_at?: number | null;
  last_heartbeat?: number | null;
  open_tasks?: unknown[] | null;
  open_tasks_at?: number | null;
  is_idle?: boolean | null;
  is_connected?: boolean | null;
  is_unresponsive?: boolean | null;
  awaiting_input?: boolean | null;
  has_pending?: boolean | null;
  session_error?: string | null;
  pending_api_error?: boolean | null;
  pending_api_error_kind?: string | null;
  thread_state_status?: string | null;
  thread_state_at?: number | null;
  /** When the latest turn opened: a pin older than it answered an earlier turn (rowPinPredatesTurn). */
  last_turn_at?: number | null;
  /** The pin rule's fallback with no last_turn_at, answered by the server (pinPredatesUserMessage). */
  pin_predates_user_message?: boolean | null;
  // The wake facts the shared pin rules read (rowWakeInputs).
  armed_trigger_kind?: string | null;
  parked_wake_kind?: string | null;
  // Whether the machine delivered the last turn (rowLastTurnAllowsPark): a park holds only then.
  last_turn_allows_park?: boolean | null;
  last_user_message?: string | null;
  producing_until?: number | null;
  loop_state?: Parameters<typeof rowWakeInputs>[0]["loop_state"];
  inbox_killed_at?: number | null;
  inbox_dismissed_at?: number | null;
  inbox_stashed_at?: number | null;
  inbox_snoozed_until?: number | null;
  /** The person's own filing (Needs You, Done, Dormant), current until the next activity. */
  user_rest?: string | null;
  // The owners model (shared personStateOf): a wait its agent owner answers reads working.
  owners_model?: boolean | null;
  org_role_id?: string | null;
  owner_session_id?: string | null;
  wait_up_count?: number | null;
  wait_up_person?: string | null;
  // The replicated facts the rail re-derives liveness from (lib/liveness liveFactsOf).
  status?: string | null;
  agent_status_updated_at?: number | null;
  daemon_alive_until?: number | null;
  last_role_is_user?: boolean | null;
  /** A kept new-session draft: a local stub nothing is starting. */
  _hasDraft?: boolean;
};

/** Facts a row does not carry, from the store around it. */
export type StatusLive = {
  /** A send the daemon has not confirmed: the person already acted. */
  pendingSend?: boolean;
  /** The API-error banner still shows (store showsBlockedBadge: the person has not acted on it). Defaults to the row's own flag. */
  blocked?: boolean;
  /** A hosted turn ended on a stop notice (lib/hostedNotice). */
  stopped?: boolean;
  /** A pending `cast decide` (or a hosted approval) waits on the person. */
  asking?: boolean;
};

/** A placement (store railRowPlacement / placedRailPlacement): its bucket and the work state it stamps. */
export type StatusPlacement = { bucket: string; state: WorkState };

const BUCKET_SECTION: Record<string, StatusSection | undefined> = {
  questions: "questions", new: "new", needs_input: "needs_input", done: "done", dormant: "dormant",
  working: "working", snoozed: "snoozed", stashed: "stashed", dismissed: "dismissed",
};

/** The section a placement bucket files under; null for the buckets that say
 *  where, not what (pinned, a hidden anchor, a blank or retired idle row). */
export function sectionOfBucket(bucket: string | null | undefined): StatusSection | null {
  return (bucket && BUCKET_SECTION[bucket]) || null;
}

const firstLine = (t: string) => (t.split("\n").find((l) => l.trim()) ?? "").trim();
const capitalize = (t: string) => (t ? t[0].toUpperCase() + t.slice(1) : t);

/** Why a settled row is Error rather than Needs you, in words, or null when
 *  nothing failed: the hard blocks the placement files under needs_input that
 *  are failures, not asks (isHardBlocked minus the asks). */
export function statusFailure(row: StatusRow, now: number, live: StatusLive = {}): { label: string; title?: string } | null {
  const blocked = live.blocked ?? !!row.pending_api_error;
  if (blocked && row.pending_api_error) {
    const badge = apiErrorBadge(row.pending_api_error_kind, row.agent_type);
    return badge ? { label: capitalize(badge.label), title: badge.title } : { label: "API error" };
  }
  if (row.session_error && row.pending_api_error_kind !== "safety") return { label: firstLine(row.session_error), title: row.session_error };
  // The rail re-derives unresponsiveness from the row's facts (deriveLiveAt);
  // the shipped flag says the same once the server has settled it.
  if (row.is_unresponsive || deriveLiveAt(liveFactsOf(row), now).is_unresponsive) return { label: "Unresponsive" };
  // An exit after the agent parked itself as dormant ended a turn, not the
  // work: a claimed wake the system cannot see is the person's move (Needs
  // you), not a failure to clear. A pin older than the latest turn (done or
  // dormant) answered an earlier turn, so it exempts nothing.
  const status = agentStatusAt(row, now);
  if (
    status && DEAD_AGENT_STATUSES.has(status) && (row.message_count ?? 0) > 0 &&
    (row.thread_state_status !== "dormant" || rowPinPredatesTurn(row)) &&
    !isExitAfterDone({ agentStatus: status, declaredStatus: row.thread_state_status ?? null, hasPending: !!row.has_pending, isUnresponsive: !!row.is_unresponsive, pinPredatesTurn: rowPinPredatesTurn(row) })
  ) return { label: "Agent stopped" };
  return null;
}

/** A blank session the agent is bringing up: running already, a first send in
 *  flight, or inside the start grace (lib/sessionLifecycle) with no
 *  connection yet. A hosted one is starting until its first reply. */
export function statusStarting(row: StatusRow, now: number, live: StatusLive = {}, hosted = false): boolean {
  if ((row.message_count ?? 0) > 0) return false;
  if (live.pendingSend) return true;
  if (row._hasDraft) return false;
  if (hosted) return true;
  const status = agentStatusAt(row, now);
  if (status && status !== "idle" && !DEAD_AGENT_STATUSES.has(status)) return true;
  return sessionStartupState({ isConnected: !!row.is_connected, ageMs: now - (row.started_at || row.updated_at || now) }) === "starting";
}

export type SessionStatusInput = {
  row: StatusRow;
  /** The section the row is drawn in, on a surface grouped by status. */
  section?: StatusSection | null;
  /** The row's placement, read when no section is given. */
  placement?: StatusPlacement | null;
  now: number;
  live?: StatusLive;
  /** A hosted agent (Whisk): no machine to connect. */
  hosted?: boolean;
};

/** The bucket a per-row placement files under once the facts it cannot see
 *  are read, the same overlays placeInboxRows applies: a send in flight
 *  (the person already acted), a pending ask, and the clock past a snooze
 *  (sessionPlacement reads time at the row's own last activity). */
function overlaidBucket(bucket: string, row: StatusRow, now: number, live: StatusLive): string {
  let b = bucket;
  if (b === "snoozed" && !(row.inbox_snoozed_until && row.inbox_snoozed_until > now)) b = "needs_input";
  if (live.asking && !row.inbox_killed_at && !row.user_rest && b !== "dismissed" && b !== "stashed" && b !== "snoozed") b = "questions";
  if (live.pendingSend && !(row.inbox_snoozed_until && row.inbox_snoozed_until > now) && (b === "needs_input" || b === "done" || b === "dormant" || b === "new")) b = "working";
  return b;
}

/** The one state a session shows. */
export function sessionStatusOf({ row, section, placement, now, live = {}, hosted = false }: SessionStatusInput): SessionStatus {
  const where = section ?? (placement ? sectionOfBucket(overlaidBucket(placement.bucket, row, now, live)) : null);
  switch (where) {
    case "dismissed": return "killed";
    case "stashed": return "stashed";
    case "snoozed": return "dormant";
    case "hosted_stopped": return "error";
    case "questions": return "needs_you";
    case "working": return "working";
    case "done": return "done";
    case "dormant": return "dormant";
    case "needs_input": return live.stopped || statusFailure(row, now, live) ? "error" : "needs_you";
    case "new": return statusStarting(row, now, live, hosted) ? "starting" : "idle";
  }
  // Pinned, an anchor, a list with no sections, a row the inbox does not
  // place: the row's own verdict, the work state the placement stamps.
  if (row.inbox_killed_at) return "killed";
  if (row.inbox_dismissed_at) return "killed";
  if (row.inbox_stashed_at) return "stashed";
  if (row.inbox_snoozed_until && row.inbox_snoozed_until > now) return "dormant";
  if (live.stopped) return "error";
  if (live.pendingSend) return "working";
  if (live.asking) return "needs_you";
  if ((row.message_count ?? 0) === 0) return statusStarting(row, now, live, hosted) ? "starting" : "idle";
  // As a person reads it, the same rule the sections file by (shared
  // personStateOf): a wait its agent owner answers is working, except in
  // Questions and where the person filed it themselves.
  const state = placement?.state ?? workStateOfRow(row, now);
  switch (personStateOf(row, (placement?.bucket ?? state) as InboxBucket, state)) {
    case "working": return "working";
    case "needs_input": return statusFailure(row, now, live) ? "error" : "needs_you";
    case "done": return "done";
    case "dormant": return "dormant";
    default: return "idle";
  }
}

/** A row with no placement at all (a process the inbox does not hold): what
 *  its live status says, the coarse fallback /sessions always used. It is not
 *  the full placement, which files every quiet settled row Needs You (this
 *  row may be a teammate's, so it reads idle). When the row carries the pin
 *  and wake facts (an inbox row: thread_state_status, parked_wake_kind and the
 *  rest, null when unset), it applies the shared classifier's pin and wake
 *  rules (rowWakeInputs) so it cannot keep a verdict the placement drops: a
 *  pin older than the latest turn says nothing, a fresh pin speaks over a
 *  decayed idle, a dormant claim with no verified wake expires to
 *  needs_input, and a pinned dormant with no live status (or a hibernated
 *  process) parks only on a verified wake. A row without them (the /sessions
 *  row for a foreign process: status, count and heartbeat only) cannot expire
 *  a claim, so a dormant or hibernated status stays dormant; a failure flag
 *  still wins over hibernated. */
function workStateOfRow(row: StatusRow, now: number): WorkState {
  const status = agentStatusAt(row, now);
  if (row.awaiting_input || status === "permission_blocked") return "needs_input";
  const failed = !!(row.pending_api_error || row.session_error || row.is_unresponsive);
  // A done rest under a live server-seen park (its ship run in CI) is dormant,
  // as classifyWorkState's doneRest files it.
  const parked = carriesWakeFacts(row) && rowParkedWakeLive({ ...row, updated_at: row.updated_at ?? 0 }, now) && rowLastTurnAllowsPark(row);
  if (status === "done") return parked ? "dormant" : "done";
  if (status === "waiting") return "dormant";
  if (!carriesWakeFacts(row)) {
    if (status === "hibernated" && failed) return "needs_input";
    if (status === "dormant" || status === "hibernated") return "dormant";
    if (status && status !== "idle" && !DEAD_AGENT_STATUSES.has(status)) return "working";
    return failed ? "needs_input" : "idle";
  }
  const wake = rowWakeInputs({ ...row, updated_at: row.updated_at ?? 0 }, { trusted: status, raw: row.agent_status }, now);
  const pin = wake.pinPredatesTurn ? null : row.thread_state_status;
  if (status === "dormant") return wake.dormantClaimExpired ? "needs_input" : "dormant";
  if (status && status !== "idle" && status !== "hibernated" && !DEAD_AGENT_STATUSES.has(status)) return "working";
  if (failed) return "needs_input";
  if (status === "idle" && !wake.pinSpeaks) return "idle";
  if (pin === "done") return parked ? "dormant" : "done";
  if (pin === "dormant") return wake.verifiedWake && !wake.dormantClaimExpired ? "dormant" : "idle";
  return "idle";
}

/** An inbox row spells an unset pin or wake fact as null; a row built from a
 *  bare process listing leaves them out. */
const carriesWakeFacts = (row: StatusRow): boolean =>
  row.thread_state_status !== undefined || row.parked_wake_kind !== undefined || row.armed_trigger_kind !== undefined || row.last_turn_at !== undefined;

/** The state of a row the palette lists (lib/instantSessionSearch
 *  SessionStanding: the inbox's placement when it holds the row, else its
 *  triage stamps), or null for a row this device holds no live facts for. */
export function statusOfStanding(
  standing: { state: WorkState | null; shelf: "stashed" | "snoozed" | "dismissed" | "killed" | null } | undefined,
  row: StatusRow,
  now: number,
): SessionStatus | null {
  if (!standing) return null;
  if (standing.shelf === "killed" || standing.shelf === "dismissed") return "killed";
  if (standing.shelf === "stashed") return "stashed";
  if (standing.shelf === "snoozed") return "dormant";
  switch (standing.state) {
    case "working": return "working";
    case "needs_input": return statusFailure(row, now) ? "error" : "needs_you";
    case "done": return "done";
    case "dormant": return "dormant";
    case "idle": return "idle";
    default: return null;
  }
}

/** The rail's renderSection key (and hidden-bucket variant) as a section. */
export function sectionOfRailKey(key: string | null | undefined): StatusSection | null {
  switch (key) {
    case "questions": case "new": case "needs_input": case "hosted_stopped": case "done": case "working": case "dormant":
    case "snoozed": case "stashed": case "dismissed":
      return key;
    default:
      return null;
  }
}
