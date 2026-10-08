/**
 * The task graph (docs/architecture/task-graph.md): what blocks a task, when
 * it is ready, how a person names a blocker, and which edges would close a
 * loop. Convex, the CLI, the web and mobile all read these, so "ready", a
 * wait's wording and the loop error read the same everywhere.
 *
 * Pure: no Convex, no clock of its own. A caller resolves blocker statuses
 * from wherever it holds them and passes `now` for anything time-shaped.
 */

import { normalizeRepository, parsePrRef } from "../contracts/prRefs";
import { parseDuration } from "../time";
import { isTerminalTaskStatus } from "./statuses";

// ---------------------------------------------------------------------------
// Waits (TG2): blockers on something that is not a task
// ---------------------------------------------------------------------------

export const WAIT_KINDS = ["pr_merged", "pr_checks_green", "decision", "time"] as const;
export type WaitKind = (typeof WAIT_KINDS)[number];

export const WAIT_STATES = ["waiting", "met", "failed"] as const;
export type WaitState = (typeof WAIT_STATES)[number];

/** What a wait waits on, without its lifecycle. What `parseBlockerRef` yields
 *  for a non-task ref once a bare `#42` has its repository. */
export type PrWaitTarget = { kind: "pr_merged" | "pr_checks_green"; repository: string; pr_number: number };
export type DecisionWaitTarget = { kind: "decision"; decision: string };
export type TimeWaitTarget = { kind: "time"; at: number };
export type WaitTarget = PrWaitTarget | DecisionWaitTarget | TimeWaitTarget;

/** One entry of `tasks.waits`. A met or failed wait stays as history; a
 *  failed one keeps blocking. */
export type TaskWait = WaitTarget & {
  /** Stable within the task. */
  id: string;
  state: WaitState;
  created_at: number;
  created_by?: string;
  settled_at?: number;
  /** Written when it settles: "merged", "answered: Ship it", "closed without merging". */
  note?: string;
};

/** Two time waits closer than this are one moment: a retried "2h" is one wait. */
export const SAME_WAIT_TIME_MS = 60_000;

/** A wait's id: "w", a base36 clock, 1-3 random base36 digits. The web mints
 *  one to paint a wait before the server answers, the server for the rest. */
export function newWaitId(now = Date.now()): string {
  return `w${now.toString(36)}${Math.floor(Math.random() * 46656).toString(36)}`;
}

/** Whether `text` has the shape `newWaitId` makes. Base36 may hold no digit
 *  at all, so a caller reading a ref checks the blocker grammar first. */
export function isWaitId(text: string): boolean {
  return /^w[0-9a-z]{9,11}$/.test(text);
}

/** Whether two targets wait on the same thing, so a second add is the first.
 *  An empty repository (a bare `#42` the server has not resolved yet) matches
 *  that number in any repository. */
export function sameWaitTarget(a: WaitTarget, b: WaitTarget): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "decision") return a.decision.toLowerCase() === (b as DecisionWaitTarget).decision.toLowerCase();
  if (a.kind === "time") return Math.abs(a.at - (b as TimeWaitTarget).at) < SAME_WAIT_TIME_MS;
  const p = b as PrWaitTarget;
  return a.pr_number === p.pr_number &&
    (!a.repository || !p.repository || normalizeRepository(a.repository) === normalizeRepository(p.repository));
}

// ---------------------------------------------------------------------------
// Blockers and readiness (TG1)
// ---------------------------------------------------------------------------

type RefTask = { short_id?: string | null; _id?: unknown; status?: string | null };

/**
 * What the caller knows about the task a `blocked_by` ref names (a short id,
 * or the `_id` a plan's older rows used):
 *
 * - its status, or `{ short_id, status }` so an `_id` ref prints and dedupes
 *   as its short id;
 * - `null`: looked up and not found. It does not block; it is reported missing;
 * - `undefined`: not looked up. It blocks with status `unknown`, so a blocker
 *   outside the caller's page never reads as cleared.
 *
 * Build it with `statusLookup`.
 */
export type StatusOf = (ref: string) => string | RefTask | null | undefined;

/** The status of a blocker the caller did not look up. Not terminal, so it blocks. */
export const UNKNOWN_BLOCKER_STATUS = "unknown";

/**
 * A `StatusOf` over the tasks the caller holds, keyed by short id and `_id`.
 * A ref it does not hold is unknown (and blocks) unless it is in `searched`,
 * the refs the caller actually looked up in the database (see `blockerRefs`):
 * one of those still absent is confirmed missing.
 */
