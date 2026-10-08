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

/**
 * A task blocker's status by the ref `blocked_by` holds: a short id, or the
 * `_id` a plan's older rows used. `null`/`undefined` means the ref names no
 * task the caller could find: it does not block, and is reported missing.
 * Build it with `statusLookup` so both forms resolve.
 */
export type StatusOf = (ref: string) => string | null | undefined;

/** A `StatusOf` over the tasks the caller holds, keyed by short id and `_id`,
 *  the same refs the edge functions below resolve. */
export function statusLookup(
  tasks: Iterable<{ short_id?: string | null; _id?: unknown; status?: string | null }>,
): StatusOf {
  const byRef = new Map<string, string | null | undefined>();
  for (const t of tasks) {
    if (t.short_id) byRef.set(t.short_id, t.status);
    if (t._id) byRef.set(String(t._id), t.status);
  }
  return (ref) => byRef.get(ref);
}

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
  for (const ref of task.blocked_by ?? []) {
    if (seen.has(ref)) continue;
    seen.add(ref);
    const status = statusOf(ref);
    if (status == null) out.push({ kind: "task", ref, missing: true });
    else if (!isTerminalTaskStatus(status)) out.push({ kind: "task", ref, status });
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
   *  database, never inferred from a filtered page. Required so no caller
   *  skips the parent rule; one that holds no parents passes `() => null`. */
  parentStatusOf: (parentId: string) => string | null | undefined;
  /** The user asking (a users `_id`), or null for no one in particular. An
   *  ephemeral task is ready only for the user who owns it. */
  viewer: string | null;
  /** Count subtasks of a parent being worked as ready (CLI --subtasks). */
  includeSubtasks?: boolean;
};

export type NotReadyReason = "status" | "triage" | "superseded" | "ephemeral" | "parent_active" | "blocked";

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
  if (task.ephemeral && (opts.viewer == null || String(task.user_id) !== opts.viewer)) return { ready: false, reason: "ephemeral" };
  if (task.parent_id && !opts.includeSubtasks) {
    const ps = opts.parentStatusOf(String(task.parent_id));
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
  /** IANA zone for a time wait; default the runtime's. */
  timeZone?: string;
  /** Name the repository: "PR owner/repo#42" instead of "PR #42". */
  fullRef?: boolean;
};

function prRef(w: PrWaitTarget, opts: WaitLabelOptions): string {
  return opts.fullRef ? `${w.repository}#${w.pr_number}` : `#${w.pr_number}`;
}

/** "09:00", "Thu 09:00" within the coming week, "Oct 14 09:00" past it, with
 *  the year when it is not this one. */
