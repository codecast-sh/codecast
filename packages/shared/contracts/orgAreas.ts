// An area as a person reads it (docs/architecture/org-staffing.md S29): one
// role looking after one part of the company, said in a status word, the
// role's own latest line on where it stands, and at most three signals that
// change what a person would do. org.health derives it on the server from the
// same measures the flags read, so the panel, `cast org health`, the Head of
// People's review and the area watch all speak from one reading.
//
// Pure: no reads, no clock. The server hands it the counts it already holds.
import type { InitiativeLink, InitiativeRow, MetricReading } from "./initiative";

export const AREA_STATUSES = ["waiting_on_you", "stuck", "overloaded", "quiet", "on_track", "paused", "not_started"] as const;
export type AreaStatus = (typeof AREA_STATUSES)[number];

/** The status as one or two words a person reads. */
export const AREA_STATUS_WORDS: Record<AreaStatus, string> = {
  waiting_on_you: "waiting on you",
  stuck: "stuck",
  overloaded: "overloaded",
  quiet: "quiet",
  on_track: "on track",
  paused: "paused",
  not_started: "not started",
};

/** Whether a status asks a person for anything; the panel sorts nothing by
 *  it, the watch fires on the two that last. */
export const AREA_STATUS_ATTENTION: Record<AreaStatus, "person" | "head" | "none"> = {
  waiting_on_you: "person",
  stuck: "head",
  overloaded: "head",
  quiet: "none",
  on_track: "none",
  paused: "none",
  not_started: "none",
};

export type AreaSignalCode = "waiting_sessions" | "review_stall" | "blocked_sessions" | "overloaded" | "idle" | "program_ended" | "raised";

/** One sentence that changes what a person would do about the area. */
export type AreaSignal = { code: AreaSignalCode; text: string; severity: "info" | "warn" | "blocker" };

export type AreaWaitingSession = {
  id: string;
  short_id: string;
  title: string;
  /** Why it waits, in the needs-input vocabulary ("blocked", "decision", "waiting"). */
  why: string;
  since: number;
  /** The first line of its pinned state, when it pinned one. */
  state: string | null;
};

export type AreaGoal = {
  project: { id: string; title: string; short_id: string | null };
  goal: string | null;
  open: number;
  in_progress: number;
  done_7d: number;
};

/** An initiative the area feeds (initiatives-projects-role-page.md I4): the
 *  goal, each metric read against its target, and the chain up to the top
 *  level goal. `owned` when the role drives it rather than carrying one of
 *  its projects. On track here means against the target, beside the owner's word. */
export type AreaInitiative = {
  id: string;
  short_id: string;
  title: string;
  status: InitiativeRow["status"];
  health: InitiativeRow["health"];
  owned: boolean;
  metrics: MetricReading[];
  chain: InitiativeLink[];
};

/** A role's dated line from its brief (briefStanding.StandingLine, minus the raw). */
export type AreaStandingLine = { project: string; text: string; written_on: string | null; written_at: number | null };

/** The role's check as a person controls it: the routine trigger on its
 *  standing session, in whatever status it stands. */
export type AreaCheck = {
  trigger_id: string;
  short_id: string | null;
  title: string;
  status: string;
  run_at: number | null;
  last_run_at: number | null;
  last_run_summary: string | null;
  interval_ms: number | null;
};

export type RoleArea = {
  status: AreaStatus;
  /** The status in a sentence, for a row with nothing else to say. */
  status_line: string;
  signals: AreaSignal[];
  /** The newest dated line the role wrote under "Where it stands", or null. */
  standing: AreaStandingLine | null;
  /** Every line, newest first, capped. The Head of People's read of the company is these. */
  standing_lines: AreaStandingLine[];
  waiting: AreaWaitingSession[];
  goals: AreaGoal[];
  /** What the area feeds, owned goals first; absent on rows from before the field. */
  initiatives?: AreaInitiative[];
  /** When the role last read its brief from its own session. */
  checked_at: number | null;
  check: AreaCheck | null;
  standing_conversation_id: string | null;
  standing_short_id: string | null;
};

export type AreaInput = {
  role_status: "active" | "paused" | "retired";
  has_standing: boolean;
  /** The standing session has declared it waits on a person, or is asking one. */
  standing_waits_on_person: boolean;
  /** What it pinned when it did, first line. */
  standing_state_line: string | null;
  /** Sessions under the role waiting on someone, past the window the role
   *  should have answered inside (orgCapacity session_wait_hours). */
  waiting_unanswered: number;
  /** Sessions under the role waiting at all, whatever their age. */
  waiting_total: number;
  /** Tasks in the area sitting in review past the stall window. */
  review_stalls: number;
  /** Open tasks in the area whose session reported blocked or needing context. */
  blocked_sessions: number;
  /** More reached the seat this week than one role answers (orgCapacity.isOverloaded). */
  overloaded: boolean;
  /** The phrases behind `overloaded`, plain: "6 decisions a day". */
  overloaded_by: string[];
  /** Days since anything moved in the area; null when nothing ever did. */
  idle_days: number | null;
  age_days: number;
  idle: boolean;
  program_ended: { ended: string; then: "retire" | "review" } | null;
};