export function statusLookup(tasks: Iterable<RefTask>, searched: Iterable<string> = []): StatusOf {
  const byRef = new Map<string, RefTask>();
  for (const t of tasks) {
    if (t.short_id) byRef.set(t.short_id, t);
    if (t._id) byRef.set(String(t._id), t);
  }
  const looked = new Set(searched);
  return (ref) => byRef.get(ref) ?? (looked.has(ref) ? null : undefined);
}

/** `ReadinessOptions.parentStatusOf` over the same lookup, for a caller that
 *  put the parents it read (and their `_id`s in `searched`) into `statusOf`. */
export function parentStatusLookup(statusOf: StatusOf): (parentId: string) => string | null | undefined {
  return (id) => {
    const p = statusOf(id);
    return p && typeof p === "object" ? p.status ?? null : p;
  };
}

/**
 * The `blocked_by` refs of `tasks` that name none of them, split by how the
 * caller finds them: `shortIds` through the short id index, `ids` (a plan's
 * older rows name blockers by `_id`) by `_id`. Only the refs a caller really
 * looked up go into `statusLookup`'s `searched`; an `_id` searched for as a
 * short id finds nothing and would read as missing, releasing an open blocker.
 */
export function blockerRefs(tasks: Iterable<RefTask & { blocked_by?: readonly string[] | null }>): { shortIds: string[]; ids: string[] } {
  const list = [...tasks];
  const held = statusLookup(list);
  const refs = [...new Set(list.flatMap((t) => t.blocked_by ?? []))].filter((ref) => held(ref) === undefined);
  return { shortIds: refs.filter((r) => TASK_REF.test(r)), ids: refs.filter((r) => !TASK_REF.test(r)) };
}

/** `status` is `UNKNOWN_BLOCKER_STATUS` when the caller did not look it up. */
export type TaskBlocker = { kind: "task"; ref: string; status: string };
export type MissingTaskBlocker = { kind: "task"; ref: string; missing: true };
/** An open blocker: a task not yet closed, an id that resolves to nothing, or
 *  a wait not met. */
export type Blocker = TaskBlocker | MissingTaskBlocker | TaskWait;

export type GraphTask = {
  status?: string | null;
  blocked_by?: readonly string[] | null;
  waits?: readonly TaskWait[] | null;
  triage_status?: string | null;
  superseded_by?: string | null;
  parent_id?: unknown;
  /** TG9: bookkeeping that is ready only for its owner (`ownsEphemeral`). */
  ephemeral?: boolean | null;
  user_id?: unknown;
  created_from_conversation?: unknown;
};

/**
 * Whether the asker owns this ephemeral task (TG9). The owner is the session
 * that filed it, else (filed at a terminal) the person: every agent session
 * runs under its person's token, so the user id alone would hand one
 * session's checklist to the whole fleet. `viewer` is a users `_id`,
 * `viewerSession` the asking session's conversations `_id` (null for a person).
 */
export function ownsEphemeral(task: GraphTask, viewer: string | null, viewerSession?: string | null): boolean {
  if (viewer == null || task.user_id == null || String(task.user_id) !== viewer) return false;
  return String(task.created_from_conversation ?? "") === String(viewerSession ?? "");
}

/**
 * Every entry of a task's Blocked by, cleared ones included (`isCleared`): a
 * task blocker done or dropped, a met wait kept as history. Task blockers
 * come first (in `blocked_by` order), then waits. A read-only list (mobile)
 * shows these; `blockersOf` is the open ones.
 */
export function blockerEntriesOf(task: GraphTask, statusOf: StatusOf): Blocker[] {
  return [...taskBlockerEntries(task, statusOf).map((e) => e.blocker), ...(task.waits ?? [])];
}

/**
 * The task half of `blockerEntriesOf`, each with `raws`: every form
 * `blocked_by` names it by. One blocker named by both its short id and its
 * `_id` (a plan's older rows) is one entry, as the short id; removing it
 * removes every raw form, or it comes back under the other.
 */
