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
import { isKnownTimeZone, localTimeZone, MONTHS, parseDuration, relTimeShort, relTimeUntil, wallClock, wallTimeIn, WEEKDAYS } from "../time";
import { isTaskBeingWorked, isTerminalTaskStatus } from "./statuses";

// ---------------------------------------------------------------------------
// Waits (TG2): blockers on something that is not a task
// ---------------------------------------------------------------------------

const WAIT_KINDS = ["pr_merged", "pr_checks_green", "decision", "time"] as const;
export type WaitKind = (typeof WAIT_KINDS)[number];

/** Whether this bundle knows how to word a wait of that kind. A client reads
 *  waits the server wrote, and a kind added after it shipped (an OTA bundle
 *  lags its binary, a stale tab lags a deploy) has no words here: such a wait
 *  reads by its own name and state instead of through the wording functions,
 *  which answer for the four kinds alone. */
export function isWaitKind(kind: string): kind is WaitKind {
  return (WAIT_KINDS as readonly string[]).includes(kind);
}

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
const SAME_WAIT_TIME_MS = 60_000;

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

/** Whether a new wait on the same target takes `w`'s place instead of
 *  repeating it: a failed wait, and a met checks wait, since a push can turn
 *  the checks red again. A met merge, answer or time stays met. */
export function waitIsReplaceable(w: Pick<TaskWait, "kind" | "state">): boolean {
  return w.state === "failed" || (w.state === "met" && w.kind === "pr_checks_green");
}

/** Anything naming a wait's target: a stored wait, a parsed ref, an input. */
type WaitTargetLike =
  | { kind: PrWaitTarget["kind"]; repository?: string; pr_number: number }
  | DecisionWaitTarget
  | TimeWaitTarget;

/** The target alone, without lifecycle or parse fields. A bare `#42` keeps an
 *  empty repository, which the server resolves from the task's project. */
export function waitTargetOf(x: WaitTargetLike): WaitTarget {
  if (x.kind === "decision") return { kind: x.kind, decision: x.decision };
  if (x.kind === "time") return { kind: x.kind, at: x.at };
  return { kind: x.kind, repository: x.repository ?? "", pr_number: x.pr_number };
}

// ---------------------------------------------------------------------------
// Blockers and readiness (TG1)
// ---------------------------------------------------------------------------

type RefTask = { short_id?: string | null; _id?: unknown; status?: string | null };

/**
 * What the caller knows about the task a `blocked_by` ref names (a short id,
 * or the `_id` a plan's older rows used):
 *
 * - the row, at least `{ short_id, status }`, so an `_id` ref prints and
 *   dedupes as its short id;
 * - `null`: looked up and not found. It does not block; it is reported missing;
 * - `undefined`: not looked up. It blocks with status `unknown`, so a blocker
 *   outside the caller's page never reads as cleared.
 *
 * Build it with `statusLookup`.
 */
export type StatusOf = (ref: string) => RefTask | null | undefined;

/** One entry of a list row's `graph_status` (convex lib/taskGraph
 *  stampGraphStatus): a blocker or parent ref, and its task's short id and
 *  status, or `status: null` for a ref that names no task. */
export type GraphRefStatus = { ref: string; short_id?: string; status: string | null };

/** The status of a blocker the caller did not look up. Not terminal, so it blocks. */
export const UNKNOWN_BLOCKER_STATUS = "unknown";

/** How many `blocks` and how many `related` tasks one task's graph lists:
 *  the task page, `cast task show` and the server's link reader all stop
 *  here, so every surface names the same tasks. Blockers are read whole —
 *  readiness needs every one. */
export const GRAPH_LINK_CAP = 50;

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
    return p ? p.status ?? null : p;
  };
}

/**
 * The `blocked_by` refs of `tasks` that name none of them: what a caller
 * holding a page has to look up in the database. A ref may be a short id or an
 * `_id` (a plan's older rows name blockers that way), and the caller resolves
 * either, so they come back as one list. Every ref here, and only these, go
 * into `statusLookup`'s `searched`: a ref left unsearched stays unknown and
 * keeps blocking, where one searched and gone reads as missing and clears.
 */
export function blockerRefs(tasks: Iterable<RefTask & { blocked_by?: readonly string[] | null }>): string[] {
  const list = [...tasks];
  const held = statusLookup(list);
  return [...new Set(list.flatMap((t) => t.blocked_by ?? []))].filter((ref) => held(ref) === undefined);
}

/** `status` is `UNKNOWN_BLOCKER_STATUS` when the caller did not look it up. */
export type TaskBlocker = { kind: "task"; ref: string; status: string };
export type MissingTaskBlocker = { kind: "task"; ref: string; missing: true };
/** An open blocker: a task not yet closed, an id that resolves to nothing, or
 *  a wait not met. */
export type Blocker = TaskBlocker | MissingTaskBlocker | TaskWait;

/** A wait on a pull request (merged, or its checks green). */
export function isPrWaitTarget<T extends { kind: string }>(t: T): t is Extract<T, { kind: PrWaitTarget["kind"] }> {
  return t.kind === "pr_merged" || t.kind === "pr_checks_green";
}

/** A wait that failed: it never clears, and keeps blocking. */
export const isFailedWait = (b: Blocker): b is TaskWait => b.kind !== "task" && b.state === "failed";

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
 * task blocker done or dropped, a met wait kept as history. Ordered by what
 * each entry is doing to the task (`blockerBand`), not by where it is stored,
 * since every surface listing them is answering "why is this not moving":
 * failed waits first, then what still holds, then the entries holding nothing.
 * A read-only list (mobile) shows all of these; `blockersHoldingBack` is what
 * still holds the task, in the same order.
 */
export function blockerEntriesOf(task: GraphTask, statusOf: StatusOf): Blocker[] {
  return orderBlockerEntries([...taskBlockerEntries(task, statusOf).map((e) => e.blocker), ...(task.waits ?? [])], (b) => b);
}

/**
 * Which band of a Blocked by list an entry reads in, and so the order every
 * surface lists them in (TG12: `cast task show` prints the web's order):
 *
 * 0. a failed wait — it never clears, so it needs a re-plan, not patience;
 * 1. everything that still holds the task (`holdsBack`);
 * 2. everything that holds nothing: a cleared blocker or met wait kept as
 *    history, and an id naming no task, which is only there to be removed.
 *
 * Storage order (task blockers in `blocked_by` order, then waits by creation)
 * interleaves the three, and a long list then separates "this is why you are
 * stuck" from "this already happened" by a glyph's colour alone — under a
 * verdict word added precisely so the state need not be read off the glyphs.
 */
export function blockerBand(b: Blocker): 0 | 1 | 2 {
  return isFailedWait(b) ? 0 : holdsBack(b) ? 1 : 2;
}