export function formatWaitTime(at: number, opts: WaitLabelOptions = {}): string {
  const now = opts.now ?? Date.now();
  const tz = opts.timeZone;
  const part = (ts: number, o: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat("en-US", { timeZone: tz, ...o }).format(ts);
  const time = part(at, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
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

/** The same condition once met, for "Unblocked: PR #42 merged". */
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
 *  Thu 09:00". History writers use this rather than prefixing `waitLabel`. */
export function waitingOnLabel(w: WaitTarget, opts: WaitLabelOptions = {}): string {
  switch (w.kind) {
    case "pr_merged": return `Waiting on PR ${prRef(w, opts)}`;
    case "pr_checks_green": return `Waiting on green checks for PR ${prRef(w, opts)}`;
    case "decision": return `Waiting on ${w.decision}`;
    case "time": return `Waiting until ${formatWaitTime(w.at, opts)}`;
  }
}

/** One line for any blocker: "ct-12", "ct-12 (not found)", or the wait's
 *  condition, with "failed" when a wait can no longer be met. */
export function blockerLabel(b: Blocker, opts: WaitLabelOptions = {}): string {
  if (b.kind === "task") return "missing" in b ? `${b.ref} (not found)` : b.ref;
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
/** GitHub's checks tab: github.com/owner/repo/pull/42/checks */
const CHECKS_URL = /github\.com\/[^/]+\/[^/]+\/pulls?\/\d+\/checks\b/i;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_DATETIME = /^(\d{4})-(\d{2})-(\d{2})[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/i;

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
 *   2026-10-14, 2026-10-14T09:00    time; a bare date is local midnight, a
 *                                   datetime without a zone is local
 *
 * A bare number is refused rather than guessed: "42" could mean #42 or ct-42.
 */
export function parseBlockerRef(raw: string, now: number = Date.now()): BlockerRef {
  const text = (raw ?? "").trim();
  if (!text) return { ok: false, error: "Empty blocker: name a task (ct-12), a PR (#42), a decision (sd-4) or a time (2h)" };

  // Canonical ids: ct-012 is ct-12, or it would match no task and never block.
  const task = TASK_REF.exec(text);
  if (task) return { ok: true, kind: "task", ref: `ct-${Number(task[1])}` };
  const decision = DECISION_REF.exec(text);
  if (decision) return { ok: true, kind: "decision", decision: `sd-${Number(decision[1])}` };

  const checks = CHECKS_SUFFIX.test(text) || CHECKS_URL.test(text);
  const prText = text.replace(CHECKS_SUFFIX, "");
  const n = /^\d+$/.exec(prText)?.[0];
  if (n) return { ok: false, error: `"${text}" is ambiguous: write #${n} for a pull request or ct-${n} for a task` };
  const parsed = parsePrRef(prText);
  // parsePrRef also reads "owner/name/12"; an all-digit pair is a date (2026/10/14), not a repository.
  const pr = parsed?.repository && /^\d+\/\d+$/.test(parsed.repository) ? null : parsed;
  if (pr) {
    if (pr.number == null) return { ok: false, error: `"${text}" names a repository but no pull request (write ${pr.repository}#42)` };
    const kind = checks ? "pr_checks_green" : "pr_merged";
    return pr.repository
      ? { ok: true, kind, repository: pr.repository, pr_number: pr.number }
      : { ok: true, kind, pr_number: pr.number };
  }
  if (checks) return { ok: false, error: `"${text}": :checks follows a pull request (#42:checks)` };

  const at = parseWaitTime(text, now);
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
function parseWaitTime(text: string, now: number): number | null {
  if (/^\d/.test(text) && !/^\d{4}-/.test(text)) {
    try { return now + parseDuration(text); } catch { return null; }
  }
  const day = ISO_DATE.exec(text);
  if (day) return isCalendarDate(day) ? new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])).getTime() : null;
  // Date.parse rolls 2026-02-30T09:00 over to March 2, so check the day first.
  const dt = ISO_DATETIME.exec(text);
  if (!dt || !isCalendarDate(dt)) return null;
  const ts = Date.parse(text.replace(" ", "T"));
  return Number.isNaN(ts) ? null : ts;
}

/** Whether [, y, m, d] names a real day (no Feb 30). */
function isCalendarDate(ymd: RegExpExecArray): boolean {
  const [y, m, d] = [Number(ymd[1]), Number(ymd[2]), Number(ymd[3])];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

// ---------------------------------------------------------------------------
// Edges that cannot loop (TG4) and order
// ---------------------------------------------------------------------------

/** A node of the dependency graph. `blocked_by` entries are short ids; a
 *  plan's older rows may name a blocker by `_id`, which resolves too. */
export type DepNode = { short_id: string; _id?: string; blocked_by?: readonly string[] | null };

/** blocker short id -> the short ids it blocks, over the nodes given, and
 *  `key`: any ref (short id or `_id`) -> its node's short id. */
function dependentsIndex(tasks: Iterable<DepNode>): { nodes: DepNode[]; out: Map<string, string[]>; key: Map<string, string> } {
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
 * The shortest chain `from` → … → `to` where each step blocks the next, or
 * null when there is none. Pass the edges that should count (the workspace's
 * open tasks); a node's `blocked_by` entries outside the set still resolve as
 * edges when they name a node that is in it.
 */
export function findPath(tasks: Iterable<DepNode>, from: string, to: string): string[] | null {
  if (from === to) return [from];
  const { out } = dependentsIndex(tasks);
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
 * close a loop." addDep, create and update all word it this way.
 */
export function dependencyLoopError(tasks: Iterable<DepNode>, task: string, blocker: string): string | null {
  if (task === blocker) return `${task} cannot wait on itself.`;
  const path = findPath(tasks, task, blocker);
  return path ? `${blocker} already waits on ${task} (${path.join(" → ")}); this edge would close a loop.` : null;
}

/**
 * Kahn's layers: each layer depends only on earlier ones, in the input order
 * within a layer. Nodes on or behind a cycle never reach in-degree zero; they
 * come back in `cyclic` (input order) so a drawing can still place them.
 */
export function topoLayers<T extends DepNode>(tasks: Iterable<T>): { layers: T[][]; cyclic: T[] } {
  const { nodes, out } = dependentsIndex(tasks);
  const inDeg = new Map<string, number>(nodes.map((t) => [t.short_id, 0]));
  for (const targets of out.values()) for (const t of targets) inDeg.set(t, inDeg.get(t)! + 1);

  const layers: T[][] = [];
  let remaining = nodes as T[];
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
 * A topological order of the short ids, and the cycles that stopped the rest:
 * each cycle is a walk along `blocked_by` among the unplaced nodes.
 */
export function topologicalOrder(tasks: Iterable<DepNode>): { sorted: string[]; cycles: string[][] } {
  const nodes = [...tasks];
  const { layers, cyclic } = topoLayers(nodes);
  const { key } = dependentsIndex(nodes);
  const sorted = layers.flat().map((t) => t.short_id);
  const cycles: string[][] = [];
  const remaining = new Set(cyclic.map((t) => t.short_id));
  const byId = new Map(nodes.map((t) => [t.short_id, t]));
  const visited = new Set<string>();
  for (const start of remaining) {
    if (visited.has(start)) continue;
    const cycle: string[] = [];
    let cur: string | undefined = start;
    while (cur && !visited.has(cur)) {
      visited.add(cur);
      cycle.push(cur);
      cur = byId.get(cur)?.blocked_by?.map((d) => key.get(d)).find((d) => d && remaining.has(d) && !visited.has(d));
    }
    cycles.push(cycle);
  }
  return { sorted, cycles };
}