export function taskBlockerEntries(task: GraphTask, statusOf: StatusOf): { blocker: TaskBlocker | MissingTaskBlocker; raws: string[] }[] {
  const byRef = new Map<string, { blocker: TaskBlocker | MissingTaskBlocker; raws: string[] }>();
  for (const raw of task.blocked_by ?? []) {
    const found = statusOf(raw);
    const info = typeof found === "string" ? { status: found } : found;
    const ref = info?.short_id || raw;
    const seen = byRef.get(ref);
    if (seen) {
      if (!seen.raws.includes(raw)) seen.raws.push(raw);
      continue;
    }
    byRef.set(ref, {
      blocker: found === null ? { kind: "task", ref, missing: true } : { kind: "task", ref, status: info?.status || UNKNOWN_BLOCKER_STATUS },
      raws: [raw],
    });
  }
  return [...byRef.values()];
}

/** A task blocker that closed, or a met wait. A missing id is not cleared
 *  (it is reported); it just does not block (`isBlocking`). */
export function isCleared(b: Blocker): boolean {
  return b.kind === "task" ? "status" in b && isTerminalTaskStatus(b.status) : b.state === "met";
}

/**
 * The open blockers of a task, task blockers first (in `blocked_by` order),
 * then waits. Readiness, the CLI's "blocked by" lines, the row tooltip and
 * the task page all render from this one list.
 */
export function blockersOf(task: GraphTask, statusOf: StatusOf): Blocker[] {
  return blockerEntriesOf(task, statusOf).filter((b) => !isCleared(b));
}

/** Whether this blocker holds the task back. A missing task id does not. */
export function isBlocking(b: Blocker): boolean {
  return !(b.kind === "task" && "missing" in b);
}

/** Whether this entry of a Blocked by list holds the task back now: not
 *  cleared, and not a missing id. */
export function holdsBack(b: Blocker): boolean {
  return !isCleared(b) && isBlocking(b);
}

/** What holds the task back: `blockersOf` without the missing ids, which are
 *  reported but block nothing. */
export function openBlockersOf(task: GraphTask, statusOf: StatusOf): Blocker[] {
  return blockerEntriesOf(task, statusOf).filter(holdsBack);
}

/** Every task in `blocked_by` is done or dropped (or missing), and every wait is met. */
export function isUnblocked(task: GraphTask, statusOf: StatusOf): boolean {
  return !openBlockersOf(task, statusOf).length;
}

export type ReadinessOptions = {
  statusOf: StatusOf;
  /** The parent's status by `parent_id`, resolved by the caller from the
   *  database, never inferred from a filtered page. `null` means looked up
   *  and gone (the subtask is an orphan, so ready); `undefined` means not
   *  looked up, which is not ready (`parent_unknown`), so a caller that forgot
   *  to load parents never hands out a subtask of work in progress. */
  parentStatusOf: (parentId: string) => string | null | undefined;
  /** The user asking (a users `_id`), or null for no one in particular, and
   *  the session asking (a conversations `_id`), unset for a person. An
   *  ephemeral task is ready only for its owner (`ownsEphemeral`). */
  viewer: string | null;
  viewerSession?: string | null;
  /** Count subtasks of a parent being worked as ready (CLI --subtasks). */
  includeSubtasks?: boolean;
};

export type NotReadyReason = "status" | "triage" | "superseded" | "ephemeral" | "parent_active" | "parent_unknown" | "blocked";

export type Readiness =
  | { ready: true }
  | { ready: false; reason: NotReadyReason; blockers?: Blocker[] };

/**
 * Why a task can or cannot be started now. Ready = open, triage active or
 * unset, not superseded, not someone else's ephemeral task, its parent not in
 * progress or in review (unless the caller asks for subtasks), and unblocked.
 * A parent being worked owns its decomposition; an orphaned subtask (parent
 * open, closed or gone) stays ready, which is the rescue path for abandoned
 * trees.
 */
export function readinessOf(task: GraphTask, opts: ReadinessOptions): Readiness {
  if (task.status !== "open") return { ready: false, reason: "status" };
  if (task.triage_status && task.triage_status !== "active") return { ready: false, reason: "triage" };
  if (task.superseded_by) return { ready: false, reason: "superseded" };
  if (task.ephemeral && !ownsEphemeral(task, opts.viewer, opts.viewerSession)) return { ready: false, reason: "ephemeral" };
  if (task.parent_id && !opts.includeSubtasks) {
    const ps = opts.parentStatusOf(String(task.parent_id));
    if (ps === undefined) return { ready: false, reason: "parent_unknown" };
    if (ps === "in_progress" || ps === "in_review") return { ready: false, reason: "parent_active" };
  }
  const blockers = openBlockersOf(task, opts.statusOf);
  return blockers.length ? { ready: false, reason: "blocked", blockers } : { ready: true };
}