/** `entries` in `blockerBand` order, stable within each band, so storage
 *  order still decides between two entries doing the same thing. `of` reads
 *  the blocker out of a caller's own row (the web's line carries the forms
 *  `blocked_by` names it by), so a surface bands its own list rather than
 *  re-deriving the order from one it threw away. */
export function orderBlockerEntries<T>(entries: readonly T[], of: (e: T) => Blocker): T[] {
  return [...entries].sort((a, b) => blockerBand(of(a)) - blockerBand(of(b)));
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
    const ref = found?.short_id || raw;
    const seen = byRef.get(ref);
    if (seen) {
      if (!seen.raws.includes(raw)) seen.raws.push(raw);
      continue;
    }
    byRef.set(ref, {
      blocker: found === null ? { kind: "task", ref, missing: true } : { kind: "task", ref, status: found?.status || UNKNOWN_BLOCKER_STATUS },
      raws: [raw],
    });
  }
  return [...byRef.values()];
}

/** A task blocker that closed, or a met wait. A missing id is not cleared
 *  (it is reported); it just does not block (`holdsBack`). */
export function isCleared(b: Blocker): boolean {
  return b.kind === "task" ? "status" in b && isTerminalTaskStatus(b.status) : b.state === "met";
}

/** Whether this entry of a Blocked by list holds the task back now: not
 *  cleared, and not a missing id, which is reported but blocks nothing. */
export function holdsBack(b: Blocker): boolean {
  return !isCleared(b) && !(b.kind === "task" && "missing" in b);
}

/**
 * What holds a task back, in `blockerBand` order (a failed wait first, then
 * the rest, each band stable in storage order). Readiness, the CLI's "blocked
 * by" lines, the row tooltip and the task page all render from this one list.
 *
 * A task that closed holds nothing: every unblock path (settleWaits,
 * releaseDependents) stops at a terminal status, so a leftover wait on a done
 * task is history, and a reader that called it blocked would park on something
 * that can never clear. The rule lives here rather than in each caller, so a
 * new reader gets it without knowing to ask; `blockerEntriesOf` still lists
 * every entry, for the surfaces that show that history.
 */
export function blockersHoldingBack(task: GraphTask, statusOf: StatusOf): Blocker[] {
  if (isTerminalTaskStatus(task.status)) return [];
  return blockerEntriesOf(task, statusOf).filter(holdsBack);
}

/** Nothing holds the task: every task in `blocked_by` is done or dropped (or
 *  missing) and every wait is met — or the task itself has closed, which holds
 *  nothing (`blockersHoldingBack`). */
export function isUnblocked(task: GraphTask, statusOf: StatusOf): boolean {
  return !blockersHoldingBack(task, statusOf).length;
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

/** What ready means, in the words of `readinessOf` below, for help text and
 *  tooltips: it reads after "Ready:" or "Tasks ready to start:". */
export const READY_MEANS = "open, out of triage, not superseded or someone else's ephemeral task, no parent being worked, and every blocker cleared (tasks done or dropped, waits met; a failed wait holds until removed)";

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
    if (isTaskBeingWorked(ps)) return { ready: false, reason: "parent_active" };
  }
  const blockers = blockersHoldingBack(task, opts.statusOf);
  return blockers.length ? { ready: false, reason: "blocked", blockers } : { ready: true };
}

export function isReady(task: GraphTask, opts: ReadinessOptions): boolean {
  return readinessOf(task, opts).ready;
}

/** Whether what holds a task in `status` still gates its pickup: true until
 *  someone works it or it closes. */
export function blockerGatesPickup(status: string | null | undefined): boolean {
  return !isTerminalTaskStatus(status) && !isTaskBeingWorked(status);
}

export type WaitTone = WaitState | "dim";

/** How a wait in `state` draws on a task in `status`, each surface mapping
 *  the tone to its own colour: waiting is live only while it gates pickup,
 *  failed ("needs a re-plan") only while the task is open to pickup at all;
 *  past that it holds nothing and draws "dim". `untilClosed` keeps every
 *  unmet wait live until the task closes, for a surface that explains a task
 *  (its page) rather than ranks it for pickup. */
export function waitTone(state: WaitState, status: string | null | undefined, { untilClosed = false } = {}): WaitTone {
  const live =
    state === "met" ? true : untilClosed || state === "failed" ? !isTerminalTaskStatus(status) : blockerGatesPickup(status);
  return live ? state : "dim";
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
  /** Always name the day, a past one too: "Thu 04:13" rather than "04:13". */
  withDay?: boolean;
};

/** "#42", or "owner/repo#42" when `opts` asks for it in full or reads in
 *  another repository. */
export function prRef(w: PrWaitTarget, opts: WaitLabelOptions = {}): string {
  const elsewhere = opts.repository !== undefined && normalizeRepository(w.repository) !== normalizeRepository(opts.repository);
  return opts.fullRef || elsewhere ? `${w.repository}#${w.pr_number}` : `#${w.pr_number}`;
}

/** How a reader in `repository` should see PR refs: bare in that repository,
 *  in full anywhere else, and always in full when no repository is known. */
export function prWords(repository: string | null | undefined): Pick<WaitLabelOptions, "repository" | "fullRef"> {
  return repository ? { repository } : { fullRef: true };
}

/** "09:00", "Thu 09:00" within the coming week, "Oct 14 09:00" past it, with
 *  the year when it is not this one. `withDay` names the day within the past
 *  week too, today's included. `absolute` always prints the date, the year
 *  and the zone. */
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
  if (w.year === n.year && w.month === n.month && w.day === n.day && !opts.withDay) return time;
  const days = (at - now) / 86_400_000;
  if (days < 6 && (days > 0 || (opts.withDay && days > -6))) return `${WEEKDAYS[new Date(Date.UTC(w.year, w.month - 1, w.day)).getUTCDay()]} ${time}`;
  return `${w.year === n.year ? date : `${date}, ${w.year}`} ${time}`;
}

/**
 * The words the SERVER writes a wait's moment in: the stored history line, the
 * "Unblocked" comment, the wake message and a claim's skip reason (TG11). Text
 * stored on one clock and read later in another zone names its instant, so it
 * is absolute. Convex runs on UTC, so `absolute` alone already spells the
 * server's zone there; a client writing for the same readers takes
 * `AGENT_WAIT_WORDS` below, which names that zone outright. One literal, so no
 * two of those surfaces can drift apart.
 */
export const STORED_WAIT_WORDS = { absolute: true } as const satisfies WaitLabelOptions;

/**
 * The words for output read by an AGENT rather than a person: `cast task
 * context`, the compaction block, `cast plan context`, `cast plan export`
 * (TG11). They must name a moment exactly as the stored surfaces above do, and
 * those are written on the server, whose clock is UTC. `absolute` alone takes
 * the runtime's zone, so a CLI off UTC would spell one instant two ways on one
 * screen — and in a spelling (`GMT+5:30`) `STORED_TIME` below cannot read back.
 * This is `STORED_WAIT_WORDS` with that zone named; spread the checkout's
 * `prWords` over it for PR refs.
 */