const n = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** The status the signals add up to, most pressing first. */
export function areaStatusOf(a: AreaInput): AreaStatus {
  if (a.role_status === "paused") return "paused";
  if (!a.has_standing) return "not_started";
  if (a.standing_waits_on_person) return "waiting_on_you";
  if (a.waiting_unanswered > 0 || a.review_stalls > 0 || a.blocked_sessions > 0) return "stuck";
  if (a.overloaded) return "overloaded";
  if (a.idle) return "quiet";
  return "on_track";
}

/** The status as one sentence a row can stand on. */
export function areaStatusLine(a: AreaInput, status: AreaStatus): string {
  switch (status) {
    case "paused": return "Paused: its checks hold until you resume it.";
    case "not_started": return "Not started: it has no session yet.";
    case "waiting_on_you": return a.standing_state_line ? `Waiting on you: ${a.standing_state_line}` : "Waiting on you.";
    case "stuck": {
      const parts: string[] = [];
      if (a.waiting_unanswered > 0) parts.push(`${n(a.waiting_unanswered, "session")} under it waiting unanswered`);
      if (a.review_stalls > 0) parts.push(`${n(a.review_stalls, "task")} stuck in review`);
      if (a.blocked_sessions > 0) parts.push(`${n(a.blocked_sessions, "task")} blocked`);
      return `Stuck: ${parts.join(", ")}.`;
    }
    case "overloaded": return a.overloaded_by.length ? `Overloaded: ${a.overloaded_by.join(", ")}.` : "Overloaded: more reaches it than one role can answer.";
    case "quiet": return a.idle_days === null ? `Quiet: nothing has moved since it started ${n(a.age_days, "day")} ago.` : `Quiet: nothing has moved for ${n(a.idle_days, "day")}.`;
    case "on_track": return "On track.";
  }
}

/** At most three signals, in plain words, each one a reason to act: what
 *  waits, what is stuck, what is not moving, what ended. Structure (span, an
 *  unowned project, a stale record) belongs to the Head of People's review,
 *  not to a row (S29). */
export function areaSignalsOf(a: AreaInput): AreaSignal[] {
  const out: AreaSignal[] = [];
  if (a.standing_waits_on_person) out.push({ code: "raised", severity: "blocker", text: a.standing_state_line ? `It raised something for you: ${a.standing_state_line}` : "It raised something for you in its thread." });
  if (a.waiting_unanswered > 0) out.push({ code: "waiting_sessions", severity: "warn", text: `${n(a.waiting_unanswered, "session")} under it ${a.waiting_unanswered === 1 ? "has" : "have"} waited more than a day with no answer from it.` });
  else if (a.waiting_total > 0) out.push({ code: "waiting_sessions", severity: "info", text: `${n(a.waiting_total, "session")} under it ${a.waiting_total === 1 ? "is" : "are"} waiting on someone.` });
  if (a.review_stalls > 0) out.push({ code: "review_stall", severity: "warn", text: `${n(a.review_stalls, "task")} ${a.review_stalls === 1 ? "has" : "have"} sat in review for more than a day with nobody owning the verdict.` });
  if (a.blocked_sessions > 0) out.push({ code: "blocked_sessions", severity: "warn", text: `${n(a.blocked_sessions, "task")} still open whose session reported blocked or missing context.` });
  if (a.overloaded) out.push({ code: "overloaded", severity: "warn", text: `More reaches it than one role can answer: ${a.overloaded_by.join(", ")}.` });
  if (a.program_ended) out.push({ code: "program_ended", severity: "warn", text: `The work it was hired for ended: ${a.program_ended.ended}. Its tenure says ${a.program_ended.then === "retire" ? "retire it" : "review it"}.` });
  if (a.idle && !a.standing_waits_on_person) out.push({ code: "idle", severity: "info", text: a.idle_days === null ? `Nothing has moved in its area since it started ${n(a.age_days, "day")} ago.` : `Nothing has moved in its area for ${n(a.idle_days, "day")}.` });
  return out.slice(0, 3);
}

/** The newest dated line first; undated lines keep their written order after the dated ones. */
export function newestStandingFirst<L extends { written_at: number | null }>(lines: L[]): L[] {
  return [...lines].sort((x, y) => (y.written_at ?? -1) - (x.written_at ?? -1));
}

// ── The change the watch tells the Head of People about (S29) ────────────────

export type AreaChangeKind = "status" | "unowned_project";

/** What lasted: an area that read the same pressing status at two checks in
 *  a row, or a project with work and no owner. Rides the Head of People's
 *  trigger frame as its own block (machineMessages AreaChange). */
export type AreaChange =
  | { kind: "status"; role_handle: string; role_name: string; from: AreaStatus | null; to: AreaStatus; since: number; line: string }
  | { kind: "unowned_project"; project_id: string; project_title: string; since: number; line: string };

/** One line that says the change in words, for the frame and the thread. */
export function areaChangeLine(c: AreaChange): string {
  if (c.kind === "unowned_project") return `The project "${c.project_title}" has work and no role looking after it.`;
  const was = c.from ? `, was ${AREA_STATUS_WORDS[c.from]}` : "";
  return `${c.role_name} (@${c.role_handle}) has read ${AREA_STATUS_WORDS[c.to]} at two checks in a row${was}. ${c.line}`.trim();
}