export function isReady(task: GraphTask, opts: ReadinessOptions): boolean {
  return readinessOf(task, opts).ready;
}

// ---------------------------------------------------------------------------
// Words (one phrasing for every surface)
// ---------------------------------------------------------------------------

export type WaitLabelOptions = {
  /** Reference clock for a time wait's day ("Thu" vs "Oct 14"). */
  now?: number;
  /** IANA zone for a time wait; default the runtime's (UTC on the server).
   *  One the runtime does not know falls back to the default. */
  timeZone?: string;
  /** Name the repository: "PR owner/repo#42" instead of "PR #42". */
  fullRef?: boolean;
  /** The repository a bare "#42" is read in (the task's, the checkout's): a
   *  PR in any other one is named in full. */
  repository?: string;
  /** A time wait as a full date with its zone ("Oct 14, 2026 09:00 UTC"), for
   *  text that is stored and read later, in other zones: a task_history line,
   *  the "Unblocked: …" comment. Relative words ("Thu", "09:00") are for
   *  rendering in the viewer's zone. */
  absolute?: boolean;
};

function prRef(w: PrWaitTarget, opts: WaitLabelOptions): string {
  const elsewhere = opts.repository !== undefined && normalizeRepository(w.repository) !== normalizeRepository(opts.repository);
  return opts.fullRef || elsewhere ? `${w.repository}#${w.pr_number}` : `#${w.pr_number}`;
}

/** How a reader in `repository` should see PR refs: bare in that repository,
 *  in full anywhere else, and always in full when no repository is known. */
export function prWords(repository: string | null | undefined): Pick<WaitLabelOptions, "repository" | "fullRef"> {
  return repository ? { repository } : { fullRef: true };
}

/** Whether the runtime knows `timeZone` as an IANA zone. */
export function isKnownTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The wall clock `ts` reads in `timeZone` (month 1-12). Without a zone it is
 *  Date's own local getters, so the phone's path (Hermes) leans on no Intl
 *  option an engine may print its own way. */
function wallClock(ts: number, timeZone: string | undefined) {
  if (!timeZone) {
    const d = new Date(ts);
    return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(), hour: d.getHours(), minute: d.getMinutes(), second: d.getSeconds() };
  }
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" })
      .formatToParts(ts)
      .map((x) => [x.type, Number(x.value)]),
  );
  return { year: p.year, month: p.month, day: p.day, hour: p.hour % 24, minute: p.minute, second: p.second };
}

/** "09:00", "Thu 09:00" within the coming week, "Oct 14 09:00" past it, with
 *  the year when it is not this one. `absolute` always prints the date, the
 *  year and the zone. */
export function formatWaitTime(at: number, opts: WaitLabelOptions = {}): string {
  const now = opts.now ?? Date.now();
  const tz = opts.timeZone && isKnownTimeZone(opts.timeZone) ? opts.timeZone : undefined;
  const w = wallClock(at, tz);
  const n = wallClock(now, tz);
  const time = `${String(w.hour).padStart(2, "0")}:${String(w.minute).padStart(2, "0")}`;
  const date = `${MONTHS[w.month - 1]} ${w.day}`;
  if (opts.absolute) {
    const zone = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" })
      .formatToParts(at)
      .find((p) => p.type === "timeZoneName")?.value;
    return `${date}, ${w.year} ${time}${zone ? ` ${zone}` : ""}`;
  }
  if (w.year === n.year && w.month === n.month && w.day === n.day) return time;
  if (at > now && at - now < 6 * 86_400_000) return `${WEEKDAYS[new Date(Date.UTC(w.year, w.month - 1, w.day)).getUTCDay()]} ${time}`;
  return `${w.year === n.year ? date : `${date}, ${w.year}`} ${time}`;
}

/** The condition a wait is waiting for: "PR #42 merges", "checks green on
 *  #42", "sd-412 answered", "until Thu 09:00". */
export function waitLabel(w: WaitTarget, opts: WaitLabelOptions = {}): string {
  switch (w.kind) {
    case "pr_merged": return `PR ${prRef(w, opts)} merges`;
    case "pr_checks_green": return `checks green on ${prRef(w, opts)}`;
    case "decision": return `${w.decision} answered`;
    case "time": return `until ${formatWaitTime(w.at, opts)}`;
  }
}