export const AGENT_WAIT_WORDS = { ...STORED_WAIT_WORDS, timeZone: "UTC" } as const satisfies WaitLabelOptions;

const STORED_TIME = new RegExp(`\\b(${MONTHS.join("|")}) (\\d{1,2}), (\\d{4}) (\\d{2}):(\\d{2}) UTC\\b`);

/** The first `absolute` time in stored text ("Oct 11, 2026 09:26 UTC", the
 *  server's zone), so a reader can show it in its own zone. Null when the text
 *  names none, or names one in another zone. `localWaitTimes` below is the one
 *  reader: every surface wants the whole line rewritten, not one offset. */
function findStoredWaitTime(text: string): { at: number; start: number; end: number } | null {
  const m = STORED_TIME.exec(text);
  if (!m) return null;
  const at = Date.UTC(Number(m[3]), MONTHS.indexOf(m[1]!), Number(m[2]), Number(m[4]), Number(m[5]));
  return { at, start: m.index, end: m.index + m[0].length };
}

/** A whole absolute wait spelling and nothing else, as `formatWaitTime` with
 *  `absolute` writes it: "Oct 9, 2026 07:00 UTC", or another zone's short name
 *  when the writer was not on UTC. */
const WHOLE_STORED_TIME = new RegExp(`^(${MONTHS.join("|")}) (\\d{1,2}), (\\d{4}) (\\d{2}):(\\d{2}) (\\S+)$`);

/**
 * One absolute wait spelling read back as the blocker ref that names the same
 * moment ("Oct 9, 2026 07:00 UTC" → "2026-10-09T07:00Z"), and null for text
 * that is not one. It exists because that spelling is the only one every agent
 * surface prints a time wait in (AGENT_WAIT_WORDS, TG11), so it is the one a
 * reader pastes back into `--remove-blocked-by` — and it carries a comma, which
 * a ref list is otherwise split on. `ref` is null when the zone is not the
 * server's UTC: a short name ("BST", "GMT+5:30") does not fix an instant, so
 * the caller asks for the ref form rather than guessing at an offset.
 */
export function readStoredWaitTime(text: string): { ref: string | null } | null {
  const m = WHOLE_STORED_TIME.exec((text ?? "").trim());
  if (!m) return null;
  if (!/^(UTC|GMT)$/.test(m[6]!)) return { ref: null };
  const month = String(MONTHS.indexOf(m[1]!) + 1).padStart(2, "0");
  return { ref: `${m[3]}-${month}-${m[2]!.padStart(2, "0")}T${m[4]}:${m[5]}Z` };
}

/** Whether `text` names an absolute stored wait moment at all, which for
 *  nearly every line and comment it does not. A reader asks before it
 *  subscribes to a clock to rewrite one: `localWaitMoments` on text naming
 *  none is a no-op, so a list that subscribed anyway would re-render every
 *  minute for nothing. */
export function hasStoredWaitTime(text: string): boolean {
  return findStoredWaitTime(text) !== null;
}

/**
 * Stored text (a history line, a comment, a wake message) with every absolute
 * wait time in it re-rendered for the reader's clock: the server writes UTC so
 * the moment survives any zone (TG11), and a reader that also shows live waits
 * would otherwise carry two spellings of one moment on one screen. Text naming
 * no stored time comes back unchanged, with `stored` empty.
 *
 * `stored` is the spellings that were replaced, and nothing else, so a reader
 * can show exactly what was written without carrying the whole body around:
 * a surface that hung the ORIGINAL text on a tooltip gave a long comment that
 * happened to name one moment a browser tooltip of the entire comment.
 */
export function localWaitMoments(text: string, opts: WaitLabelOptions = {}): { text: string; stored: string[] } {
  let out = "";
  let rest = text;
  const stored: string[] = [];
  for (let t = findStoredWaitTime(rest); t; t = findStoredWaitTime(rest)) {
    stored.push(rest.slice(t.start, t.end));
    out += rest.slice(0, t.start) + formatWaitTime(t.at, opts);
    rest = rest.slice(t.end);
  }
  return { text: out + rest, stored };
}

/** `localWaitMoments`'s text alone, for a caller with nowhere to show the
 *  stored spelling. */
