/**
 * The task graph (docs/architecture/task-graph.md): what blocks a task, when
 * it is ready, how a person names a blocker, and which edges would close a
 * loop. Convex, the CLI, the web and mobile all read these, so "ready", a
 * wait's wording and the loop error read the same everywhere.
 *
 * Pure: no Convex, no clock of its own. A caller resolves blocker statuses
 * from wherever it holds them and passes `now` for anything time-shaped.
 */

import { parsePrRef } from "../contracts/prRefs";
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
  /** TG9: bookkeeping that is ready only for its owner, `user_id`. */
  ephemeral?: boolean | null;
  user_id?: unknown;
};

/**
 * The open blockers of a task, task blockers first (in `blocked_by` order),
 * then waits. Readiness, the CLI's "blocked by" lines, the row tooltip and
 * the task page all render from this one list.
 */
export function blockersOf(task: GraphTask, statusOf: StatusOf): Blocker[] {
  const out: Blocker[] = [];
  const seen = new Set<string>();
  for (const raw of task.blocked_by ?? []) {
    const found = statusOf(raw);
    const info = typeof found === "string" ? { status: found } : found;
    // One blocker named by both its short id and its _id is listed once, as the short id.
    const ref = info?.short_id || raw;
    if (seen.has(ref)) continue;
    seen.add(ref);
    if (found === null) out.push({ kind: "task", ref, missing: true });
    else {
      const status = info?.status || UNKNOWN_BLOCKER_STATUS;
      if (!isTerminalTaskStatus(status)) out.push({ kind: "task", ref, status });
    }
  }
  for (const w of task.waits ?? []) if (w.state !== "met") out.push(w);
  return out;
}

/** Whether this blocker holds the task back. A missing task id does not. */
export function isBlocking(b: Blocker): boolean {
  return !(b.kind === "task" && "missing" in b);
}

/** Every task in `blocked_by` is done or dropped (or missing), and every wait is met. */
export function isUnblocked(task: GraphTask, statusOf: StatusOf): boolean {
  return !blockersOf(task, statusOf).some(isBlocking);
}

export type ReadinessOptions = {
  statusOf: StatusOf;
  /** The parent's status by `parent_id`, resolved by the caller from the
   *  database, never inferred from a filtered page. `null` means looked up
   *  and gone (the subtask is an orphan, so ready); `undefined` means not
   *  looked up, which is not ready (`parent_unknown`), so a caller that forgot
   *  to load parents never hands out a subtask of work in progress. */
  parentStatusOf: (parentId: string) => string | null | undefined;
  /** The user asking (a users `_id`), or null for no one in particular. An
   *  ephemeral task is ready only for the user who owns it. */
  viewer: string | null;
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
  if (task.ephemeral && (opts.viewer == null || task.user_id == null || String(task.user_id) !== opts.viewer)) {
    return { ready: false, reason: "ephemeral" };
  }
  if (task.parent_id && !opts.includeSubtasks) {
    const ps = opts.parentStatusOf(String(task.parent_id));
    if (ps === undefined) return { ready: false, reason: "parent_unknown" };
    if (ps === "in_progress" || ps === "in_review") return { ready: false, reason: "parent_active" };
  }
  const blockers = blockersOf(task, opts.statusOf).filter(isBlocking);
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
  /** A time wait as a full date with its zone ("Oct 14, 2026 09:00 UTC"), for
   *  text that is stored and read later, in other zones: a task_history line,
   *  the "Unblocked: …" comment. Relative words ("Thu", "09:00") are for
   *  rendering in the viewer's zone. */
  absolute?: boolean;
};

function prRef(w: PrWaitTarget, opts: WaitLabelOptions): string {
  return opts.fullRef ? `${w.repository}#${w.pr_number}` : `#${w.pr_number}`;
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

/** "09:00", "Thu 09:00" within the coming week, "Oct 14 09:00" past it, with
 *  the year when it is not this one. `absolute` always prints the date, the
 *  year and the zone. */
export function formatWaitTime(at: number, opts: WaitLabelOptions = {}): string {
  const now = opts.now ?? Date.now();
  const tz = opts.timeZone && isKnownTimeZone(opts.timeZone) ? opts.timeZone : undefined;
  const part = (ts: number, o: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat("en-US", { timeZone: tz, ...o }).format(ts);
  const time = part(at, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  if (opts.absolute) {
    const zone = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" })
      .formatToParts(at)
      .find((p) => p.type === "timeZoneName")?.value;
    return `${part(at, { month: "short", day: "numeric", year: "numeric" })} ${time}${zone ? ` ${zone}` : ""}`;
  }
  const day = (ts: number) => part(ts, { year: "numeric", month: "2-digit", day: "2-digit" });
  if (day(at) === day(now)) return time;
  if (at > now && at - now < 6 * 86_400_000) return `${part(at, { weekday: "short" })} ${time}`;
  const sameYear = part(at, { year: "numeric" }) === part(now, { year: "numeric" });
  const date = part(at, sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
  return `${date} ${time}`;
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

/** The timeline's phrase for a wait being set (TG11): "Waiting on PR #42",
 *  "Waiting on green checks for PR #42", "Waiting on sd-412", "Waiting until
 *  Thu 09:00". History writers use this rather than prefixing `waitLabel`,
 *  with `absolute`, since the line is stored and read in other zones. */
export function waitingOnLabel(w: WaitTarget, opts: WaitLabelOptions = {}): string {
  switch (w.kind) {
    case "pr_merged": return `Waiting on PR ${prRef(w, opts)}`;
    case "pr_checks_green": return `Waiting on green checks for PR ${prRef(w, opts)}`;
    case "decision": return `Waiting on ${w.decision}`;
    case "time": return `Waiting until ${formatWaitTime(w.at, opts)}`;
  }
}

/** One line for any blocker: "ct-12", "ct-12 (not found)", "ct-12 (status
 *  unknown)", or the wait's condition, with "failed" when a wait can no
 *  longer be met. */
export function blockerLabel(b: Blocker, opts: WaitLabelOptions = {}): string {
  if (b.kind === "task") {
    if ("missing" in b) return `${b.ref} (not found)`;
    return b.status === UNKNOWN_BLOCKER_STATUS ? `${b.ref} (status unknown)` : b.ref;
  }
  const label = waitLabel(b, opts);
  return b.state === "failed" ? `${label} (failed${b.note ? `: ${b.note}` : ""})` : label;
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
    const p = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" })
        .formatToParts(ts)
        .map((x) => [x.type, Number(x.value)]),
    );
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
  const index = dependentsIndex(tasks);
  const [t, b] = [index.key.get(task) ?? task, index.key.get(blocker) ?? blocker];
  if (t === b) return `${t} cannot wait on itself.`;
  const path = pathIn(index, t, b);
  return path ? `${b} already waits on ${t} (${path.join(" → ")}); this edge would close a loop.` : null;
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