/** The same condition once met, for "Unblocked: PR #42 merged". The comment
 *  is stored, so its writer passes `absolute`. */
export function waitMetLabel(w: WaitTarget, opts: WaitLabelOptions = {}): string {
  switch (w.kind) {
    case "pr_merged": return `PR ${prRef(w, opts)} merged`;
    case "pr_checks_green": return `checks green on ${prRef(w, opts)}`;
    case "decision": return `${w.decision} answered`;
    case "time": return `${formatWaitTime(w.at, opts)} passed`;
  }
}

/** What a wait waits on, mid-sentence after "wait"/"waiting": "on PR #42",
 *  "on green checks for PR #42", "on sd-412", "until Thu 09:00". */
export function waitClause(w: WaitTarget, opts: WaitLabelOptions = {}): string {
  switch (w.kind) {
    case "pr_merged": return `on PR ${prRef(w, opts)}`;
    case "pr_checks_green": return `on green checks for PR ${prRef(w, opts)}`;
    case "decision": return `on ${w.decision}`;
    case "time": return `until ${formatWaitTime(w.at, opts)}`;
  }
}

const WAITING = "Waiting ";

/** The timeline's phrase for a wait being set (TG11): "Waiting on PR #42",
 *  "Waiting until Thu 09:00". History writers pass `absolute`, since the line
 *  is stored and read in other zones. */
export function waitingOnLabel(w: WaitTarget, opts: WaitLabelOptions = {}): string {
  return `${WAITING}${waitClause(w, opts)}`;
}

/** What cleared a met wait, for "Unblocked: …": "PR #42 merged", "sd-4
 *  answered: Ship it" (a decision's note carries the answer). */
export function waitMetCause(w: TaskWait, opts: WaitLabelOptions = {}): string {
  return w.kind === "decision" && w.note ? `${w.decision} ${w.note}` : waitMetLabel(w, opts);
}

/** One wait in its current state, as the timeline stores it and the plan
 *  graph titles it: "Waiting on PR #42", "PR #42 merged", "PR #42 merges
 *  (failed: closed without merging)". `waitLineParts` reads it back. */
export function waitLine(w: TaskWait, opts: WaitLabelOptions = {}): string {
  if (w.state === "waiting") return waitingOnLabel(w, opts);
  return w.state === "met" ? waitMetCause(w, opts) : blockerLabel(w, opts);
}

/** A stored `waitLine` read back: its state, and for a waiting one the
 *  clause ("on PR #42"). */
export function waitLineParts(line: string): { state: WaitState; clause?: string } {
  if (line.startsWith(WAITING)) return { state: "waiting", clause: line.slice(WAITING.length) };
  return { state: /\(failed\b/.test(line) ? "failed" : "met" };
}

/** The words for a task blocker whose status cannot be shown: "not found"
 *  for an id that names no task, "status unknown" for one the caller did not
 *  look up. Undefined for a task it holds. */
export function blockerStateLabel(b: TaskBlocker | MissingTaskBlocker): string | undefined {
  if ("missing" in b) return "not found";
  return b.status === UNKNOWN_BLOCKER_STATUS ? "status unknown" : undefined;
}

/** One line for any blocker: "ct-12", "ct-12 (not found)", "ct-12 (status
 *  unknown)", or the wait's condition, with "failed" when a wait can no
 *  longer be met. */
export function blockerLabel(b: Blocker, opts: WaitLabelOptions = {}): string {
  if (b.kind === "task") {
    const state = blockerStateLabel(b);
    return state ? `${b.ref} (${state})` : b.ref;
  }
  return `${waitLabel(b, opts)}${failedSuffix(b)}`;
}

/** " (failed: closed without merging)" after a failed wait's label, else "". */
export function failedSuffix(w: Pick<TaskWait, "state" | "note">): string {
  return w.state === "failed" ? ` (failed${w.note ? `: ${w.note}` : ""})` : "";
}

/** The word for a wait still waiting, after its pill: "to merge". */
export const WAIT_PENDING_WORD: Record<WaitKind, string> = {
  pr_merged: "to merge",
  pr_checks_green: "checks to go green",
  decision: "to be answered",
  time: "",
};

/** The word for a met wait: the note its settle writes, and what a page shows
 *  for one met without a note. */
export const WAIT_MET_WORD: Record<WaitKind, string> = {
  pr_merged: "merged",
  pr_checks_green: "checks green",
  decision: "answered",
  time: "passed",
};

// ---------------------------------------------------------------------------
// The blocker grammar (TG3)
// ---------------------------------------------------------------------------

export type BlockerRef =
  | { ok: true; kind: "task"; ref: string }
  /** `repository` is undefined for a bare `#42`: the caller resolves it (the
   *  task's project, then the git remote) and fails with the candidates. */
  | { ok: true; kind: "pr_merged" | "pr_checks_green"; repository?: string; pr_number: number }
  | { ok: true; kind: "decision"; decision: string }
  | { ok: true; kind: "time"; at: number }
  | { ok: false; error: string };

const TASK_REF = /^ct-(\d+)$/i;
const DECISION_REF = /^sd-(\d+)$/i;
const CHECKS_SUFFIX = /:(checks|ci)$/i;
/** The checks tab of a URL `parsePrRef` already read as a GitHub PR: …/pull/42/checks */
const CHECKS_TAB = /\/pulls?\/\d+\/checks\b/i;
/** A date, optionally with a time, optionally with a zone (only after a time). */
const ISO_TIME = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?(Z|([+-])(\d{2}):?(\d{2}))?)?$/i;