export function localWaitTimes(text: string, opts: WaitLabelOptions = {}): string {
  return localWaitMoments(text, opts).text;
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

/** `lower` starts the phrase lowercase, for the middle of a sentence. */
type WaitingLabelOptions = WaitLabelOptions & { lower?: boolean };

/** The timeline's phrase for a wait being set (TG11): "Waiting on PR #42",
 *  "Waiting until Thu 09:00". History writers pass `absolute`, since the line
 *  is stored and read in other zones. */
export function waitingOnLabel(w: WaitTarget, opts: WaitingLabelOptions = {}): string {
  return `${opts.lower ? "waiting " : WAITING}${waitClause(w, opts)}`;
}

/** The same phrase for anything holding a task: "Waiting on ct-12",
 *  "Waiting on PR #42 (failed: closed without merging)", "Waiting until
 *  Oct 6 12:00 (overdue by 3d)". The suffixes are `blockerLabel`'s, in its
 *  order: this phrase is what a surface with no state marker beside it says
 *  (the row mark's whole tooltip, the parking line), so a moment three days
 *  gone must not read here exactly like one still to come (`overdueSuffix`). */
export function blockerWaitingLabel(b: Blocker, opts: WaitingLabelOptions = {}): string {
  return b.kind === "task" ? `${opts.lower ? "waiting " : WAITING}on ${blockerLabel(b)}` : `${waitingOnLabel(b, opts)}${overdueSuffix(b, opts)}${failedSuffix(b)}`;
}

/** What cleared a met wait, for "Unblocked: …": "PR #42 merged", "sd-4
 *  answered: Ship it" (a decision's note carries the answer). */
export function waitMetCause(w: TaskWait, opts: WaitLabelOptions = {}): string {
  return w.kind === "decision" && w.note ? `${w.decision} ${w.note}` : waitMetLabel(w, opts);
}

/** What tells a checks wait from a merge wait on the same pull request:
 *  `waitRemoveRef` writes it onto the ref, `waitRefLine` repeats it on a
 *  closed task's line where the state word is suppressed, and `CHECKS_SUFFIX`
 *  reads it back (with `:ci` as an alias). One spelling, so the three agree. */
const CHECKS_REF_SUFFIX = ":checks";

/** What `--remove-blocked-by` takes to remove this wait: its ref
 *  ("owner/repo#42", "owner/repo#42:checks", "sd-4"), or a time wait's id,
 *  since a relative time names a new moment each time it is read. */
export function waitRemoveRef(w: TaskWait): string {
  switch (w.kind) {
    case "pr_merged": return `${w.repository}#${w.pr_number}`;
    case "pr_checks_green": return `${w.repository}#${w.pr_number}${CHECKS_REF_SUFFIX}`;
    case "decision": return w.decision;
    case "time": return w.id;
  }
}

/** A moment as a ref `--remove-blocked-by` reads back as the same moment on
 *  any machine: UTC, pinned with `Z`. A zoneless time is wall time in the
 *  caller's zone (parseWaitTime), so an agent shown the stored absolute
 *  ("Oct 9, 2026 05:02 UTC") and writing it back bare matches nothing off
 *  UTC. Minutes, or seconds when the moment names any, which the minute
 *  `sameWaitTarget` allows either way. */
export function waitTimeRef(at: number): string {
  const iso = new Date(at).toISOString();
  return `${iso.slice(0, iso.endsWith(":00.000Z") ? 16 : 19)}Z`;
}

/**
 * What a removal that matched no wait says: "ct-1 has no wait on acme/api#6;
 * cast task show ct-1 lists its waits". `what` names the handle the caller
 * gave ("on acme/api#6", "with id w1abc"), and `tail` replaces the pointer
 * when a kind has a better one (a time wait, removable by its id or by the
 * moment it names). The server throws these words and the CLI prints them for
 * an older server, so the sentence has one home here rather than a copy per
 * package.
 */
export function noWaitOnLine(shortId: string, what: string, tail?: string): string {
  return `${shortId} has no wait ${what}${tail ?? `; cast task show ${shortId} lists its waits`}`;
}

/** What an agent does about failed waits on `shortId`, which never clear:
 *  "remove it (cast task dep ct-1 --remove-blocked-by sd-4) or replace it
 *  (add the new wait with cast task dep ct-1 --blocked-by; …), or change the
 *  approach, …". addWaitCore drops a failed wait when one is added on its target. */
export function failedWaitAdvice(shortId: string, waits: readonly TaskWait[]): string {
  const it = waits.length === 1 ? "it" : "them";
  return `remove ${it} (${removeWaitCommands(shortId, waits)}) or replace ${it} (add the new wait with cast task dep ${shortId} --blocked-by; a wait on the same target takes the failed one's place), or change the approach, and say on the task what you decided.`;
}

/** The `--remove-blocked-by` command for each wait, joined: what every surface
 *  that tells an agent to drop waits hands it. */
function removeWaitCommands(shortId: string, waits: readonly TaskWait[]): string {
  return waits.map((w) => `cast task dep ${shortId} --remove-blocked-by ${waitRemoveRef(w)}`).join("; ");
}

/**
 * What an agent does about time waits whose moment went by unsettled
 * (`isStalledTimeWait`): nothing is coming to clear them. Unlike a failed
 * wait, one still `waiting` is not replaceable (`waitIsReplaceable`), so a
 * wait added for a new moment would leave this one holding — it has to go
 * first, and only then can a new one take over.
 */
export function stalledWaitAdvice(shortId: string, waits: readonly TaskWait[]): string {
  const it = waits.length === 1 ? "it" : "them";
  return `remove ${it} (${removeWaitCommands(shortId, waits)}) and, if the work still has to wait, add the new wait with cast task dep ${shortId} --blocked-by, or change the approach, and say on the task what you decided.`;
}

/** Why a stalled time wait holds forever (`isStalledTimeWait`), in the one
 *  place every surface reads it from: the resume block's parking line, `cast
 *  plan`'s readiness lines and the task page's hint all lead with it, and the
 *  commands or the words that follow are each surface's own. `count` because
 *  the diagnosis has to agree in number with the remedy each surface puts
 *  after it, and with the lines above it. `lower` is for a line that runs it
 *  on after an id ("ct-1: a wait whose moment…"). */
export function stalledWaitDiagnosis(opts: { count?: number; lower?: boolean } = {}): string {
  const s = (opts.count ?? 1) === 1
    ? "A wait whose moment has gone by was never settled, so no wake is coming"
    : "Waits whose moments have gone by were never settled, so no wake is coming";
  return opts.lower ? `${s[0]!.toLowerCase()}${s.slice(1)}` : s;
}

/** Why a failed wait holds forever (`isFailedWait`), the failed twin of
 *  `stalledWaitDiagnosis` and read from here by every surface that leads with
 *  it: the task page's hint and the resume block's parking line. `count` for
 *  the same reason — a PR closing fails its merge wait and its checks wait
 *  together, and a singular diagnosis over a plural remedy names neither. */
export function failedWaitDiagnosis(count: number): string {
  return count === 1 ? "A failed wait never clears" : "Failed waits never clear";
}

/**
 * What a PAGE says under its Blocked by lines about a wait nothing will
 * settle: a failed one, which never clears (TG2), and a time wait whose
 * moment went by unsettled, which no wake is coming for
 * (`isStalledTimeWait`). Both are "still waiting, nothing coming", and the
 * remedy is the same, so the row says it once per kind rather than per line.
 *
 * The diagnosis half is the shared sentence (`stalledWaitDiagnosis`,
 * `failedWaitDiagnosis`), so a page and an agent read the same verdict; only
 * the remedy differs, because a page has no room for the commands and offers
 * the add directly below instead. `count` because the sentence has to agree
 * in number with the lines above it — a PR closing fails its merge wait and
 * its checks wait together, and "remove it" would then name neither.
 */
export function lostWaitAdvice(kind: "failed" | "stalled", count: number): string {
  const remedy = count === 1 ? "remove it, or add a new blocker in its place" : "remove them, or add new blockers in their place";
  return `${kind === "stalled" ? stalledWaitDiagnosis({ count }) : failedWaitDiagnosis(count)}: ${remedy}.`;
}

/** What ended a wait that failed: "PR owner/repo#6 closed without merging",
 *  "sd-4 dismissed". A stored comment's writer passes `absolute`. */
export function waitFailedCause(w: TaskWait, opts: WaitLabelOptions = {}): string {
  return `${waitSubject(w, opts)} ${w.note || waitFailedWord(w.kind)}`;
}

/** What a wait is on, bare: "PR #42", "sd-4", "Thu 09:00". The piece
 *  `waitRefLine` and `waitFailedCause` build their lines on, and the subject a
 *  surface that prints the predicate separately shows: the task page puts it
 *  in its pill and the phone in its line, both with `waitStateWord` beside it,
 *  so neither spells one wait's predicate twice. Pass a known kind
 *  (`isWaitKind`): a newer one falls into the PR branch. */
export function waitSubject(w: WaitTarget, opts: WaitLabelOptions = {}): string {
  return w.kind === "decision" ? w.decision : w.kind === "time" ? formatWaitTime(w.at, opts) : `PR ${prRef(w, opts)}`;
}

/**
 * What a wait that still holds is waiting FOR, in words no met wait could also
 * read as (TG12): "PR #42 to merge", "PR #42 checks to go green", "sd-412 to
 * be answered", "until Thu 09:00". `waitLabel`'s present tense ("checks green
 * on #42", "sd-412 answered") is the same string `waitMetLabel` returns for
 * those kinds, which only reads right where the state is printed separately (a
 * node title, a bracketed `waitRefLine`); a bare "blocked by" list has no room
 * for one, so it takes these words instead.
 */
function waitHoldingLabel(w: WaitTarget, opts: WaitLabelOptions & ChecksOption = {}): string {
  return w.kind === "time" ? waitClause(w, opts) : `${waitSubject(w, opts)} ${checksWord(w, opts) || WAIT_PENDING_WORD[w.kind]}`;
}

/**
 * One wait in its current state, as the timeline stores it and the plan
 * graph titles it: "Waiting on PR #42", "PR #42 merged", "Wait on PR #51,
 * already merged" (met when it was set), "Wait on PR #6 failed: closed
 * without merging". `waitLineParts` reads it back.
 */
export function waitLine(w: TaskWait, opts: WaitLabelOptions = {}): string {
  if (w.state === "waiting") return waitingOnLabel(w, opts);
  if (w.state === "failed") return `Wait ${waitClause(w, opts)} failed${w.note ? `: ${w.note}` : ""}`;
  return metAtOnce(w) ? `Wait ${waitClause(w, opts)}, ${w.note || waitMetNote(w.kind, { atOnce: true })}` : waitMetCause(w, opts);
}

/** A met wait was met the moment it was set: its note says so ("already
 *  merged"). A settle can land in the same millisecond as the add, so the
 *  clocks decide only for a wait stored without a note. */
function metAtOnce(w: TaskWait): boolean {
  return w.note ? w.note.startsWith(`${ALREADY} `) : w.settled_at === w.created_at;
}

/** How a failed wait was stored before the clause was kept: the whole suffix
 *  of "PR #6 merges (failed: closed without merging)". Anchored at the end,
 *  and only over the two shapes that form ever took, because the one line
 *  reaching this pattern otherwise is a met wait's, whose note is free text a
 *  person wrote: a decision answered "Ship it (failed to repro on main)" must
 *  not read back as a wait that failed. */
const LEGACY_FAILED_SUFFIX = /\(failed(?::[^)]*)?\)$/;