export type ParseBlockerOptions = {
  /** The clock a duration counts from. */
  now?: number;
  /** IANA zone a date or datetime without a zone is wall time in; default
   *  the runtime's. The server runs in UTC, so a server parse passes the
   *  person's zone or the wait lands hours off. */
  timeZone?: string;
};

/**
 * Read a blocker as a person writes it, in the CLI flags, the web's
 * add-blocker palette and the server:
 *
 *   ct-123                          a task (blocked_by)
 *   #42, owner/repo#42, a PR URL    pr_merged
 *   the same with :checks or :ci,   pr_checks_green
 *   or the PR's /checks URL
 *   sd-412                          decision
 *   30m, 2h, 3d, 1w                 time, relative to `now`
 *   2026-10-14, 2026-10-14T09:00    time; a bare date is midnight, and a
 *                                   datetime without a zone is wall time,
 *                                   both in `timeZone`
 *
 * A bare number is refused rather than guessed: "42" could mean #42 or ct-42.
 * `opts` may be a bare `now`.
 */
export function parseBlockerRef(raw: string, opts: ParseBlockerOptions | number = {}): BlockerRef {
  const { now = Date.now(), timeZone } = typeof opts === "number" ? { now: opts } : opts;
  const text = (raw ?? "").trim();
  if (!text) return { ok: false, error: "Empty blocker: name a task (ct-12), a PR (#42), a decision (sd-4) or a time (2h)" };
  if (timeZone && !isKnownTimeZone(timeZone)) return { ok: false, error: `Unknown time zone "${timeZone}"` };

  // Canonical ids: ct-012 is ct-12, or it would match no task and never block.
  // Numbering starts at 1, so ct-0, sd-0 and #0 name nothing a wait could settle on.
  const zero = (what: string) => ({ ok: false as const, error: `"${text}" names no ${what}: numbers start at 1` });
  const task = TASK_REF.exec(text);
  if (task) return Number(task[1]) ? { ok: true, kind: "task", ref: `ct-${Number(task[1])}` } : zero("task");
  const decision = DECISION_REF.exec(text);
  if (decision) return Number(decision[1]) ? { ok: true, kind: "decision", decision: `sd-${Number(decision[1])}` } : zero("decision");

  const suffix = CHECKS_SUFFIX.test(text);
  const prText = text.replace(CHECKS_SUFFIX, "");
  const n = /^\d+$/.exec(prText)?.[0];
  if (n) return { ok: false, error: `"${text}" is ambiguous: write #${n} for a pull request or ct-${n} for a task` };
  const parsed = parsePrRef(prText);
  // parsePrRef also reads "owner/name/12"; an all-digit pair is a date (2026/10/14), not a repository.
  const pr = parsed?.repository && /^\d+\/\d+$/.test(parsed.repository) ? null : parsed;
  if (pr) {
    if (pr.number == null) return { ok: false, error: `"${text}" names a repository but no pull request (write ${pr.repository}#42)` };
    if (!pr.number) return zero("pull request");
    const kind = suffix || CHECKS_TAB.test(prText) ? "pr_checks_green" : "pr_merged";
    return pr.repository
      ? { ok: true, kind, repository: pr.repository, pr_number: pr.number }
      : { ok: true, kind, pr_number: pr.number };
  }
  if (suffix) return { ok: false, error: `"${text}": :checks follows a pull request (#42:checks)` };

  const at = parseWaitTime(text, now, timeZone);
  if (at !== null) {
    if (at <= now) return { ok: false, error: `"${text}" is in the past` };
    return { ok: true, kind: "time", at };
  }

  return {
    ok: false,
    error: `"${text}" is not a blocker: use a task (ct-12), a PR (#42, owner/repo#42, a PR URL, add :checks for CI), a decision (sd-4), a duration (30m, 2h, 3d, 1w) or a date (2026-10-14, 2026-10-14T09:00)`,
  };
}

/** A duration from `now`, or an ISO date or datetime; null when it is neither. */
function parseWaitTime(text: string, now: number, timeZone: string | undefined): number | null {
  if (/^\d/.test(text) && !/^\d{4}-/.test(text)) {
    try { return now + parseDuration(text); } catch { return null; }
  }
  const m = ISO_TIME.exec(text);
  if (!m) return null;
  const [y, mo, d, h = 0, mi = 0, s = 0] = m.slice(1, 7).map((x) => (x === undefined ? undefined : Number(x)));
  // Date.UTC rolls Feb 30 over to March 2 and 24:00 to the next day, so refuse what is not a real moment.
  const wall = Date.UTC(y!, mo! - 1, d!, h, mi, s, Math.round(Number(m[7] ?? 0) * 1000));
  const back = new Date(wall);
  if (back.getUTCDate() !== d || back.getUTCMonth() !== mo! - 1 || back.getUTCHours() !== h || back.getUTCMinutes() !== mi || s > 59) return null;
  if (m[8]?.toUpperCase() === "Z") return wall;
  if (m[9]) {
    const [oh, om] = [Number(m[10]), Number(m[11])];
    // Real offsets run from -12:00 to +14:00.
    if (oh > 14 || om > 59) return null;
    return wall - (m[9] === "-" ? -1 : 1) * (oh * 60 + om) * 60_000;
  }
  return wallTimeIn(wall, timeZone);
}

/** The instant the wall time `wall` (its fields read as UTC) names in
 *  `timeZone`. The zone's offset is taken twice, the second time at the
 *  first answer, so a time across a daylight saving change lands right. */
function wallTimeIn(wall: number, timeZone: string | undefined): number {
  const offset = (ts: number) => {
    const p = wallClock(ts, timeZone);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - (ts - (ts % 1000));
  };
  return wall - offset(wall - offset(wall));
}

// ---------------------------------------------------------------------------
// Edges that cannot loop (TG4) and order
// ---------------------------------------------------------------------------

/** A node of the dependency graph. `blocked_by` entries are short ids; a
 *  plan's older rows may name a blocker by `_id`, which resolves too. */
export type DepNode = { short_id: string; _id?: string; blocked_by?: readonly string[] | null };

type DepIndex<T extends DepNode = DepNode> = { nodes: T[]; out: Map<string, string[]>; key: Map<string, string> };

/** blocker short id -> the short ids it blocks, over the nodes given, and
 *  `key`: any ref (short id or `_id`) -> its node's short id. */
function dependentsIndex<T extends DepNode>(tasks: Iterable<T>): DepIndex<T> {
  const nodes = [...tasks];
  const byKey = new Map<string, string>();
  for (const t of nodes) {
    byKey.set(t.short_id, t.short_id);
    if (t._id) byKey.set(String(t._id), t.short_id);
  }
  const out = new Map<string, string[]>(nodes.map((t) => [t.short_id, []]));
  for (const t of nodes) {
    for (const dep of new Set(t.blocked_by ?? [])) {
      const from = byKey.get(dep);
      if (from) out.get(from)!.push(t.short_id);
    }
  }
  return { nodes, out, key: byKey };
}

/**
 * The shortest chain `from` → … → `to` where each step blocks the next, as
 * short ids, or null when there is none. `from` and `to` may be short ids or
 * `_id`s. Pass the nodes whose edges should count: every task in the
 * workspace that is not done or dropped (`!isTerminalTaskStatus`), not only
 * the `open` ones. An edge counts when both its ends are in the set.
 */
export function findPath(tasks: Iterable<DepNode>, from: string, to: string): string[] | null {
  return pathIn(dependentsIndex(tasks), from, to);
}