/** A stored `waitLine` read back: its state, the clause ("on PR #42") when
 *  the line names it, and a settled wait's note. Lines stored before the
 *  clause was kept ("PR #6 merges (failed: …)") read as their state alone. */
export function waitLineParts(line: string): { state: WaitState; clause?: string; note?: string } {
  if (line.startsWith(WAITING)) return { state: "waiting", clause: line.slice(WAITING.length) };
  const failed = /^Wait (.+?) failed(?:: ([\s\S]*))?$/.exec(line);
  if (failed) return { state: "failed", clause: failed[1], ...(failed[2] ? { note: failed[2] } : {}) };
  const atOnce = new RegExp(`^Wait (.+), (${ALREADY}\\b[\\s\\S]*)$`).exec(line);
  if (atOnce) return { state: "met", clause: atOnce[1], note: atOnce[2] };
  return { state: LEGACY_FAILED_SUFFIX.test(line) ? "failed" : "met" };
}

/**
 * The heading over a Blocked by list. One wording for the CLI's section, the
 * task page's row and the phone's, because TG12's claim about these words is
 * that the three surfaces say the same thing; the CONDITION stays each
 * surface's own (the CLI asks whether anything still holds the task, the web
 * and the phone whether the task itself is terminal). A list with nothing
 * holding is headed "cleared": the verdict word is suppressed there, and a
 * wait left unsettled on a closed task has no state word, so without the
 * heading a done task's dim hourglass reads as a live wait.
 */
export function blockedByLabel(holds: boolean): string {
  return holds ? "Blocked by" : "Blocked by (cleared)";
}

/**
 * The heading over a Blocks list, the same edge from the other side (TG12).
 * It takes `blockedByLabel`'s hazard with it: a terminal task holds nothing,
 * so every task it names is free of it, and a bare "Blocks" over rows carrying
 * their own live `[open]` status reads as a task still holding work back —
 * which is exactly what the drop that closed it had just printed was no longer
 * true ("Unblocked: ct-9"). One wording for the CLI's section, the task page's
 * row and the phone's; the CONDITION stays each surface's own, as there too.
 */
export function blocksLabel(holds: boolean): string {
  return holds ? "Blocks" : "Blocks (cleared)";
}

/** The verdict the task page and the phone print once every line of a Blocked
 *  by list is cleared, so the reader reads it rather than inferring it from
 *  the glyphs (`isUnblocked`, TG12). The web says this where the CLI says
 *  "ready", because `readiness` already names the line's grounding verdict. */
export const UNBLOCKED_WORD = "unblocked";

/** The words shown for a task blocker whose id names no task, and for one
 *  whose status is UNKNOWN_BLOCKER_STATUS (the caller did not look it up). */
export const BLOCKER_NOT_FOUND_WORDS = "not found";
export const BLOCKER_UNKNOWN_WORDS = "status unknown";

/** The words for a task (a blocker, a link) whose status cannot be shown, or
 *  undefined for one whose status is known. */
export function blockerStateLabel(b: { missing?: boolean; status?: string }): string | undefined {
  if (b.missing) return BLOCKER_NOT_FOUND_WORDS;
  return !b.status || b.status === UNKNOWN_BLOCKER_STATUS ? BLOCKER_UNKNOWN_WORDS : undefined;
}

/** One line for any blocker, with no room for a state marker beside it, so
 *  the words carry the state themselves: "ct-12", "ct-12 (not found)", "ct-12
 *  (status unknown)", "PR #42 to merge", "sd-412 to be answered", "PR #7 to
 *  merge (failed: closed without merging)". Every text "blocked by" list is
 *  this function, and it is read cold, so a wait that still holds never takes
 *  `waitLabel`'s present tense, which for two kinds is the met wording
 *  verbatim. A met wait reads as met, for the surfaces that list history.
 *  `checks` is this wait's PR's `checks_state` when the caller holds it: a
 *  list read cold has no state marker to carry red CI, so the words do
 *  ("PR #42 checks failing"), and the surfaces reading this are the ones that
 *  tell an agent to park (the resume block's Blocked by, `cast task start`). */
export function blockerLabel(b: Blocker, opts: WaitLabelOptions & ChecksOption = {}): string {
  if (b.kind === "task") {
    const state = blockerStateLabel(b);
    return state ? `${b.ref} (${state})` : b.ref;
  }
  return `${b.state === "met" ? waitMetLabel(b, opts) : waitHoldingLabel(b, opts)}${overdueSuffix(b, opts)}${failedSuffix(b)}`;
}

/**
 * Several blocker labels as one list ("ct-12, PR #42 to merge"). A time wait's
 * absolute spelling carries a comma of its own ("until Oct 9, 2026 10:13
 * UTC"), so a plain ", " join loses the item boundaries: `blocked by: ct-77,
 * until Oct 9, 2026 10:13 UTC` reads as three blockers. The comma is already
 * treated as a hazard on INPUT (the CLI's `splitRefs` rejoins the spelling
 * wherever it sits in a ref list), and this is the same hazard on output.
 *
 * The entry carrying the comma is parenthesised rather than the whole list
 * re-separated with "; ", because these lists nest: `stuckNote` joins one
 * task's note to the next with "; ", so a "; " inside `notReadyLabel`'s own
 * list would collapse the two levels into one. A single entry has no boundary
 * to lose and keeps its bare words.
 */
export function blockerList(labels: readonly string[]): string {
  if (labels.length < 2) return labels.join("");
  return labels.map((l) => (l.includes(",") ? `(${l})` : l)).join(", ");
}

/** " (overdue by 3d)" after a time wait whose moment has gone by unsettled,
 *  else "". These lists carry no state marker (the bracket `waitRefLine` fills
 *  is what the task page has and they do not), so "until Oct 6, 2026 12:00
 *  UTC" on a moment three days gone reads exactly like a wait still to come —
 *  and the surfaces reading it are the ones that tell an agent to park on it
 *  (the resume block's Blocked by, `cast task start`, `cast task ls`'s blocked
 *  tag), where a settle job that never fired must not read as normal. A moment
 *  still ahead needs no word: its own timestamp says it is pending, and
 *  `waitStateWord`'s "in 2h" would only repeat it. */
function overdueSuffix(w: TaskWait, opts: WaitLabelOptions): string {
  if (w.kind !== "time" || w.state !== "waiting") return "";
  const now = opts.now ?? Date.now();
  return w.at <= now ? ` (${waitStateWord(w, { now })})` : "";
}

/** How late a time wait has to be before a surface stops reading it as a
 *  settle still on its way: two turns of the 15-minute sweep that settles
 *  overdue waits (convex/crons.ts), which is itself the cover for a scheduled
 *  settle that never ran or threw. Inside that window
 *  the wake is merely imminent, which is why `overdueSuffix` marks lateness
 *  from the first minute and this does not. */
const SETTLE_GRACE_MS = 30 * 60_000;

/** A time wait whose moment went by long enough ago that its scheduled settle
 *  and the sweep behind it both should have landed: nothing is going to clear
 *  it, so a session parked on it would never be woken (`parkingLine` sends the
 *  agent to remove or replace it instead of going dormant). */
export function isStalledTimeWait(b: Blocker, opts: { now?: number } = {}): b is TaskWait {
  return b.kind === "time" && b.state === "waiting" && b.at <= (opts.now ?? Date.now()) - SETTLE_GRACE_MS;
}

/** One linked task: "ct-12 Design schema [done]" ("ct-12 [open]" when the
 *  reader may not see its title), or what is known of it: "ct-12 (not
 *  found)", "ct-12 (status unknown)". A title is foreign text, so a reader
 *  that feeds the line to an agent passes `inline` to clean it. */
export function taskRefLine(t: { short_id: string; title?: string; status?: string; missing?: boolean }, inline: (s: string) => string = (s) => s): string {
  const state = blockerStateLabel(t);
  return state ? `${t.short_id} (${state})` : `${t.short_id}${t.title !== undefined ? ` ${inline(t.title)}` : ""} [${t.status}]`;
}

/** A task blocker with the title its reader may see, as `tasks.get` and
 *  `context` send `links.blocked_by` and the resume block lists them. */
export type TitledTaskBlocker = (TaskBlocker | MissingTaskBlocker) & { title?: string };

/** One task blocker as `taskRefLine` prints it. On a `closed` task a blocker
 *  that still holds by its own status gets the marker its waits get
 *  (`waitRefLine`): a closed task waits on nothing (TG1), and `[in_review]`
 *  alone under a "Blocked by (cleared)" heading reads exactly like a live
 *  hold, which is the one entry type whose bracket is otherwise unchanged. */
export function taskBlockerLine(b: TitledTaskBlocker, inline?: (s: string) => string, opts: { closed?: boolean } = {}): string {
  const line = taskRefLine({ ...b, short_id: b.ref }, inline);
  // Only the bracketed status form is marked: a missing or unknown blocker
  // reads "(not found)" / "(status unknown)" and holds nothing to contradict.
  return opts.closed && holdsBack(b) && line.endsWith("]") ? `${line.slice(0, -1)}, history]` : line;
}

/**
 * One wait as a text "Blocked by" list prints it: what it waits on, its state
 * word, and its state in the same brackets `taskRefLine` puts a task's status
 * in. A mixed list is read cold, where a met wait's word differs from a
 * waiting one's only by tense ("checks green" vs "checks to go green"), so
 * every entry carries the marker that says whether it still holds: "PR #42 to
 * merge [waiting]", "PR #42 checks green [met]", "PR #7 closed without
 * merging [failed]". A page with a pill per wait shows the state in its tone
 * instead (`waitTone`, `waitWordFails`). `inline` cleans the word for a
 * reader that feeds the line to an agent.
 *
 * Two kinds of line need more than the bare word. A time wait's subject is
 * already a moment, so its countdown is parenthesized ("Oct 9, 2026 05:25 UTC
 * (in 3h)") rather than run on into one unreadable timestamp; every other kind
 * reads as subject plus predicate on its own. And on a `closed` task a wait
 * that never settled holds nothing — `waitStateWord` returns no word for it —
 * so the marker says `history`, because `waiting` there would contradict the
 * "(cleared)" heading the same screen prints above it. That word is also the
 * only thing telling a merge wait from a checks wait on the same PR, so where
 * it is suppressed the subject carries the same `CHECKS_REF_SUFFIX` the wait's
 * removal ref does (`waitRemoveRef`): the two entries stay apart, and each
 * line names the handle `--remove-blocked-by` takes to clear it.
 */
export function waitRefLine(w: TaskWait, opts: WaitLabelOptions & ChecksOption & { closed?: boolean; inline?: (s: string) => string } = {}): string {
  const inline = opts.inline ?? ((s: string) => s);
  const word = inline(waitStateWord(w, opts));
  const countdown = w.kind === "time" && w.state === "waiting";
  const history = Boolean(opts.closed) && w.state === "waiting";
  const subject = `${waitSubject(w, opts)}${history && w.kind === "pr_checks_green" ? CHECKS_REF_SUFFIX : ""}`;
  return `${subject}${word ? ` ${countdown ? `(${word})` : word}` : ""} [${history ? "history" : w.state}]`;
}

/** Why a task is not ready, in words an agent can act on: "blocked by ct-12,
 *  PR #42 to merge", "its parent is being worked" — a holding wait reads as
 *  what it waits FOR (`blockerLabel`), never in the present tense a met one
 *  shares. `task` is the row judged. */