function pathIn({ out, key }: DepIndex, fromRef: string, toRef: string): string[] | null {
  const from = key.get(fromRef) ?? fromRef;
  const to = key.get(toRef) ?? toRef;
  if (from === to) return [from];
  const prev = new Map<string, string>([[from, from]]);
  const queue = [from];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const next of out.get(cur) ?? []) {
      if (prev.has(next)) continue;
      prev.set(next, cur);
      if (next === to) {
        const path = [to];
        for (let n = to; n !== from; ) path.unshift((n = prev.get(n)!));
        return path;
      }
      queue.push(next);
    }
  }
  return null;
}

/**
 * The error for making `task` wait on `blocker`, or null when the edge is
 * safe: "ct-9 already waits on ct-5 (ct-5 → ct-7 → ct-9); this edge would
 * close a loop." addDep, create and update all word it this way. Either ref
 * may be a short id or an `_id`; the message names short ids. Pass the same
 * set as `findPath`.
 */
export function dependencyLoopError(tasks: Iterable<DepNode>, task: string, blocker: string): string | null {
  return dependencyLoopChecker(tasks)(task, blocker);
}

/** `dependencyLoopError` over one index of `tasks`, for a caller checking
 *  many edges against the same set (a palette marking each candidate). */
export function dependencyLoopChecker(tasks: Iterable<DepNode>): (task: string, blocker: string) => string | null {
  const index = dependentsIndex(tasks);
  return (task, blocker) => {
    const [t, b] = [index.key.get(task) ?? task, index.key.get(blocker) ?? blocker];
    if (t === b) return `${t} cannot wait on itself.`;
    const path = pathIn(index, t, b);
    return path ? `${b} already waits on ${t} (${path.join(" → ")}); this edge would close a loop.` : null;
  };
}

/**
 * Kahn's layers: each layer depends only on earlier ones, in the input order
 * within a layer. Nodes on or behind a cycle never reach in-degree zero; they
 * come back in `cyclic` (input order) so a drawing can still place them.
 */
export function topoLayers<T extends DepNode>(tasks: Iterable<T>): { layers: T[][]; cyclic: T[] } {
  return layersOf(dependentsIndex(tasks));
}

function layersOf<T extends DepNode>({ nodes, out }: DepIndex<T>): { layers: T[][]; cyclic: T[] } {
  const inDeg = new Map<string, number>(nodes.map((t) => [t.short_id, 0]));
  for (const targets of out.values()) for (const t of targets) inDeg.set(t, inDeg.get(t)! + 1);

  const layers: T[][] = [];
  let remaining = nodes;
  while (remaining.length) {
    const layer = remaining.filter((t) => inDeg.get(t.short_id) === 0);
    if (!layer.length) break;
    layers.push(layer);
    for (const t of layer) for (const next of out.get(t.short_id)!) inDeg.set(next, inDeg.get(next)! - 1);
    const placed = new Set(layer);
    remaining = remaining.filter((t) => !placed.has(t));
  }
  return { layers, cyclic: remaining };
}

/**
 * A topological order of the short ids, and the cycles that stopped the rest.
 * Each cycle is found by walking back along `blocked_by` among the unplaced
 * nodes and starts at the node the walk closed on. A node that only waits
 * behind a cycle is unplaced but is not reported as a cycle of its own.
 */
export function topologicalOrder(tasks: Iterable<DepNode>): { sorted: string[]; cycles: string[][] } {
  const index = dependentsIndex(tasks);
  const { layers, cyclic } = layersOf(index);
  const remaining = new Map(cyclic.map((t) => [t.short_id, t]));
  const visited = new Set<string>();
  const cycles: string[][] = [];
  for (const start of remaining.keys()) {
    const walk: string[] = [];
    let cur: string | undefined = start;
    while (cur && !visited.has(cur)) {
      visited.add(cur);
      walk.push(cur);
      // Every unplaced node waits on another unplaced node, so the walk ends on a visited one.
      cur = remaining.get(cur)!.blocked_by?.map((d) => index.key.get(d)).find((d) => d !== undefined && remaining.has(d));
    }
    // Closing on this walk is a cycle; running into an earlier walk means this one sat behind it.
    const at = cur === undefined ? -1 : walk.indexOf(cur);
    if (at >= 0) cycles.push(walk.slice(at));
  }
  return { sorted: layers.flat().map((t) => t.short_id), cycles };
}