export function notReadyLabel(task: GraphTask, r: Extract<Readiness, { ready: false }>, opts: WaitLabelOptions = {}): string {
  switch (r.reason) {
    case "status": return `already ${task.status}`;
    case "triage": return "not triaged";
    case "superseded": return task.superseded_by ? `superseded by ${task.superseded_by}` : "superseded";
    case "ephemeral": return `bookkeeping of the ${task.created_from_conversation ? "session" : "person"} that filed it`;
    case "parent_active": return "its parent is being worked";
    case "parent_unknown": return "its parent could not be read";
    case "blocked": return `blocked by ${blockerList((r.blockers ?? []).map((b) => blockerLabel(b, opts)))}`;
  }
}

/** " (failed: closed without merging)" after a failed wait's label, else "". */
function failedSuffix(w: Pick<TaskWait, "state" | "note">): string {
  return w.state === "failed" ? ` (failed${w.note ? `: ${w.note}` : ""})` : "";
}

/** How `waitStateWord` names a time wait whose moment went by unsettled. */
const OVERDUE_BY = "overdue by";

/** `waitStateWord`'s word for a wait that is still waiting: "to merge", and
 *  the words `blockerLabel` renders a holding wait with. A time wait has none;
 *  its word is a countdown, and `waitHoldingLabel` keeps its "until". */
const WAIT_PENDING_WORD: Record<WaitKind, string> = {
  pr_merged: "to merge",
  pr_checks_green: "checks to go green",
  decision: "to be answered",
  time: "",
};

/** The word for a met wait: the note its settle writes, and what a page shows
 *  for one met without a note. */
const WAIT_MET_WORD: Record<WaitKind, string> = {
  pr_merged: "merged",
  pr_checks_green: "checks green",
  decision: "answered",
  time: "passed",
};

/** How the note of a wait met the moment it was set starts; `waitLineParts`
 *  finds that note by it. */
const ALREADY = "already";

/** The note a settle writes on a met wait: "merged", "answered: Ship it".
 *  `atOnce` is for a wait met the moment it was set: "already merged",
 *  "already green", "already answered: Ship it". */
export function waitMetNote(kind: WaitKind, opts: { atOnce?: boolean; answer?: string } = {}): string {
  const word = opts.atOnce ? `${ALREADY} ${kind === "pr_checks_green" ? "green" : WAIT_MET_WORD[kind]}` : WAIT_MET_WORD[kind];
  return opts.answer ? `${word}: ${opts.answer}` : word;
}

/** The note a settle writes when a wait can no longer be met, and what a page
 *  shows for one failed without a note. `outcome` is what ended it: the PR's
 *  state ("merged", "closed") or the decision's ("dismissed", "withdrawn"). */
export function waitFailedWord(kind: WaitKind, outcome?: string): string {
  switch (kind) {
    case "pr_merged": return "closed without merging";
    case "pr_checks_green": return outcome ? `${outcome} before its checks went green` : "can no longer go green";
    case "decision": return outcome ?? "will not be answered";
    case "time": return "can no longer be met";
  }
}

/** A surface that holds the `checks_state` of a checks wait's PR passes it, so
 *  the wait reads by what its CI is actually doing. Per wait, never part of
 *  `WaitLabelOptions`: one task can hold two checks waits in different states,
 *  and a caller reads them from `links.wait_checks` by wait id. */
export type ChecksOption = { checks?: string | null };

/** How a still-waiting checks wait reads when its PR's `checks_state` is
 *  known: "checks failing", "checks running", or "" for every other wait and
 *  for a state that says nothing new. The one home for those words, because
 *  red CI has to read the same in a pill, in a bracketed `waitRefLine` and in
 *  a bare "blocked by" list: TG2 keeps a red wait waiting forever, so a
 *  surface that worded it "checks to go green" would park an agent on
 *  something only a new push can clear. */
function checksWord(w: { kind: WaitKind }, opts: ChecksOption): string {
  if (w.kind !== "pr_checks_green") return "";
  return opts.checks === "failure" ? "checks failing" : opts.checks === "pending" ? "checks running" : "";
}

/** The word after a wait's pill, on every surface: a settled wait's note or
 *  its state's word, a pending one's ("to merge"), a time wait's countdown
 *  ("in 2h", "any moment", "overdue by 3d"). A past moment is named as overdue
 *  rather than imminent: the pill beside it already shows that moment, so
 *  "any moment" there would read as normal when the settle job is in fact
 *  lost. Empty for one still waiting on a `closed` task,
 *  which waits for nothing. `checks`, the PR's `checks_state` when the caller
 *  holds it, says why a checks wait is still waiting: red checks keep it
 *  waiting (TG2). */
export function waitStateWord(w: TaskWait, opts: { now?: number; closed?: boolean } & ChecksOption = {}): string {
  if (w.state === "met") return w.note || WAIT_MET_WORD[w.kind];
  if (w.state === "failed") return w.note || waitFailedWord(w.kind);
  if (opts.closed) return "";
  const checks = checksWord(w, opts);
  if (checks) return checks;
  if (w.kind !== "time") return WAIT_PENDING_WORD[w.kind];
  const now = opts.now ?? Date.now();
  const left = relTimeUntil(w.at, now);
  if (left !== "now") return `in ${left}`;
  const late = relTimeShort(w.at, now);
  return late === "now" ? "any moment" : `${OVERDUE_BY} ${late}`;
}

/** The PR whose `checks_state` a surface must read to word this wait, or null
 *  when it needs none: only a checks wait still waiting, with a resolved
 *  repository, on a task that has not closed, can say "checks failing" or
 *  "checks running" (TG2). One rule, so the task page, the phone and any
 *  later surface fetch for the same waits. */
export function checksWaitPr(w: TaskWait, opts: { closed?: boolean } = {}): PrWaitTarget | null {
  if (opts.closed || w.kind !== "pr_checks_green" || w.state !== "waiting" || !w.repository) return null;
  return { kind: w.kind, repository: w.repository, pr_number: w.pr_number };
}

/** Whether `waitStateWord` reads red on a page: the wait failed, or its PR's
 *  checks are failing, while the task is open. Every other word is dim; the
 *  glyph keeps the wait's own tone (`waitTone`). */
export function waitWordFails(w: TaskWait, opts: { closed?: boolean } & ChecksOption = {}): boolean {
  if (opts.closed) return false;
  return w.state === "failed" || (w.state === "waiting" && w.kind === "pr_checks_green" && opts.checks === "failure");
}

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
  /** `unrecognized`: the text has no blocker's shape at all, so a surface
   *  listing the forms can show those instead of `error`'s own list. */
  | { ok: false; error: string; unrecognized?: true };

const TASK_REF = /^ct-(\d+)$/i;
const DECISION_REF = /^sd-(\d+)$/i;
const CHECKS_SUFFIX = new RegExp(`(${CHECKS_REF_SUFFIX}|:ci)$`, "i");
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
  /** Take a time already past: a met time wait stays as history (TG2), and
   *  removing it names its time. */
  allowPast?: boolean;
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
  const { now = Date.now(), timeZone, allowPast } = typeof opts === "number" ? { now: opts } : opts;
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

  const time = parseWaitTime(text, now, timeZone);
  if (time) {
    // A text written as a time but naming no moment had the right grammar, so
    // it is refused for what is wrong with it, never with the grammar list.
    if ("error" in time) return { ok: false, error: time.error };
    if (time.at <= now && !allowPast) return { ok: false, error: pastTimeError(text, time.at, now, timeZone) };
    return { ok: true, kind: "time", at: time.at };
  }

  return {
    ok: false,
    unrecognized: true,
    error: `"${text}" is not a blocker: use a task (ct-12), a PR (#42, owner/repo#42, a PR URL, add :checks for CI), a decision (sd-4), a duration (30m, 2h, 3d, 1w) or a date (2026-10-14, 2026-10-14T09:00)`,
  };
}

/** What a text written as a time came to: the moment, or why that text names
 *  none. `null` is "not a time at all", which the grammar list answers; an
 *  `error` is a time whose shape was right and whose value is impossible, and
 *  telling those apart is what keeps a writer of Feb 30 from being sent back
 *  to a grammar they already got right. */
type WaitTimeParse = { at: number } | { error: string } | null;

/** A duration from `now`, or an ISO date or datetime; null when it is neither. */
function parseWaitTime(text: string, now: number, timeZone: string | undefined): WaitTimeParse {
  if (/^\d/.test(text) && !/^\d{4}-/.test(text)) {
    try { return { at: now + parseDuration(text) }; } catch { return null; }
  }
  const m = ISO_TIME.exec(text);
  if (!m) return null;
  const [y, mo, d, h = 0, mi = 0, s = 0] = m.slice(1, 7).map((x) => (x === undefined ? undefined : Number(x)));
  // Date.UTC rolls Feb 30 over to March 2 and 24:00 to the next day, so refuse what is not a real moment.
  const wall = Date.UTC(y!, mo! - 1, d!, h, mi, s, Math.round(Number(m[7] ?? 0) * 1000));
  const back = new Date(wall);
  // Read smallest part first, because an overflowing one carries into the next
  // ("09:60" moves the hour, "T24:00" the day, "02-30" the month), and the part
  // the writer got wrong is the innermost one that does not read back.
  const impossible = s > 59 ? "second (0-59)"
    : back.getUTCMinutes() !== mi ? "minute (0-59)"
    : back.getUTCHours() !== h ? "hour (0-23)"
    : back.getUTCDate() !== d ? "day of the month"
    : back.getUTCMonth() !== mo! - 1 ? "month (1-12)"
    : null;
  if (impossible) return { error: `"${text}" is not a real moment: check its ${impossible}` };
  if (m[8]?.toUpperCase() === "Z") return { at: wall };
  if (m[9]) {
    const [oh, om] = [Number(m[10]), Number(m[11])];
    // Real offsets run from -12:00 to +14:00, so the refusal below can name that range.
    const mins = (oh * 60 + om) * (m[9] === "-" ? -1 : 1);
    if (om > 59 || mins < -12 * 60 || mins > 14 * 60) {
      return { error: `"${text}" names no real zone offset: offsets run from -12:00 to +14:00` };
    }
    return { at: wall - mins * 60_000 };
  }
  return { at: wallTimeIn(wall, timeZone) };
}

/** A zone's offset at one moment, spelled the way a blocker ref takes it
 *  ("+05:30"), so the refusal below can hand back the text that pins it. */
function zoneOffsetAt(at: number, timeZone: string): string {
  const w = wallClock(at, timeZone);
  const mins = Math.round((Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - (at - (at % 1000))) / 60_000);
  const abs = Math.abs(mins);
  return `${mins < 0 ? "-" : "+"}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

/**
 * Why a time was refused for being past. A moment that lost to the clock is
 * either the wrong date or the right one read in a zone the writer did not
 * mean, and "is in the past" alone tells an agent neither, so it retries the
 * same literal or guesses an offset. The line names what the text was read
 * as, the zone it was read in, the clock it lost to, and — for a wall time
 * that carried no zone, in a zone that is not UTC — the two spellings that
 * pin it. A bare date takes no zone (`2026-10-08Z` parses as nothing), and a
 * text already carrying one is unambiguous, so both are only told how to
 * name a later moment.
 */
function pastTimeError(text: string, at: number, now: number, timeZone: string | undefined): string {
  const tz = timeZone && isKnownTimeZone(timeZone) ? timeZone : localTimeZone();
  const words = { now, timeZone: tz, withDay: true };
  const m = ISO_TIME.exec(text);
  const offset = zoneOffsetAt(at, tz);
  // Group 4 is the hour: present only when the text named a time at all.
  // Groups 8 and 9 are the zone it named, if any.
  const wall = m?.[4] !== undefined && !m[8] && !m[9];
  const fix = wall && offset !== "+00:00"
    ? `give it a zone (${text}Z, ${text}${offset}) or a duration (2h)`
    : "name a later moment, or a duration (2h)";
  return `"${text}" is ${formatWaitTime(at, words)} in ${tz}, already past (now ${formatWaitTime(now, words)}); ${fix}`;
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

/** The shortest chain `from` → … → `to` where each step blocks the next, as
 *  short ids, or null when there is none. */
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
 * A check over one index of `tasks`: the error for making `task` wait on
 * `blocker`, or null when the edge is safe: "ct-9 already waits on ct-5
 * (ct-9 → ct-7 → ct-5, each waiting on the next); this edge would close a
 * loop. Blocked by names …", with the hint. addDep, create and
 * update (lib/taskGraph assertDependencyEdges) and the web palette all word
 * it this way. Either ref may be a short id or an `_id`; the message names
 * short ids. Pass the nodes whose edges should count: every task in the
 * workspace that is not done or dropped, not only the `open` ones. An edge
 * counts when both its ends are in the set.
 */
export function dependencyLoopChecker(tasks: Iterable<DepNode>): (task: string, blocker: string) => string | null {
  const index = dependentsIndex(tasks);
  return (task, blocker) => {
    const [t, b] = [index.key.get(task) ?? task, index.key.get(blocker) ?? blocker];
    if (t === b) return `${t} cannot wait on itself.`;
    const path = pathIn(index, t, b);
    if (!path) return null;
    // Written in waits-on order to match the sentence; the usual cause is an
    // edge named backwards, so the hint says which way "blocked by" points.
    const chain = [...path].reverse().join(" → ");
    return `${b} already waits on ${t} (${chain}, each waiting on the next); this edge would close a loop. Blocked by names what a task needs: if ${b} needs ${t}, that edge already exists.`;
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
