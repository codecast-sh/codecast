// The Issues surface's pure readings: a group's state as a person reads it
// (regressed is its own state), the list's query as the address carries it,
// its filters, sort and counts, where a fix stands, the occurrence chart's
// layout, the tag breakdown over kept samples, a stack as frame rows, and
// where in a replay a sample happened. No React, no store.
import { bucketSeries, GROUP_RULES, type GroupKind } from "@codecast/shared/contracts/ingest";
import { failureMessageKey, isRecordNotIssue, parseStackFrame } from "@codecast/shared/contracts/signalFingerprint";
import { routeOf } from "@codecast/shared/replay";
import type { OpsEvent, OpsGroup, OpsSample, OpsSource } from "./opsTypes";

const HOUR = 3600_000;
const DAY = 24 * HOUR;

// ── A group's state ──

export type IssueState = "regressed" | "open" | "ok" | "resolved" | "ignored";

/**
 * Open again after a resolve: the server stamps regressed_at on the
 * occurrence that broke the resolve (lib/ingestGroups), and a later resolve
 * moves resolved_at past it, so the newer of the two says which holds.
 */
type RegressFields = Pick<OpsGroup, "status" | "regressed_at" | "resolved_at"> & Partial<Pick<OpsGroup, "kind" | "meta" | "last_seen" | "last_transition" | "last_transition_at">>;

const FAILING_AGAIN = new Set(["check_failed", "metric_alert", "job_failed"]);

/**
 * When a group came back after a resolve, or null. An error carries the
 * server's regressed_at. A check or metric recovers on its own (its recovery
 * stamps resolved_at) and fails again without one, so for those failing
 * again after the last resolve or recovery is the regression, dated by the
 * failure that reopened it.
 */
export function regressedAt(g: RegressFields): number | null {
  if (g.status !== "open") return null;
  if (g.regressed_at !== undefined && g.regressed_at >= (g.resolved_at ?? 0)) return g.regressed_at;
  if ((g.kind === "check" || g.kind === "metric") && g.resolved_at !== undefined && g.meta?.ok !== true) {
    const failedAt = g.last_transition && FAILING_AGAIN.has(g.last_transition) ? g.last_transition_at : undefined;
    if (failedAt !== undefined && failedAt > g.resolved_at) return failedAt;
    if (failedAt === undefined && (g.last_seen ?? 0) > g.resolved_at) return g.last_seen!;
  }
  return null;
}

/** Open again after a resolve (or, for a check or metric, after a recovery). */
export function isRegressed(g: RegressFields): boolean {
  return regressedAt(g) !== null;
}

export function issueState(g: RegressFields & Pick<OpsGroup, "kind" | "meta">): IssueState {
  if (g.status === "resolved") return "resolved";
  if (g.status === "ignored" || g.status === "muted") return "ignored";
  if (isRegressed(g)) return "regressed";
  // An open check or metric that is currently fine reads as watched, not red.
  if ((g.kind === "check" || g.kind === "metric") && g.meta?.ok === true) return "ok";
  return "open";
}

/**
 * The release a regressed group came back in: the one the server stamped when
 * it regressed, else its regression's transition row (the newest one at or
 * after regressed_at). Null when neither names one: the newest release it was
 * seen in is a different fact, so the pill shows the age instead.
 */
export function regressedIn(g: Pick<OpsGroup, "_id" | "short_id" | "regressed_at"> & Partial<Pick<OpsGroup, "regressed_in">>, events: OpsEvent[]): string | null {
  if (g.regressed_in) return g.regressed_in;
  const since = (g.regressed_at ?? 0) - 5 * 60_000;
  let hit: OpsEvent | null = null;
  for (const e of events) {
    if (e.group_id !== g._id && e.data?.group_short_id !== g.short_id) continue;
    if (e.data?.transition !== "regressed" && e.kind !== "error_regressed") continue;
    if (e.created_at >= since && (!hit || e.created_at > hit.created_at)) hit = e;
  }
  return hit?.data?.release ?? null;
}

// ── Who resolved it ──

export type Resolver = { via: "person" | "recovered" | "vendor" | null; by?: string };

const RECOVERY = new Set(["check_recovered", "metric_recovered"]);

/**
 * What put a group to rest. The server stamps it (resolved_via, resolved_by);
 * a row resolved before it did is read from what is known: a check or metric
 * whose recovery transition sits at its resolve recovered on its own, and a
 * mirrored group resolved with no recovery was resolved at the vendor. Null
 * `via` is a resolve nobody can name, which is never called a person's.
 */
export function resolverOf(g: Partial<Pick<OpsGroup, "_id" | "short_id" | "kind" | "resolved_at" | "resolved_via" | "resolved_by" | "external" | "last_transition" | "last_transition_at">>, events: OpsEvent[] = []): Resolver {
  if (g.resolved_via) return { via: g.resolved_via, ...(g.resolved_by ? { by: g.resolved_by } : {}) };
  if (g.resolved_at === undefined) return { via: null };
  if (g.kind === "check" || g.kind === "metric") {
    const near = (at: number | undefined) => at !== undefined && Math.abs(at - g.resolved_at!) < 5 * 60_000;
    if (g.last_transition && RECOVERY.has(g.last_transition) && near(g.last_transition_at)) return { via: "recovered" };
    const hit = events.some((e) => (e.group_id === g._id || e.data?.group_short_id === g.short_id) && RECOVERY.has(e.data?.transition ?? e.kind) && near(e.created_at));
    if (hit) return { via: "recovered" };
  }
  if (g.external) return { via: "vendor" };
  return { via: null };
}

/** A resolver in a few words; `name` is the person's, "you" for the viewer. Never "by hand" for a resolve nobody can attribute. */
export function resolverWords(resolver: Resolver, name: string | null, provider?: string): string {
  if (resolver.via === "recovered") return "recovered on its own";
  if (resolver.via === "vendor") return provider ? `resolved in ${provider[0].toUpperCase()}${provider.slice(1)}` : "resolved at the source";
  if (resolver.via === "person") return name ? `resolved by ${name}` : "resolved by a person";
  return "resolved";
}

// ── Where a fix stands ──

export type FixStage = "none" | "dropped" | "other" | "filed" | "fixing" | "review" | "closed" | "shipped" | "recurring";
export const FIX_STAGES: FixStage[] = ["recurring", "none", "other", "dropped", "filed", "fixing", "review", "closed", "shipped"];
/** How a stage reads everywhere: the Fix facet, the list's Fix column, the page's badge and the hovers say the same words. */
export const FIX_STAGE_LABEL: Record<FixStage, string> = {
  none: "Untriaged",
  dropped: "Dropped",
  other: "Other issue's task",
  filed: "Filed",
  fixing: "Fixing",
  review: "In review",
  closed: "Closed",
  shipped: "Shipped",
  recurring: "Still firing",
};
/** How a stage reads in a list cell: the same words, and nothing for an untriaged one. */
export const FIX_STAGE_SHORT: Record<FixStage, string> = { ...FIX_STAGE_LABEL, none: "" };

/** The problem task as the fix chain reads it: its status, how it closed, and what it landed. */
export type FixTask = {
  /** What the task is about: a task filed for another title is never credited with this issue's fix (creditedTask). */
  title?: string;
  status?: string;
  /** Who answers for the task: a person's or role's id. The issue's owner. */
  assignee?: string;
  closed_at?: number;
  landed?: { sha: string; at: number; url?: string; repository?: string };
  cause?: { dissolved?: { at: number; note?: string }; merged_into?: string };
  duplicate_of?: string;
};

/** A problem task's state in a word, the same on the Fix card, the bulk confirm and any hover: a dissolved task reads "dissolved", never "done". */
export function taskStateWord(task: Pick<FixTask, "status" | "cause"> | null | undefined): string | undefined {
  if (task?.cause?.dissolved) return "dissolved";
  return task?.status ? task.status.replace("_", " ") : undefined;
}

/** How a fix closed: the commit it landed, a close with no change on record, a dissolve, or the issue resolved after a fix session started on it. */
export type FixClose =
  | { how: "landed"; at: number; sha: string; url?: string }
  | { how: "done"; at: number | null }
  | { how: "resolved"; at: number; release?: string; via?: Resolver["via"]; by?: string }
  | { how: "dissolved"; at: number; note?: string }
  | { how: "dropped"; at: number | null };

type FixGroup = Pick<OpsGroup, "status" | "signal_task_id" | "fix_conversation_id"> & Partial<Pick<OpsGroup, "kind" | "meta" | "last_seen" | "resolved_at" | "resolved_in" | "fix_started_at" | "resolved_via" | "resolved_by" | "external">>;

const asTask = (t: FixTask | string | undefined): FixTask | undefined => (typeof t === "string" ? { status: t } : t);

/**
 * How the fix behind a group closed, if it did. A resolve is a fix only when
 * a fix session was started on the issue before it: a resolve on its own (a
 * person's, a bulk one, a monitor's recovery) closes the issue, not a fix,
 * and the regression pill alone says the issue came back after it.
 */
export function fixClose(g: FixGroup, taskIn: FixTask | string | undefined): FixClose | null {
  const task = asTask(taskIn);
  const hasTask = !!g.signal_task_id;
  if (hasTask && task?.cause?.dissolved) return { how: "dissolved", at: task.cause.dissolved.at, note: task.cause.dissolved.note };
  if (hasTask && task?.status === "dropped") return { how: "dropped", at: task.closed_at ?? null };
  // A commit landed on a task still open or in review has not closed it.
  if (hasTask && task?.landed && (!task.status || task.status === "done")) return { how: "landed", at: task.landed.at, sha: task.landed.sha, url: task.landed.url };
  if (hasTask && task?.status === "done") return { how: "done", at: task.closed_at ?? g.resolved_at ?? null };
  const afterFix = g.fix_conversation_id && g.resolved_at !== undefined && g.resolved_at >= (g.fix_started_at ?? 0);
  if (afterFix && (g.status === "resolved" || (g.status === "open" && (g.last_seen ?? 0) > g.resolved_at!))) {
    const r = resolverOf(g);
    return { how: "resolved", at: g.resolved_at!, release: g.resolved_in, via: r.via, ...(r.by ? { by: r.by } : {}) };
  }
  return null;
}

/**
 * Whether a group has fired since `at`: a check or metric failing now, any
 * other kind seen after it. What tells a fix that held from one that did not.
 */
export function firingSince(g: Partial<Pick<OpsGroup, "kind" | "meta" | "last_seen" | "status">>, at: number | null): boolean {
  if (at === null) return false;
  if (g.kind === "check" || g.kind === "metric") return g.status === "open" && g.meta?.ok !== true && (g.last_seen ?? 0) > at;
  return (g.last_seen ?? 0) > at;
}

/**
 * One reading of the chain from an issue to its fix, read against what the
 * issue did since. A task closed with a landed commit is shipped; closed
 * without one (or a group resolved after a fix session started on it) is
 * closed; either one that fired again after it is recurring, whatever the
 * task says. A resolve with no fix behind it leaves the stage at the task's. A
 * dissolved or dropped problem task is a decision someone made, so it reads
 * as dropped, never as untriaged or shipped. `task` may be the task's status
 * category alone.
 */
export function fixStage(g: FixGroup, taskIn: FixTask | string | undefined): FixStage {
  const task = asTask(taskIn);
  const status = task?.status;
  const close = fixClose(g, task);
  if (close?.how === "dissolved" || close?.how === "dropped") return g.fix_conversation_id && status !== "dropped" && !task?.cause?.dissolved ? "fixing" : "dropped";
  if (close) {
    if (firingSince(g, close.at)) return "recurring";
    return close.how === "landed" ? "shipped" : "closed";
  }
  if (status === "in_review") return "review";
  if (status === "in_progress" || g.fix_conversation_id) return "fixing";
  if (g.signal_task_id) return "filed";
  return "none";
}

const WORKING_TASK = new Set(["in_progress", "in_review"]);
const CLOSED_TASK = new Set(["done", "dropped"]);

/**
 * Whether someone is on an issue: a fix session was started on it, or its
 * problem task is being worked (in progress or review) or has someone
 * assigned. A task filed and left open with nobody on it is not. The Ops
 * home's Nobody on it, the list's filter and its Fix cell read this one rule.
 */
export function someoneOnIt(sessionId: string | null | undefined, taskIn: { status?: string; assignee?: string | null } | string | null | undefined): boolean {
  if (sessionId) return true;
  const t = typeof taskIn === "string" ? { status: taskIn, assignee: null } : taskIn;
  if (!t) return false;
  if (WORKING_TASK.has(t.status ?? "")) return true;
  return !!t.assignee && !CLOSED_TASK.has(t.status ?? "");
}

/** Whether a stage is a fix that closed (held or not): the card names how and checks it against the occurrences. */
export function fixClosed(stage: FixStage): boolean {
  return stage === "closed" || stage === "shipped" || stage === "recurring";
}

/**
 * Occurrences after `since`, from the group's hourly buckets while `since`
 * is inside them, else its daily counts. The hour (or day) `since` falls in
 * is left out unless it starts there, since part of it came before: then
 * `n` is a floor and `exact` is false, unless that partial hour or day held
 * nothing. `n` is null when neither reaches back that far.
 */
export function occurrencesSince(g: Pick<OpsGroup, "last_seen" | "buckets" | "days">, since: number, now: number): { n: number | null; exact: boolean } {
  if (g.last_seen <= since) return { n: 0, exact: true };
  const tally = (rows: { at: number; count: number }[], unit: number) => {
    const head = Math.floor(since / unit) * unit;
    const from = since === head ? head : head + unit;
    const partial = since !== head && rows.some((r) => r.at === head && r.count > 0);
    return { n: Math.max(1, rows.filter((r) => r.at >= from).reduce((a, r) => a + r.count, 0)), exact: !partial };
  };
  const hourFloor = Math.floor(now / HOUR) * HOUR - (GROUP_RULES.bucket_hours - 1) * HOUR;
  if (since >= hourFloor) return tally(g.buckets.map((b) => ({ at: b.hour, count: b.count })), HOUR);
  if (g.days?.length && g.days[0].day <= since) return tally(g.days.map((d) => ({ at: d.day, count: d.count })), DAY);
  return { n: null, exact: false };
}

/**
 * Whether a problem task was filed for this issue as it reads now. A group
 * renamed or regrouped after its task was filed (a rage click on a
 * different button of the same page) keeps a task about something else.
 * Quoted parts name the thing (a button, a key): when both titles quote and
 * no quote is shared, they differ; otherwise most words must be shared.
 */
export function taskMatchesIssue(taskTitle: string | undefined, groupTitle: string): boolean {
  if (!taskTitle) return true;
  const norm = (t: string) => t.toLowerCase().replace(/^\s*\[[^\]]*\]\s*/, "").trim();
  const a = norm(taskTitle);
  const b = norm(groupTitle);
  if (a.includes(b) || b.includes(a)) return true;
  const quoted = (t: string) => [...t.matchAll(/["“”'‘’`]([^"“”'‘’`]{3,})["“”'‘’`]/g)].map((m) => m[1].trim());
  const qa = quoted(a);
  const qb = quoted(b);
  if (qa.length && qb.length) return qa.some((q) => qb.includes(q));
  const words = (t: string) => new Set(t.split(/[^a-z0-9_.$/-]+/).filter((w) => w.length > 2));
  const wa = words(a);
  const wb = words(b);
  if (!wa.size || !wb.size) return true;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / Math.min(wa.size, wb.size) >= 0.6;
}

/**
 * The problem task the fix chain may credit with this issue: the task, unless
 * it was filed for another title, in which case its commit, its close and its
 * stage say nothing about this issue. Every surface (the stage, the banners,
 * the chart's fix mark, the activity, the list's Fix column) reads the fix
 * through this one rule, so none can claim a fix another flags as mismatched.
 */
export function creditedTask<T extends FixTask>(g: Pick<OpsGroup, "title">, task: T | null | undefined): T | undefined {
  if (!task) return undefined;
  return taskMatchesIssue(task.title, g.title) ? task : undefined;
}

/** A fix session as the Fix card weighs it: whether a process is behind it now, and whether this device holds its row at all. */
export type FixSessionFact = { id: string; awake: boolean; known: boolean; /** When the session last moved, to the minute, when this device holds its row. */ at?: number };

export type FixPlan = {
  /** The session the fix is happening in, which the card opens first; null when nothing is running. */
  live: string | null;
  /**
   * The press the card leads with: open the running fix, continue a stopped
   * fix session (`live` then names it), reopen a dropped
   * problem, start one, resolve an open issue whose fix held, start a
   * follow-up on one that did not, or nothing once a fix held and the issue
   * is resolved.
   */
  primary: "open" | "continue" | "refile" | "start" | "resolve" | "followup" | null;
  /** Starting another agent beside a running one is offered, never led with. */
  canStartAnother: boolean;
};

/**
 * A fix's sessions in the order the card shows them: working now, then the
 * one that wrote the landed commit, then newest. `lead` is what shows before
 * "+N earlier": the first two, and any working or shipping one past them.
 */
export function orderFixSessions(sessions: FixSessionFact[], shipped: string | null): { ordered: FixSessionFact[]; lead: FixSessionFact[] } {
  const rank = (s: FixSessionFact) => (s.awake ? 0 : s.id === shipped ? 1 : 2);
  const ordered = [...sessions].sort((a, b) => rank(a) - rank(b) || (b.at ?? 0) - (a.at ?? 0));
  return { ordered, lead: ordered.filter((s, i) => i < 2 || rank(s) < 2) };
}

/**
 * What the Fix card leads with. Any awake session on the group's fix or on
 * its problem task is the fix in progress. The session started from the
 * issue counts while this device has no row to say otherwise (it may belong
 * to another device's cache); a session on the task counts only when seen
 * awake, since a task gathers sessions that were never fixing (an
 * investigation, a dissolve).
 */
export function fixPlan(g: Pick<OpsGroup, "fix_conversation_id"> & Partial<Pick<OpsGroup, "status">>, stage: FixStage, sessions: FixSessionFact[]): FixPlan {
  const own = g.fix_conversation_id ? sessions.find((s) => s.id === g.fix_conversation_id) : undefined;
  // A fix that closed is no longer running whatever its session's row says; only an awake session is.
  const ownLive = !fixClosed(stage) && !!g.fix_conversation_id && (!own || !own.known || own.awake);
  const live = ownLive ? g.fix_conversation_id! : sessions.find((s) => s.awake)?.id ?? null;
  if (live) return { live, primary: "open", canStartAnother: true };
  // The issue's own fix session exists but stopped: it is continued, never started beside.
  if (!fixClosed(stage) && own?.known && !own.awake && (!g.status || g.status === "open")) return { live: own.id, primary: "continue", canStartAnother: true };
  // A resolved, ignored or muted issue is settled: a fix is offered, never led with.
  if (g.status && g.status !== "open") return { live: null, primary: null, canStartAnother: false };
  if (stage === "recurring") return { live: null, primary: "followup", canStartAnother: false };
  if (stage === "shipped" || stage === "closed") return { live: null, primary: g.status === "open" ? "resolve" : null, canStartAnother: false };
  return { live: null, primary: stage === "dropped" ? "refile" : "start", canStartAnother: false };
}

/**
 * The words of the press a fix plan leads with, the same on the Fix card,
 * the Ops home's row and anywhere else an issue offers its fix: it names the
 * task it works on, never one filed for another title.
 */
export function fixActionLabel(primary: FixPlan["primary"], taskRef: string | null | undefined, mismatch: boolean): string | null {
  const on = taskRef && !mismatch ? ` on ${taskRef}` : "";
  if (primary === "open") return "Open fix session";
  if (primary === "continue") return "Continue fix";
  if (primary === "start") return `Start fix${on}`;
  // A dropped task is reopened by the same press that starts its session: the words say both.
  if (primary === "refile") return mismatch ? "Start fix" : `Reopen ${taskRef ?? "the task"} and fix`;
  if (primary === "followup") return `Start follow-up fix${on}`;
  if (primary === "resolve") return "Resolve";
  return null;
}

/** Open groups as the list's Open counts them (open, regressed, and checks currently fine), narrowed to a source: the Issues badge. */
export function openIssueCount(rows: OpsGroup[], sourceId: string | null): number {
  let n = 0;
  for (const g of rows) if ((!sourceId || g.source_id === sourceId) && statusAdmits("open", g)) n++;
  return n;
}

/** Whether the open feeder came back full, so the store may not hold every open group: the one test every open count passes `issueTotals`. */
export const openFeederFull = (rows: readonly Pick<OpsGroup, "status">[], limit: number): boolean => rows.filter((g) => g.status === "open").length >= limit;

/** The list's totals per status: exact where the server counted them, else what the store holds. */
export type IssueTotals = { open: number; resolved: number; ignored: number; all: number; /** False when Open is only what the store holds past a full open feeder. */ exact: boolean };

/**
 * The workspace's (or one source's) issues per status, for the Issues
 * badge and the list's status segment. The store's rows are exact while the
 * open feeder is not full (`capped` false) and paint a person's triage at
 * once. Past it, the sources' own counts take over: each source's open count
 * moves with every ingest and triage and is recounted on the server, and its
 * settled counts come from that recount. A source not counted yet leaves the
 * totals as the store's, with Open marked as a floor.
 */
export function issueTotals(rows: OpsGroup[], sources: Pick<OpsSource, "_id" | "groups_open" | "group_counts">[], sourceId: string | null, capped: boolean): IssueTotals {
  const local = { open: 0, resolved: 0, ignored: 0 };
  for (const g of rows) {
    if (sourceId && g.source_id !== sourceId) continue;
    const s = issueState(g);
    if (s === "resolved") local.resolved++;
    else if (s === "ignored") local.ignored++;
    else local.open++;
  }
  const scoped = sourceId ? sources.filter((s) => s._id === sourceId) : sources;
  const counted = scoped.length > 0 && scoped.every((s) => !!s.group_counts);
  if (!counted) return { ...local, all: local.open + local.resolved + local.ignored, exact: !capped };
  // Open is taken source by source and summed, so the workspace's total is always the sum of the per-source counts (the
  // source filter, the Sources table): each source's held rows, and past a full feeder the larger of those and its counter.
  const heldOpen = new Map<string, number>();
  for (const g of rows) if (issueState(g) !== "resolved" && issueState(g) !== "ignored") heldOpen.set(g.source_id, (heldOpen.get(g.source_id) ?? 0) + 1);
  let open = 0;
  let resolved = 0;
  let ignored = 0;
  for (const s of scoped) {
    const held = heldOpen.get(s._id) ?? 0;
    open += capped ? Math.max(held, s.groups_open ?? s.group_counts!.open) : held;
    resolved += s.group_counts!.resolved;
    ignored += s.group_counts!.ignored;
  }
  const out = { open, resolved: Math.max(local.resolved, resolved), ignored: Math.max(local.ignored, ignored) };
  return { ...out, all: out.open + out.resolved + out.ignored, exact: true };
}

/**
 * Status and lane counts with the open issues the store does not hold
 * folded in. The open feeder holds the most recently seen, so the ones past
 * it are the least recently seen: quiet, when even the oldest one held is.
 * Only an unfiltered list takes the totals; a search or facet counts what
 * matched.
 */
export function withTotals(counts: IssueCounts, totals: IssueTotals, oldestOpenSeen: number | null, now: number): IssueCounts {
  const extra = Math.max(0, totals.open - counts.open);
  const out = { ...counts, open: counts.open + extra, resolved: totals.resolved, ignored: totals.ignored, all: totals.all };
  if (extra && oldestOpenSeen !== null && now - oldestOpenSeen > QUIET_DAYS * DAY) out.quiet += extra;
  return out;
}

/**
 * What a group's count counts, in the words every surface uses for it: an
 * error's events, a check's failed readings, a metric's readings over its
 * line, a job's failed runs. `short` is the list cell's unit (none for events,
 * the column's own word).
 */
export function countWords(kind: OpsGroup["kind"], n: number): { long: string; short: string | null } {
  const one = n === 1;
  if (kind === "check") return { long: one ? "failed reading" : "failed readings", short: one ? "reading" : "readings" };
  if (kind === "metric") return { long: one ? "reading over the line" : "readings over the line", short: one ? "reading" : "readings" };
  if (kind === "job") return { long: one ? "failed run" : "failed runs", short: one ? "run" : "runs" };
  return { long: one ? "event" : "events", short: null };
}

/** The list's count column named for what its rows count: Events, Readings or Runs, and Count when the rows count different things. */
export function countColumnLabel(rows: Pick<OpsGroup, "kind">[]): string {
  const words = new Set(rows.map((r) => countWords(r.kind, 2).short ?? "events"));
  if (words.size !== 1) return rows.length ? "Count" : "Events";
  const w = [...words][0];
  return w[0].toUpperCase() + w.slice(1);
}

/**
 * How many people an issue hit, and whether that is a floor: a count that
 * began after the issue opened (users_since) is at least that many. Every
 * surface writes it the one way usersText does.
 */
export function usersOf(g: Pick<OpsGroup, "users" | "users_since" | "first_seen">): { n: number; floor: boolean } | null {
  return g.users ? { n: g.users, floor: !!g.users_since && g.users_since > g.first_seen } : null;
}

/** A people count in words: "2 users" when exact, "≥2 users" when a floor; `unit` false drops the word for a column cell. */
export function usersText(u: { n: number; floor: boolean }, unit = true, fmtN: (n: number) => string = (n) => n.toLocaleString()): string {
  return `${u.floor ? "≥" : ""}${fmtN(u.n)}${unit ? ` ${u.n === 1 ? "user" : "users"}` : ""}`;
}

/** Whether any of the rows counts people: when none does, a Users column is a column of dashes and its sort does nothing. */
export function usersCounted(rows: Pick<OpsGroup, "users">[]): boolean {
  return rows.some((g) => (g.users ?? 0) > 0);
}

// ── The list's query, as the address carries it ──

export type StatusFilter = "open" | "regressed" | "resolved" | "ignored" | "all";
/** The status segment. Regressed is a lane of Open; `status=regressed` in an old link still reads as that lane. */
export const STATUS_FILTERS: { key: StatusFilter; label: string }[] = [
  { key: "open", label: "Open" },
  { key: "resolved", label: "Resolved" },
  { key: "ignored", label: "Ignored" },
  { key: "all", label: "All" },
];

/** Placeholders an SDK sends when it has no release; they name nothing, so they render as no release at all. */
const NO_RELEASE = new Set(["unknown", "undefined", "null", "none", "n/a", "-"]);

/** A release worth naming, or undefined for none or a placeholder like "unknown". */
export function knownRelease(r: string | null | undefined): string | undefined {
  const v = r?.trim();
  return v && !NO_RELEASE.has(v.toLowerCase()) ? v : undefined;
}

// ── Lanes: what in an open list needs a person now ──

/**
 * Where an open issue sits in triage. Regressed came back after a fix;
 * escalating is firing well above its own recent rate; new was first seen in
 * the last day; ongoing is still firing; quiet has not fired in QUIET_DAYS.
 */
export type IssueLane = "regressed" | "escalating" | "new" | "firing" | "flapping" | "ongoing" | "quiet";
export type LaneFilter = "attention" | IssueLane | "all";
export const LANE_FILTERS: { key: LaneFilter; label: string }[] = [
  { key: "attention", label: "Needs attention" },
  { key: "regressed", label: "Regressed" },
  { key: "escalating", label: "Escalating" },
  { key: "new", label: "New" },
  { key: "firing", label: "Firing" },
  { key: "flapping", label: "Flapping" },
  { key: "ongoing", label: "Ongoing" },
  { key: "quiet", label: "Quiet" },
  { key: "all", label: "All open" },
];
export const QUIET_DAYS = 3;
/** A regression stays in its lane this long after it came back; past it, it reads as ongoing (or quiet) and keeps its pill. */
export const REGRESSED_DAYS = 7;
/** A check or metric that failed this many times in FLAP_DAYS flaps: one lane and one pill, not a regression each time. */
export const FLAP_MIN = 3;
export const FLAP_DAYS = 7;

const FAILING_FLIP = new Set(["check_failed", "metric_alert", "regressed"]);

/**
 * How many times a check or metric flipped to failing in the last FLAP_DAYS:
 * the server's own list where it keeps one, or its transition rows this
 * device holds, whichever saw more. Zero for any other kind.
 */
export function failuresIn(g: Pick<OpsGroup, "_id" | "short_id" | "kind"> & Partial<Pick<OpsGroup, "failed_at">>, events: OpsEvent[], now: number): number {
  if (g.kind !== "check" && g.kind !== "metric") return 0;
  const since = now - FLAP_DAYS * DAY;
  const stored = (g.failed_at ?? []).filter((t) => t > since).length;
  let seen = 0;
  for (const e of events) {
    if (e.created_at <= since || (e.group_id !== g._id && e.data?.group_short_id !== g.short_id)) continue;
    if (FAILING_FLIP.has(e.data?.transition ?? e.kind)) seen++;
  }
  return Math.max(stored, seen);
}

/**
 * A check or metric that keeps flipping, whatever it reads now. A monitor
 * that recovers on its own is resolved for most of its life, so the flaps
 * are counted over its failures, not its status; only ignoring or muting it
 * settles it.
 */
export function isFlapping(g: Pick<OpsGroup, "kind" | "status">, failures: number): boolean {
  return (g.kind === "check" || g.kind === "metric") && failures >= FLAP_MIN && g.status !== "ignored" && g.status !== "muted";
}

/** The failure count a lane reads when no events are at hand: the server's list alone. */
const storedFailures = (g: OpsGroup, now: number) => failuresIn(g, [], now);
const NEW_HOURS = 24;
/** Escalating: the last 24 hours hold at least this many and this many times the day before's average over the two days before. */
const ESCALATE_MIN = 10;
const ESCALATE_FACTOR = 3;

/** The hours read as "now": a spike whose rate has fallen back under the escalation line over these has settled. */
const NOW_HOURS = 3;

/** Firing: an ongoing issue this loud over the last 24 hours, still firing in the last NOW_HOURS. A steady flood is not escalating (it is its usual rate), but it is the loudest thing a person has. */
export const FIRING_MIN = 100;

/**
 * An ongoing issue that fires loud and steady: at least FIRING_MIN events in
 * the last 24 hours, the latest within NOW_HOURS. Whatever its fix says (a
 * dropped or dissolved task included), a person sees it under Needs attention.
 */
export function isFiring(g: Pick<OpsGroup, "buckets" | "last_seen">, now: number): boolean {
  if (now - g.last_seen > NOW_HOURS * HOUR) return false;
  return bucketSeries(g.buckets, now, 24).reduce((a, b) => a + b, 0) >= FIRING_MIN;
}

export type Escalation = {
  /** Events in the last 24 hours. */
  recent: number;
  /** The daily mean of the 48 hours before them. */
  baseline: number;
  factor: number | null;
  /** The hourly rate over the last NOW_HOURS hours. */
  perHourNow: number;
  /** The busiest hour of the last day, and when it began. */
  peak: number;
  peakAt: number;
  /** The day ran past the escalation line, by the counts or the server's spike rule. */
  spiked: boolean;
  /** It spiked, and its rate now is back under the line: a spike that passed, not one going on. */
  settled: boolean;
};

/** The last 24 hours against the daily mean of the 48 before them, from the hourly buckets, with the rate now and the busiest hour. */
export function escalation(g: Pick<OpsGroup, "buckets"> & Partial<Pick<OpsGroup, "last_transition" | "last_transition_at">>, now: number): Escalation {
  const s = bucketSeries(g.buckets, now, GROUP_RULES.bucket_hours);
  const day = s.slice(-24);
  const recent = day.reduce((a, b) => a + b, 0);
  const baseline = s.slice(0, -24).reduce((a, b) => a + b, 0) / Math.max(1, (s.length - 24) / 24);
  const perHourNow = s.slice(-NOW_HOURS).reduce((a, b) => a + b, 0) / NOW_HOURS;
  const peak = Math.max(0, ...day);
  const hourStart = Math.floor(now / HOUR) * HOUR;
  const peakAt = hourStart - (day.length - 1 - day.indexOf(peak)) * HOUR;
  const line = ESCALATE_FACTOR * Math.max(1, baseline);
  const spiked = (g.last_transition === "spike" && (g.last_transition_at ?? 0) > now - 24 * HOUR) || (recent >= ESCALATE_MIN && recent >= line);
  return { recent, baseline, factor: baseline > 0 ? recent / baseline : null, perHourNow, peak, peakAt, spiked, settled: spiked && perHourNow * 24 < line };
}

/** Escalating: it spiked in the last day and is still running past the line now. One that fell back reads settled (escalation().settled), never escalating. */
export function isEscalating(g: Pick<OpsGroup, "buckets" | "first_seen" | "last_transition" | "last_transition_at">, now: number): boolean {
  if (now - g.first_seen < NEW_HOURS * HOUR) return false;
  const e = escalation(g, now);
  return e.spiked && !e.settled;
}

/** A per-day count as a person reads a rate: per hour once it runs past two an hour, else per day. */
export function rateWords(perDay: number): string {
  return perDay >= 48 ? `${Math.round(perDay / 24).toLocaleString()}/h` : perDay > 0 && perDay < 1 ? "<1/day" : `${Math.round(perDay).toLocaleString()}/day`;
}

/**
 * An escalation in the words every surface uses: the day's count and its
 * average rate against the usual rate (the two the × factor divides), and
 * the rate now.
 */
/** How far over its usual day an escalating issue runs, as its pill says it ("2.1×"), or "" under 1.5×: the issue page's lane tag and the home's pill read this one rule. */
export function escalationFactor(e: Pick<Escalation, "factor">): string {
  return e.factor !== null && e.factor >= 1.5 ? `${e.factor >= 10 ? Math.round(e.factor) : e.factor.toFixed(1)}×` : "";
}

export function escalationWords(e: Escalation): string {
  return `${e.recent.toLocaleString()} in 24h · avg ${rateWords(e.recent)} vs usual ${rateWords(e.baseline)} · now ${rateWords(e.perHourNow * 24)}`;
}

/**
 * An open issue's lane, or null for one that is not open. A check or metric
 * that keeps flipping is flapping. A regression is a lane while it is fresh:
 * one that came back over REGRESSED_DAYS ago, or has been quiet for
 * QUIET_DAYS, falls to the lane its firing says and keeps its pill.
 * `failures` is failuresIn over the events at hand.
 */
export function issueLane(g: OpsGroup, now: number, failures: number = storedFailures(g, now)): IssueLane | null {
  // A record (a CI run filed as its own group, a check that never failed) sits in no lane on any surface, as the list leaves it out.
  if (isRecordNotIssue(g)) return null;
  const s = issueState(g);
  if (s !== "open" && s !== "regressed" && s !== "ok") return null;
  if (failures >= FLAP_MIN) return "flapping";
  const quiet = now - g.last_seen > QUIET_DAYS * DAY;
  if (s === "regressed" && !quiet && now - (regressedAt(g) ?? 0) <= REGRESSED_DAYS * DAY) return "regressed";
  // A check that is passing now is watched, not firing.
  if (s === "ok") return "quiet";
  if (isEscalating(g, now)) return "escalating";
  if (now - g.first_seen < NEW_HOURS * HOUR) return "new";
  if (quiet) return "quiet";
  return isFiring(g, now) ? "firing" : "ongoing";
}

/** The lanes that ask a person to look now. */
export type AttentionLane = "regressed" | "escalating" | "new" | "firing";
const ATTENTION_LANES: ReadonlySet<IssueLane> = new Set<IssueLane>(["regressed", "escalating", "new", "firing"]);

/**
 * Whether an open issue needs a person now, and why: the one classifier the
 * Issues list's Needs attention lane, the Ops home's tiles and rows, and the
 * palette all read, so a count on one matches the lane it opens.
 */
export function attentionLane(g: OpsGroup, now: number, failures?: number): AttentionLane | null {
  const l = partitionLane(g, issueLane(g, now, failures), now);
  return l && ATTENTION_LANES.has(l) ? (l as AttentionLane) : null;
}

/** How many open issues sit in a Needs attention lane (one source's, when named): the Issues list's own count, for a surface that lists more beside them. */
export function attentionIssueCount(groups: readonly OpsGroup[], now: number, failures?: (g: OpsGroup) => number, sourceId?: string | null): number {
  let n = 0;
  for (const g of groups) if ((!sourceId || g.source_id === sourceId) && attentionLane(g, now, failures?.(g))) n++;
  return n;
}

export function laneAdmits(lane: LaneFilter, l: IssueLane | null): boolean {
  if (l === null) return false;
  if (lane === "all") return true;
  if (lane === "attention") return ATTENTION_LANES.has(l);
  return l === lane;
}

/**
 * The lane of the bar's partition an open issue sits in, so the lanes sum to
 * Open: a flapper is not one that asks for a person now (attentionLane
 * leaves it out on every surface), so it sits with Ongoing, or with Quiet
 * once it has been quiet that long. Flapping is the view across them.
 */
export function partitionLane(g: Pick<OpsGroup, "last_seen" | "status" | "kind" | "meta"> & Partial<Pick<OpsGroup, "regressed_at" | "resolved_at" | "last_transition" | "last_transition_at">>, lane: IssueLane | null, now: number): Exclude<IssueLane, "flapping"> | null {
  if (lane !== "flapping") return lane;
  // A flapper failing now that failed in the last day is firing: it keeps paging whoever owns it.
  const failing = issueState(g) === "open" || issueState(g) === "regressed";
  if (failing && now - g.last_seen <= DAY) return "firing";
  return now - g.last_seen > QUIET_DAYS * DAY ? "quiet" : "ongoing";
}

export type IssueSort = "urgency" | "last" | "first" | "events" | "users" | "trend";
export const ISSUE_SORTS: { key: IssueSort; label: string }[] = [
  { key: "urgency", label: "Urgency" },
  { key: "last", label: "Last seen" },
  { key: "first", label: "First seen" },
  { key: "events", label: "Events" },
  { key: "users", label: "Users" },
  { key: "trend", label: "Trend" },
];

/** The spark window: hourly over what the server keeps hourly (GROUP_RULES.bucket_hours), daily over 30 days. */
export type SparkRange = "24h" | "72h" | "30d";
export const SPARK_RANGES: SparkRange[] = ["24h", "72h", "30d"];
export const SPARK_HOURS: Record<SparkRange, number> = { "24h": 24, "72h": GROUP_RULES.bucket_hours, "30d": 30 * 24 };

/** A row's spark values for a window: hourly counts, or daily ones past the hourly window. */
export function sparkSeries(g: Pick<OpsGroup, "buckets" | "days" | "first_seen">, now: number, range: SparkRange): number[] {
  const hours = SPARK_HOURS[range];
  return hours > GROUP_RULES.bucket_hours ? dailySeries(g, now, hours / 24).map((b) => b.count) : bucketSeries(g.buckets, now, hours);
}

export type FacetKey = "level" | "type" | "release" | "fix";
export type IssueQuery = {
  status: StatusFilter;
  /** Inside Open only: which lane. */
  lane: LaneFilter;
  kind: GroupKind | null;
  q: string;
  sort: IssueSort;
  range: SparkRange;
  facets: Partial<Record<FacetKey, string>>;
  /** Only issues whose problem task the viewer answers for. */
  mine: boolean;
  /** Only issues nobody is on (someoneOnIt): the Overview's Nobody on it, as a list. */
  nobody?: boolean;
};

export const DEFAULT_QUERY: IssueQuery = { status: "open", lane: "attention", kind: null, q: "", sort: "urgency", range: "72h", facets: {}, mine: false };

const FACET_KEYS: FacetKey[] = ["level", "type", "release", "fix"];

/** Severities, the only values the Level facet offers. Anything else a source sends as a level (request, rage_click) is a type. */
const SEVERITIES = ["fatal", "critical", "error", "warning", "warn", "info", "log", "debug"];
export function isSeverity(level: string | undefined): boolean {
  return !!level && SEVERITIES.includes(level.toLowerCase());
}
const oneOf = <T extends string>(v: string | null, all: readonly T[], fallback: T): T => (v && (all as readonly string[]).includes(v) ? (v as T) : fallback);

/**
 * The query from the address's keys the flows workspace already carries
 * (lib/line/lineWorkspaceUrl): status, kind, q, sort, win, and `show` for
 * the facets as `level:error,release:1.2` (and `mine:1` for the Mine filter).
 */
export function parseIssueQuery(get: (key: string) => string | null): IssueQuery {
  const facets: IssueQuery["facets"] = {};
  for (const part of (get("show") ?? "").split(",")) {
    const i = part.indexOf(":");
    if (i <= 0) continue;
    const k = part.slice(0, i) as FacetKey;
    if (!FACET_KEYS.includes(k)) continue;
    try {
      facets[k] = decodeURIComponent(part.slice(i + 1));
    } catch {
      /* a mangled value filters nothing */
    }
  }
  const rawStatus = get("status");
  const legacyRegressed = rawStatus === "regressed";
  return {
    status: legacyRegressed ? "open" : oneOf(rawStatus, STATUS_FILTERS.map((f) => f.key), DEFAULT_QUERY.status),
    lane: legacyRegressed ? "regressed" : oneOf(get("lane"), LANE_FILTERS.map((f) => f.key), DEFAULT_QUERY.lane),
    kind: (get("kind") || null) as GroupKind | null,
    q: get("q") ?? "",
    sort: oneOf(get("sort"), ISSUE_SORTS.map((s) => s.key), DEFAULT_QUERY.sort),
    range: oneOf(get("win"), SPARK_RANGES, DEFAULT_QUERY.range),
    facets,
    mine: (get("show") ?? "").split(",").includes("mine:1"),
    ...((get("show") ?? "").split(",").includes("nobody:1") ? { nobody: true } : {}),
  };
}

/** The address keys for a query; a default writes nothing, so a clean list has a clean address. */
export function issueQueryParams(q: IssueQuery): Record<"status" | "lane" | "kind" | "q" | "sort" | "win" | "show", string | null> {
  const show = [...FACET_KEYS.filter((k) => q.facets[k]).map((k) => `${k}:${encodeURIComponent(q.facets[k]!)}`), ...(q.mine ? ["mine:1"] : []), ...(q.nobody ? ["nobody:1"] : [])].join(",");
  return {
    status: q.status === DEFAULT_QUERY.status ? null : q.status,
    lane: q.status !== "open" || q.lane === DEFAULT_QUERY.lane ? null : q.lane,
    kind: q.kind,
    q: q.q.trim() || null,
    sort: q.sort === DEFAULT_QUERY.sort ? null : q.sort,
    win: q.range === DEFAULT_QUERY.range ? null : q.range,
    show: show || null,
  };
}

export function statusAdmits(status: StatusFilter, g: OpsGroup): boolean {
  if (status === "all") return true;
  const s = issueState(g);
  if (status === "open") return s === "open" || s === "regressed" || s === "ok";
  return s === status;
}

/** The status and, inside Open, the lane. */
export function queryAdmits(q: Pick<IssueQuery, "status" | "lane">, g: OpsGroup, now: number, ctx?: Pick<IssueCtx, "failures">): boolean {
  // Flapping holds every flapper, the ones that read resolved between flips too.
  if (q.status === "open" && q.lane === "flapping") return isFlapping(g, flapsOf(g, now, ctx));
  if (!statusAdmits(q.status, g)) return false;
  return q.status !== "open" || laneAdmits(q.lane, partitionLane(g, laneOf(g, now, ctx), now));
}

/** Every word of the search must appear in the title, culprit, id, release or level. */
export function searchAdmits(q: string, g: OpsGroup): boolean {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = [g.title, g.culprit, g.short_id, g.last_release, g.first_release, g.level].filter(Boolean).join(" ").toLowerCase();
  return words.every((w) => hay.includes(w));
}

/**
 * `taskStatus` answers a problem task's facts (or its status category alone)
 * as this device holds them. `failures` counts a check or metric's flips to
 * failing over the events at hand (failuresIn); without it a lane reads the
 * server's list alone. `latestRelease` is what the Release facet's "latest"
 * names.
 */
export type IssueCtx = { sourceId?: string; taskStatus: (taskId: string) => FixTask | string | undefined; failures?: (g: OpsGroup) => number; latestRelease?: string | null; me?: string | null };

/** A group's flips to failing under a context: over its events when it has them, else the server's list. */
export function flapsOf(g: OpsGroup, now: number, ctx?: Pick<IssueCtx, "failures">): number {
  return ctx?.failures ? ctx.failures(g) : storedFailures(g, now);
}

/**
 * Who answers for a group: its problem task's assignee, as this device holds
 * the task, and only when that task was filed for this issue (creditedTask).
 * A task filed for another title owns nothing here. The list's face, its Mine
 * filter and the page's header all read this one rule.
 */
export function issueOwner(g: Pick<OpsGroup, "signal_task_id" | "title">, ctx: Pick<IssueCtx, "taskStatus">): string | null {
  const t = g.signal_task_id ? asTask(ctx.taskStatus(g.signal_task_id)) : undefined;
  return taskOwner(g, t);
}

/** The owner a problem task gives an issue: its assignee when the task is credited with the issue, else nobody. */
export function taskOwner(g: Pick<OpsGroup, "title">, task: FixTask | null | undefined): string | null {
  return creditedTask(g, task)?.assignee ?? null;
}

/** A group's lane under a context: its flips counted over the context's events when it has them. */
export function laneOf(g: OpsGroup, now: number, ctx?: Pick<IssueCtx, "failures">): IssueLane | null {
  return issueLane(g, now, ctx?.failures ? ctx.failures(g) : undefined);
}

/** The Release facet's value for the newest release, resolved against the context. */
export const LATEST_RELEASE = "latest";

/** Whether someone is on a group under a context (someoneOnIt over its problem task as this device holds it). */
export function issueOnIt(g: Pick<OpsGroup, "signal_task_id" | "fix_conversation_id">, ctx: Pick<IssueCtx, "taskStatus">): boolean {
  return someoneOnIt(g.fix_conversation_id, g.signal_task_id ? ctx.taskStatus(g.signal_task_id) : undefined);
}

export function issueFixStage(g: OpsGroup, ctx: Pick<IssueCtx, "taskStatus">): FixStage {
  return taskFixStage(g, g.signal_task_id ? ctx.taskStatus(g.signal_task_id) : undefined);
}

/**
 * Where an issue's fix stands, read with its problem task as stored. A task
 * filed for another title (creditedTask) says nothing about this issue's fix,
 * and nothing is waiting on it either: the issue reads "other", unless a fix
 * session started on the issue itself. Every surface reads the stage here.
 */
export function taskFixStage(g: Pick<OpsGroup, "title"> & Parameters<typeof fixStage>[0], task: FixTask | string | undefined): FixStage {
  if (typeof task === "string" || !task) return fixStage(g, task);
  const credited = creditedTask(g, task);
  if (credited) return fixStage(g, credited);
  const own = fixStage(g, undefined);
  return own === "filed" ? "other" : own;
}

/** Everything but the status: what the status segment's counts are taken over. */
export function admitsBesidesStatus(q: IssueQuery, g: OpsGroup, ctx: IssueCtx): boolean {
  if (ctx.sourceId && g.source_id !== ctx.sourceId) return false;
  if (q.kind && g.kind !== q.kind) return false;
  if (q.facets.level && g.level !== q.facets.level) return false;
  if (q.facets.type && g.level !== q.facets.type) return false;
  if (q.facets.release) {
    const rel = q.facets.release === LATEST_RELEASE ? ctx.latestRelease : q.facets.release;
    if (!rel || (g.last_release !== rel && g.first_release !== rel)) return false;
  }
  if (q.facets.fix && issueFixStage(g, ctx) !== q.facets.fix) return false;
  if (q.mine && (!ctx.me || issueOwner(g, ctx) !== ctx.me)) return false;
  if (q.nobody && issueOnIt(g, ctx)) return false;
  return searchAdmits(q.q, g);
}

/** Change over the last 24 hours against the 24 before: what "Trend" sorts by. */
export function trendOf(g: Pick<OpsGroup, "buckets">, now: number): { recent: number; prior: number; delta: number } {
  const s = bucketSeries(g.buckets, now, 48);
  const prior = s.slice(0, 24).reduce((a, b) => a + b, 0);
  const recent = s.slice(24).reduce((a, b) => a + b, 0);
  return { recent, prior, delta: recent - prior };
}

const SORT_KEY: Record<IssueSort, (g: OpsGroup, now: number) => number> = {
  urgency: (g) => g.last_seen,
  last: (g) => g.last_seen,
  first: (g) => g.first_seen,
  events: (g) => g.count,
  users: (g) => g.users ?? 0,
  trend: (g, now) => trendOf(g, now).delta,
};

const LANE_PIN: Record<IssueLane, number> = { regressed: 3, escalating: 2, new: 1, firing: 0, flapping: 0, ongoing: 0, quiet: 0 };

const SEVERITY_WEIGHT: Record<string, number> = { fatal: 4, critical: 4, error: 3, warning: 1.5, warn: 1.5 };

/**
 * How urgent an issue in Needs attention is: its lane's weight, its
 * severity, how many it hit lately, and how recently, the last halving its
 * score every 12 hours of quiet. A loud fatal from an hour ago leads; a
 * warning that came back once two days ago sinks.
 */
export function attentionScore(g: OpsGroup, now: number, lane: IssueLane | null): number {
  const laneW = lane === "regressed" ? 1.5 : lane === "escalating" ? 1.4 : 1;
  const sev = g.kind === "check" || g.kind === "metric" || g.kind === "job" ? 2.5 : SEVERITY_WEIGHT[(g.level ?? "").toLowerCase()] ?? 1;
  const volume = 1 + Math.log10(1 + escalation(g, now).recent);
  const recency = 0.5 ** (Math.max(0, now - g.last_seen) / (12 * HOUR));
  return laneW * sev * volume * recency;
}

/**
 * The list in the chosen order, highest first, ties newest first. Urgency is
 * the only order that pins lanes: on it regressed issues lead (a fix that did
 * not hold is the first thing to see), then escalating, then new, and Needs
 * attention orders by attentionScore. A column sort (Events, Users, Trend,
 * first or last seen) orders the whole list strictly by its key.
 */
export function sortIssues(rows: OpsGroup[], sort: IssueSort, now: number, pinLanes: boolean, ctx?: Pick<IssueCtx, "failures">, byAttention = false): OpsGroup[] {
  const key = SORT_KEY[sort];
  const keyed = rows.map((g) => {
    const lane = pinLanes || byAttention ? laneOf(g, now, ctx) : null;
    // By urgency a regression still leads: a fix that did not hold is the first thing to see in any open list.
    return byAttention ? { g, k: attentionScore(g, now, lane), pin: lane === "regressed" ? 1 : 0 } : { g, k: key(g, now), pin: lane ? LANE_PIN[lane] : 0 };
  });
  keyed.sort((a, b) => b.pin - a.pin || b.k - a.k || b.g.last_seen - a.g.last_seen);
  return keyed.map((x) => x.g);
}

export function filterIssues(rows: OpsGroup[], q: IssueQuery, ctx: IssueCtx, now: number): OpsGroup[] {
  const kept = rows.filter((g) => queryAdmits(q, g, now, ctx) && admitsBesidesStatus(q, g, ctx));
  const sort = effectiveSort(q);
  return sortIssues(kept, sort, now, q.sort === "urgency" && (q.status === "open" || q.status === "all"), ctx, sort === "urgency");
}

/** The order a list is in: Urgency ranks open issues only; a settled list reads it as last seen. */
export function effectiveSort(q: Pick<IssueQuery, "sort" | "status">): IssueSort {
  return q.sort === "urgency" && q.status !== "open" ? "last" : q.sort;
}

export type IssueCounts = Record<StatusFilter, number> & Record<LaneFilter, number>;

/** A segment's count. The "all" lane is every open issue, never every status. */
export function laneCount(counts: IssueCounts, lane: LaneFilter): number {
  return lane === "all" ? counts.open : counts[lane];
}

/** Each status and each open lane's count, over everything but the status and lane. */
export function statusCounts(rows: OpsGroup[], q: IssueQuery, ctx: IssueCtx, now: number = Date.now()): IssueCounts {
  const out: IssueCounts = { open: 0, regressed: 0, resolved: 0, ignored: 0, all: 0, attention: 0, escalating: 0, new: 0, firing: 0, flapping: 0, ongoing: 0, quiet: 0 };
  for (const g of rows) {
    if (!admitsBesidesStatus(q, g, ctx)) continue;
    out.all++;
    const s = issueState(g);
    if (s === "resolved") out.resolved++;
    if (s === "ignored") out.ignored++;
    if (isFlapping(g, flapsOf(g, now, ctx))) out.flapping++;
    const lane = partitionLane(g, laneOf(g, now, ctx), now);
    if (!lane) continue;
    out.open++;
    out[lane]++;
    if (laneAdmits("attention", lane)) out.attention++;
  }
  return out;
}

/**
 * The rows a facet counts over: everything the list's query admits with that
 * one facet let go, so each option's count is how many rows picking it would
 * show. "kind" lets go of the kind, "source" of the source.
 */
export function facetRows(rows: OpsGroup[], q: IssueQuery, ctx: IssueCtx, now: number, key: FacetKey | "kind" | "source"): OpsGroup[] {
  const facets = { ...q.facets };
  if (key !== "kind" && key !== "source") delete facets[key];
  const q2: IssueQuery = { ...q, facets, kind: key === "kind" ? null : q.kind };
  const ctx2 = key === "source" ? { ...ctx, sourceId: undefined } : ctx;
  return rows.filter((g) => queryAdmits(q2, g, now, ctx2) && admitsBesidesStatus(q2, g, ctx2));
}

/** A facet's values over the rows, most common first: the dropdown's options with their counts. */
export function facetOptions(rows: OpsGroup[], key: FacetKey, ctx: IssueCtx): { value: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const g of rows) {
    const v =
      key === "level" ? (isSeverity(g.level) ? g.level : undefined)
      : key === "type" ? (g.level && !isSeverity(g.level) && g.level !== "none" ? g.level : undefined)
      : key === "release" ? g.last_release
      : issueFixStage(g, ctx);
    if (!v) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  const out = [...counts].map(([value, count]) => ({ value, count }));
  return key === "fix" ? out.sort((a, b) => FIX_STAGES.indexOf(a.value as FixStage) - FIX_STAGES.indexOf(b.value as FixStage)) : out.sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

/** A picked value stays among the options at a count of zero, so the select still names what filters the list. */
export function withPicked<T extends { value: string; count: number }>(options: T[], picked: string | undefined, make: (value: string) => T): T[] {
  return !picked || options.some((o) => o.value === picked) ? options : [make(picked), ...options];
}

/**
 * When each release appeared: its first deploy this device holds, else the
 * first time any group was seen in it. Newest first is the order the Release
 * facet offers them in.
 */
export function releaseTimes(groups: Pick<OpsGroup, "source_id" | "first_seen" | "last_seen" | "first_release" | "last_release">[], events: OpsEvent[], sourceId?: string): Map<string, number> {
  const out = new Map<string, number>();
  const take = (rel: string | undefined, at: number) => {
    if (rel && (!out.has(rel) || at < out.get(rel)!)) out.set(rel, at);
  };
  for (const e of events) if (e.kind === "deploy" && (!sourceId || e.source_id === sourceId)) take(e.data?.release, e.created_at);
  const deployed = new Set(out.keys());
  for (const g of groups) {
    if (sourceId && g.source_id !== sourceId) continue;
    if (g.first_release && !deployed.has(g.first_release)) take(g.first_release, g.first_seen);
    if (g.last_release && !deployed.has(g.last_release) && g.last_release !== g.first_release) take(g.last_release, g.last_seen);
  }
  return out;
}

/** Release options newest first, each with when it appeared. */
export function releaseOptions(options: { value: string; count: number }[], times: Map<string, number>): { value: string; count: number; at: number | null }[] {
  return options.map((o) => ({ ...o, at: times.get(o.value) ?? null })).sort((a, b) => (b.at ?? 0) - (a.at ?? 0) || b.count - a.count);
}

/** The newest release over the rows' own releases, by releaseTimes. */
export function latestRelease(times: Map<string, number>, among: Iterable<string>): string | null {
  let best: string | null = null;
  for (const r of among) if (times.has(r) && (best === null || times.get(r)! > times.get(best)!)) best = r;
  return best;
}

/** The rows a shift-click selects: every row between the anchor and the target, inclusive, in list order. */
export function rangeIds(order: string[], anchor: string | null, target: string): string[] {
  const b = order.indexOf(target);
  const a = anchor ? order.indexOf(anchor) : -1;
  if (a < 0 || b < 0) return [target];
  return order.slice(Math.min(a, b), Math.max(a, b) + 1);
}

// ── The occurrence chart ──

export type ChartRange = "24h" | "72h" | "7d" | "30d" | "90d";
export const CHART_RANGES: { key: ChartRange; hours: number }[] = [
  { key: "24h", hours: 24 },
  { key: "7d", hours: 7 * 24 },
  { key: "30d", hours: 30 * 24 },
  { key: "90d", hours: 90 * 24 },
];
export type ChartMark = { x: number; at: number; label: string; tone: "release" | "resolved" | "regressed" | "new" | "fix" | "other" };
export type ChartBar = { at: number; count: number; /** No count was kept this far back. */ unknown?: boolean };
/** Deploys that explain nothing in particular, bunched one per bar width under the x axis. */
export type DeployTick = { x: number; at: number; n: number; label: string };
export type ChartLayout = {
  start: number; hours: number; step: number; bars: ChartBar[]; max: number; total: number;
  /** The total is the group's whole count: the window holds its whole life, so no day before the counts is in doubt. */
  exact: boolean;
  ticks: { x: number; at: number }[]; marks: ChartMark[]; deployTicks: DeployTick[]; lastDeploy: number | null;
};

const MARK_TONE: Record<string, ChartMark["tone"]> = { deploy: "release", resolved: "resolved", regressed: "regressed", new: "new", fix: "fix" };

/**
 * The narrowest range whose window holds the group's last occurrence, so the
 * chart opens on bars rather than an empty grid. A job runs on a schedule, so
 * a day of it is one bar: it opens on a week at least.
 */
export function chartRangeFor(g: Pick<OpsGroup, "last_seen"> & Partial<Pick<OpsGroup, "kind">>, now: number): ChartRange {
  const floor = g.kind === "job" ? 7 * 24 : 0;
  return (CHART_RANGES.find((r) => r.hours >= floor && now - g.last_seen < r.hours * HOUR) ?? CHART_RANGES[CHART_RANGES.length - 1]).key;
}

/**
 * Where the group's counts reach back to: its hourly window, and its daily
 * counts as far as they go (a group that predates them was seeded from its
 * hours on its first write since, so days before that are not known).
 */
export function countsSince(g: Pick<OpsGroup, "days" | "first_seen">, now: number): number {
  const hourFloor = Math.floor(now / HOUR) * HOUR - (GROUP_RULES.bucket_hours - 1) * HOUR;
  const dayFloor = g.days?.length ? Math.floor(g.days[0].day / DAY) * DAY : Infinity;
  return Math.max(g.first_seen - HOUR, Math.min(hourFloor, dayFloor));
}

/**
 * Daily counts for the last `n` days ending today, oldest first: the larger
 * of the stored day and the hourly buckets that fall in it, since either may
 * be ahead of the other by a write. Days before the counts reach back are
 * marked unknown rather than drawn as zero.
 */
export function dailySeries(g: Pick<OpsGroup, "buckets" | "days" | "first_seen">, now: number, n: number): ChartBar[] {
  const today = Math.floor(now / DAY) * DAY;
  const start = today - (n - 1) * DAY;
  const fromDays = new Map((g.days ?? []).map((d) => [Math.floor(d.day / DAY) * DAY, d.count]));
  const fromHours = new Map<number, number>();
  for (const b of g.buckets) {
    const d = Math.floor(b.hour / DAY) * DAY;
    fromHours.set(d, (fromHours.get(d) ?? 0) + b.count);
  }
  const since = countsSince(g, now);
  const out: ChartBar[] = [];
  for (let i = 0; i < n; i++) {
    const at = start + i * DAY;
    const count = Math.max(fromDays.get(at) ?? 0, fromHours.get(at) ?? 0);
    out.push(at + DAY <= since && at + DAY > g.first_seen ? { at, count, unknown: count === 0 } : { at, count });
  }
  return out;
}

/**
 * The page chart: hourly bars up to 72 hours, daily bars past that, ticks,
 * and marks for the group's own transitions, the fix that closed it and the
 * deploys of its source, each placed by time (x in 0..1 across the window).
 * Only a deploy that may explain the chart draws a full line: the one the
 * issue first appeared after, the one before each regression, the one just
 * before a spike. Every other deploy is a tick under the axis, one per bar
 * width with its count. `lastDeploy` is the newest deploy inside the window,
 * so the chart can shade what came after it.
 */
export function layoutChart(
  group: Pick<OpsGroup, "_id" | "short_id" | "source_id" | "buckets"> & Partial<Pick<OpsGroup, "days" | "first_seen" | "last_seen" | "count" | "first_release">>,
  events: OpsEvent[],
  now: number,
  hours: number,
  fix?: { at: number; label: string } | null,
): ChartLayout {
  const daily = hours > GROUP_RULES.bucket_hours;
  const step = daily ? DAY : HOUR;
  const bars: ChartBar[] = daily
    ? dailySeries({ buckets: group.buckets, days: group.days, first_seen: group.first_seen ?? 0 }, now, Math.round(hours / 24))
    : bucketSeries(group.buckets, now, hours).map((count, i, all) => ({ at: Math.floor(now / HOUR) * HOUR - (all.length - 1 - i) * HOUR, count }));
  const end = bars[bars.length - 1].at + step;
  const start = bars[0].at;
  const exact = settleUnknownDays(bars, group, start, step);
  const span = end - start;
  const x = (at: number) => Math.min(1, Math.max(0, (at - start) / span));
  const tickStep = hours <= 24 ? 6 * HOUR : hours <= 72 ? 24 * HOUR : hours <= 7 * 24 ? DAY : hours <= 30 * 24 ? 7 * DAY : 14 * DAY;
  const ticks: ChartLayout["ticks"] = [];
  for (let at = Math.ceil(start / tickStep) * tickStep; at < end; at += tickStep) ticks.push({ x: x(at), at });
  const marks: ChartMark[] = [];
  const deploys: { at: number; release: string }[] = [];
  const regressions: number[] = [];
  for (const e of events) {
    if (e.created_at < start || e.created_at > end) continue;
    const mine = e.group_id === group._id || e.data?.group_short_id === group.short_id;
    const deploy = e.kind === "deploy" && e.source_id === group.source_id;
    if (!mine && !deploy) continue;
    if (deploy) {
      deploys.push({ at: e.created_at, release: e.data?.release ?? "deploy" });
      continue;
    }
    const t = e.data?.transition ?? e.kind;
    if (t === "regressed" || e.kind === "error_regressed") regressions.push(e.created_at);
    marks.push({ x: x(e.created_at), at: e.created_at, label: t, tone: MARK_TONE[t] ?? "other" });
  }
  deploys.sort((a, b) => a.at - b.at);
  const lastDeploy = deploys.length ? deploys[deploys.length - 1].at : null;
  const key = keyDeploys(deploys, bars, step, group, regressions);
  // One tick per bucket of bars, centred on it, so two counts never sit on top of each other: a bar each up to 15, wider past that.
  const per = Math.max(1, Math.ceil(bars.length / 15));
  const bucket = (at: number) => Math.floor((at - start) / step / per);
  const deployTicks: DeployTick[] = [];
  for (const [i, d] of deploys.entries()) {
    if (key.has(i)) {
      marks.push({ x: x(d.at), at: d.at, label: d.release, tone: "release" });
      continue;
    }
    const b = bucket(d.at);
    const cx = Math.min(1, ((b + 0.5) * per) / bars.length);
    const prev = deployTicks[deployTicks.length - 1];
    if (prev && bucket(prev.at) === b) deployTicks[deployTicks.length - 1] = { x: cx, at: d.at, n: prev.n + 1, label: d.release };
    else deployTicks.push({ x: cx, at: d.at, n: 1, label: d.release });
  }
  if (fix && fix.at >= start && fix.at <= end) marks.push({ x: x(fix.at), at: fix.at, label: fix.label, tone: "fix" });
  const counts = bars.map((b) => b.count);
  const total = exact ? group.count! : counts.reduce((a, b) => a + b, 0);
  return { start, hours, step, bars, max: Math.max(0, ...counts), total, exact, ticks, marks: thinMarks(marks), deployTicks, lastDeploy };
}

/**
 * When the window holds the group's whole life, its count says how many
 * events the days before the daily counts can hold: none left over makes
 * them zero, and exactly one each for the first and last seen days places
 * those. Returns whether the window's total is the group's count.
 */
function settleUnknownDays(bars: ChartBar[], g: Partial<Pick<OpsGroup, "first_seen" | "last_seen" | "count">>, start: number, step: number): boolean {
  if (g.count === undefined || g.first_seen === undefined || g.first_seen < start) return false;
  const unknown = bars.flatMap((b, i) => (b.unknown ? [i] : []));
  if (!unknown.length) return bars.reduce((a, b) => a + b.count, 0) === g.count;
  const left = g.count - bars.reduce((a, b) => a + (b.unknown ? 0 : b.count), 0);
  const dayOf = (at: number | undefined) => (at === undefined ? -1 : Math.floor((at - start) / step));
  const must = [...new Set([dayOf(g.first_seen), dayOf(g.last_seen)])].filter((i) => bars[i]?.unknown);
  if (left > 0 && left !== must.length) return true;
  for (const i of unknown) bars[i] = { at: bars[i].at, count: left > 0 && must.includes(i) ? 1 : 0 };
  return true;
}

/** The deploys worth a full line: the one before first seen, before each regression, and just before a spike. */
function keyDeploys(deploys: { at: number; release: string }[], bars: ChartBar[], step: number, g: Partial<Pick<OpsGroup, "first_seen" | "first_release">>, regressions: number[]): Set<number> {
  const out = new Set<number>();
  const before = (at: number, within = Infinity) => {
    for (let i = deploys.length - 1; i >= 0; i--) if (deploys[i].at <= at) return at - deploys[i].at <= within ? i : -1;
    return -1;
  };
  const first = g.first_release ? deploys.findIndex((d) => d.release === g.first_release) : -1;
  const add = (i: number) => i >= 0 && out.add(i);
  add(first >= 0 ? first : g.first_seen !== undefined ? before(g.first_seen) : -1);
  for (const at of regressions) add(before(at));
  for (const [i, b] of bars.entries()) {
    if (b.unknown || b.count < 3) continue;
    const prior = bars.slice(Math.max(0, i - 3), i).filter((p) => !p.unknown);
    const usual = prior.length ? prior.reduce((a, p) => a + p.count, 0) / prior.length : 0;
    if (b.count >= 3 * Math.max(1, usual) && (bars[i - 1]?.count ?? 0) < b.count / 2) add(before(b.at + step, 2 * step));
  }
  return out;
}

/**
 * Marks close enough to collide keep one label: a deploy beside a
 * transition gives way to it, and of two deploys the newer names the spot.
 * The dropped ones stay as lines without a label.
 */
export function thinMarks(marks: ChartMark[], minGap = 0.09): ChartMark[] {
  const sorted = [...marks].sort((a, b) => a.x - b.x || a.at - b.at);
  const rank = (m: ChartMark) => (m.tone === "release" ? 0 : 1);
  let lastLabeled: ChartMark | null = null;
  const out: ChartMark[] = [];
  for (const m of sorted) {
    if (lastLabeled && m.x - lastLabeled.x < minGap) {
      if (rank(m) >= rank(lastLabeled)) {
        out[out.indexOf(lastLabeled)] = { ...lastLabeled, label: "" };
        lastLabeled = m;
        out.push(m);
      } else out.push({ ...m, label: "" });
      continue;
    }
    lastLabeled = m;
    out.push(m);
  }
  return out;
}

/**
 * The y axis for a peak: a round top at or above it and its half when that
 * is a whole number, each value once. A peak of 1 reads 1 and 0, never 1, 1, 0.
 */
export function yTicks(max: number): { top: number; ticks: { value: number; y: number }[] } {
  const peak = Math.max(1, Math.ceil(max));
  let top = peak;
  if (peak > 5) {
    const mag = 10 ** Math.floor(Math.log10(peak));
    top = ([1, 2, 2.5, 5, 10].map((m) => m * mag).find((t) => t >= peak && Number.isInteger(t)) ?? 10 * mag);
  }
  const values = [top, top / 2, 0].filter((v, i, all) => Number.isInteger(v) && all.indexOf(v) === i);
  return { top, ticks: values.map((value) => ({ value, y: 1 - value / top })) };
}

/**
 * An issue's whole life on one axis, from first seen (or 90 days back) to
 * now: its own transitions and its source's releases, each placed by time.
 * What the hourly chart cannot show: where it began, in which release, and
 * each time it was resolved and came back.
 */
export function lifeMarks(group: Pick<OpsGroup, "_id" | "short_id" | "source_id" | "first_seen" | "first_release">, events: OpsEvent[], now: number, maxDays = 90): { start: number; clipped: boolean; marks: ChartMark[] } {
  const floor = now - maxDays * 24 * HOUR;
  const start = Math.max(group.first_seen, floor);
  const span = Math.max(HOUR, now - start);
  const x = (at: number) => Math.min(1, Math.max(0, (at - start) / span));
  const marks: ChartMark[] = [];
  for (const e of events) {
    if (e.created_at < start || e.created_at > now) continue;
    const mine = e.group_id === group._id || e.data?.group_short_id === group.short_id;
    const deploy = e.kind === "deploy" && e.source_id === group.source_id;
    if (!mine && !deploy) continue;
    const t = deploy ? "deploy" : e.data?.transition ?? e.kind;
    if (t === "new" || e.kind === "error_new") continue;
    marks.push({ x: x(e.created_at), at: e.created_at, label: deploy ? e.data?.release ?? "deploy" : t, tone: MARK_TONE[t] ?? "other" });
  }
  marks.unshift({ x: 0, at: group.first_seen, label: group.first_release ? `first seen in ${group.first_release}` : "first seen", tone: "new" });
  return { start, clipped: group.first_seen < floor, marks: marks.sort((a, b) => a.at - b.at) };
}

// ── A check or metric's state over time ──

export type HealthState = "failing" | "passing" | "none";
export type StateSpan = { from: number; to: number; state: HealthState };

const FAILING_TRANSITIONS = new Set(["check_failed", "metric_alert", "job_failed", "new", "regressed", "spike"]);
const PASSING_TRANSITIONS = new Set(["check_recovered", "metric_recovered", "resolved"]);

/** The state a transition row leaves its group in, or null for a row that moves nothing (a deploy). */
export function transitionState(e: Pick<OpsEvent, "kind" | "data">): Exclude<HealthState, "none"> | null {
  const t = e.data?.transition ?? e.kind;
  if (FAILING_TRANSITIONS.has(t)) return "failing";
  if (PASSING_TRANSITIONS.has(t)) return "passing";
  if (e.kind === "error_new" || e.kind === "error_regressed") return "failing";
  return null;
}

/** Whether a check or metric group is passing right now, by its own reading. */
export function currentHealth(g: Pick<OpsGroup, "status" | "meta">): Exclude<HealthState, "none"> {
  return g.meta?.ok === true || g.status === "resolved" ? "passing" : "failing";
}

export type HealthStrip = {
  start: number;
  end: number;
  spans: StateSpan[];
  /** When the current failing run began; null while passing. */
  failingSince: number | null;
  /** The newest flip to passing that this device has read, if any: when the current passing run began. */
  lastPass: number | null;
  /**
   * While failing, the last moment it was green: the last passing reading the
   * group recorded (meta.last_ok_at), else the flip that ended the passing
   * run before this failure. Null when no pass is on record. While passing, now.
   */
  lastGreen: number | null;
  /** Failing runs that show inside the window, one carried in from before it included. */
  failures: number;
  /** Share of the known window spent failing, 0..1. */
  failingShare: number;
};

/**
 * A check or metric's failing and passing spans over [end - hours, end],
 * from its transition rows and its current reading. Before the group was
 * first seen there is no state; before the oldest flip read, the state is
 * the one that flip left.
 */
export function healthStrip(g: Pick<OpsGroup, "_id" | "short_id" | "first_seen" | "status" | "meta">, events: OpsEvent[], now: number, hours: number): HealthStrip {
  const end = now;
  const start = end - hours * HOUR;
  const flips = events
    .filter((e) => e.group_id === g._id || e.data?.group_short_id === g.short_id)
    .map((e) => ({ at: e.created_at, state: transitionState(e) }))
    .filter((f): f is { at: number; state: "failing" | "passing" } => f.state !== null && f.at <= end)
    .sort((a, b) => a.at - b.at);
  const current = currentHealth(g);
  const stateAt = (t: number): HealthState => {
    if (t < g.first_seen) return "none";
    let last: (typeof flips)[number] | undefined;
    for (const f of flips) if (f.at <= t) last = f;
    if (last) return last.state;
    if (flips.length) return flips[0].state === "failing" ? "passing" : "failing";
    return current;
  };
  const cuts = [start, ...(g.first_seen > start && g.first_seen < end ? [g.first_seen] : []), ...flips.map((f) => f.at).filter((at) => at > start && at < end), end];
  const spans: StateSpan[] = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const from = cuts[i];
    const to = cuts[i + 1];
    if (to <= from) continue;
    // The newest span is the group's own reading, whatever the last flip read here said.
    const state = i === cuts.length - 2 && to === end && stateAt(from) !== "none" ? current : stateAt(from);
    const prev = spans[spans.length - 1];
    if (prev && prev.state === state) prev.to = to;
    else spans.push({ from, to, state });
  }
  let failingSince: number | null = null;
  if (current === "failing") {
    const lastPassFlip = [...flips].reverse().find((f) => f.state === "passing");
    const firstFail = flips.find((f) => f.state === "failing" && (!lastPassFlip || f.at > lastPassFlip.at));
    failingSince = firstFail?.at ?? (lastPassFlip ? null : g.first_seen);
  }
  const lastPass = [...flips].reverse().find((f) => f.state === "passing")?.at ?? null;
  let lastGreen: number | null = current === "passing" ? end : null;
  if (current === "failing") {
    const okAt = g.meta?.last_ok_at;
    const flippedFromGreen = failingSince !== null && failingSince > g.first_seen && stateAt(failingSince - 1) === "passing";
    lastGreen = okAt !== undefined && (failingSince === null || okAt <= failingSince) ? okAt : flippedFromGreen ? failingSince : null;
  }
  const known = spans.filter((s) => s.state !== "none").reduce((a, s) => a + (s.to - s.from), 0);
  const failingMs = spans.filter((s) => s.state === "failing").reduce((a, s) => a + (s.to - s.from), 0);
  return {
    start,
    end,
    spans,
    failingSince,
    lastPass,
    lastGreen,
    failures: spans.filter((s) => s.state === "failing").length,
    failingShare: known ? failingMs / known : 0,
  };
}

/**
 * Where a state strip's axis labels go: on whole hours across a day, on
 * midnights across a week, every few midnights past it, so each label sits
 * at the moment it names and the gaps between them are equal.
 */
export function stripTicks(start: number, end: number, hours: number): { x: number; at: number; day: boolean }[] {
  const span = end - start;
  const day = hours > 24;
  const stepH = hours <= 24 ? 6 : hours <= 24 * 7 ? 24 : hours <= 24 * 30 ? 24 * 7 : 24 * 15;
  const first = new Date(start);
  if (day) first.setHours(24, 0, 0, 0);
  else first.setHours(first.getHours() + 1, 0, 0, 0);
  // Hour ticks fall on multiples of the step so a day reads 0, 6, 12, 18.
  if (!day) while (first.getHours() % stepH) first.setHours(first.getHours() + 1);
  const out: { x: number; at: number; day: boolean }[] = [];
  for (let d = new Date(first); d.getTime() < end; ) {
    const at = d.getTime();
    const x = (at - start) / span;
    // A label hard against "now" would collide with it.
    if (x < 0.94) out.push({ x, at, day });
    if (day) d.setDate(d.getDate() + stepH / 24);
    else d.setHours(d.getHours() + stepH);
  }
  return out;
}

// ── Samples: the tag breakdown and the replay moment ──

const PREFERRED_TAGS = ["browser", "os", "device", "environment", "release", "url", "user", "level", "runtime", "server_name"];

/** A sample's value for a tag key: its own fields first, then its tags. */
export function sampleTag(s: OpsSample, key: string, tags?: Record<string, unknown> | null): string | null {
  // A job's failure split filters the samples by what each said (jobFailureSplit).
  if (key === FAILURE_KEY) return failureMessageKey(s.message) || null;
  if (key === "environment") return s.environment ?? null;
  if (key === "release") return s.release ?? null;
  if (key === "level") return s.level ?? null;
  if (key === "user") return s.user?.email ?? s.user?.name ?? s.user?.id ?? null;
  if (key === "url") {
    if (!s.url) return null;
    try {
      const u = new URL(s.url);
      return `${u.host}${u.pathname}`;
    } catch {
      return s.url;
    }
  }
  const v = (tags ?? parseTags(s.tags_json))?.[key];
  return v === undefined || v === null || v === "" ? null : String(v);
}

export function parseTags(text: string | undefined): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/** `distinct` is how many values the key took; a key where nearly every sample differs (`spread`) says nothing by its top values. */
export type TagFacet = { key: string; total: number; distinct: number; spread: boolean; values: { value: string; count: number; share: number }[] };

/**
 * Each tag key across the kept samples with its top values and their share,
 * the keys people triage by first. Only keys at least one sample carries.
 */
export function sampleFacets(samples: OpsSample[], topN = 4, maxKeys = 10): TagFacet[] {
  const byKey = new Map<string, Map<string, number>>();
  for (const s of samples) {
    const tags = parseTags(s.tags_json);
    const keys = new Set([...PREFERRED_TAGS, ...Object.keys(tags ?? {})]);
    for (const k of keys) {
      const v = sampleTag(s, k, tags);
      if (v === null) continue;
      const m = byKey.get(k) ?? new Map<string, number>();
      m.set(v, (m.get(v) ?? 0) + 1);
      byKey.set(k, m);
    }
  }
  const rank = (k: string) => (PREFERRED_TAGS.includes(k) ? PREFERRED_TAGS.indexOf(k) : PREFERRED_TAGS.length);
  return [...byKey]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .slice(0, maxKeys)
    .map(([key, m]) => {
      const total = [...m.values()].reduce((a, b) => a + b, 0);
      const values = [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, topN).map(([value, count]) => ({ value, count, share: count / total }));
      return { key, total, distinct: m.size, spread: total >= 4 && m.size >= total * 0.8, values };
    });
}

const firstLine = (v: unknown): string | null => {
  if (typeof v === "string") return v.trim() || null;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const m = o.message ?? o.value ?? o.error ?? o.reason;
    if (typeof m === "string" && m.trim()) return [typeof o.type === "string" ? o.type : typeof o.name === "string" ? o.name : null, m.trim()].filter(Boolean).join(": ");
  }
  return null;
};

/**
 * The line that says what went wrong in a sample, as an exception's type and
 * value: the first of its context's errors, its exception or error, else its
 * own message when the title does not already say it. A title like "1
 * provider write(s) failed" keeps the cause in the context, and this is the
 * line a person and an agent both need first. Null when nothing adds to the title.
 */
export function exceptionValue(s: Pick<OpsSample, "message" | "context_json">, title: string): string | null {
  const ctx = parseTags(s.context_json);
  const fromCtx = ctx
    ? (Array.isArray(ctx.errors) && ctx.errors.length ? firstLine(ctx.errors[0]) : null) ?? firstLine(ctx.exception) ?? firstLine(ctx.error) ?? firstLine(ctx.cause)
    : null;
  const v = fromCtx ?? (s.message && s.message.trim() !== title.trim() ? s.message.trim() : null);
  return v && v !== title.trim() && !title.includes(v) ? v : null;
}

/** The distinct people the kept samples name: a floor on who an issue hit, where the group counts none. */
export function sampleUsers(samples: Pick<OpsSample, "user">[]): number {
  return new Set(samples.map((s) => s.user?.email ?? s.user?.id ?? s.user?.name).filter(Boolean)).size;
}

/**
 * Where in its replay a sample happened, on the replay's own clock (ms since
 * it started), clamped into the recording. Null when the replay's start is
 * unknown.
 */
export function replayOffset(sampleAt: number, replay: { started_at?: number | null; duration_ms?: number | null } | null | undefined): number | null {
  if (!replay?.started_at) return null;
  const t = Math.max(0, sampleAt - replay.started_at);
  return replay.duration_ms ? Math.min(t, replay.duration_ms) : t;
}

// ── A stack as frame rows ──

export type StackFrameRow = { type: "frame"; i: number; fn: string; file: string; line: number | null; col: number | null; raw: string; in_app: boolean; minified: boolean };
export type StackRow = { type: "message"; text: string } | StackFrameRow | { type: "library"; frames: StackFrameRow[] };

/**
 * A stack read as rows: message lines, the product's own frames one by one,
 * and runs of two or more library frames folded into one row in place, so
 * the order of the stack survives. A frame whose line number is past 10,000
 * or whose file sits under a dist or build folder reads as minified.
 */
export function stackRows(stack: string | undefined): StackRow[] {
  if (!stack) return [];
  const out: StackRow[] = [];
  let run: StackFrameRow[] = [];
  const flush = () => {
    if (run.length >= 2) out.push({ type: "library", frames: run });
    else out.push(...run);
    run = [];
  };
  let i = 0;
  for (const rawLine of stack.split("\n")) {
    if (!rawLine.trim()) continue;
    const f = parseStackFrame(rawLine);
    if (!f) {
      flush();
      out.push({ type: "message", text: rawLine.trim() });
      continue;
    }
    const pos = /:(\d+)(?::(\d+))?\)?$/.exec(f.loc);
    const line = pos ? Number(pos[1]) : null;
    const row: StackFrameRow = {
      type: "frame",
      i: i++,
      fn: f.fn || "<anonymous>",
      file: f.file,
      line,
      col: pos?.[2] ? Number(pos[2]) : null,
      raw: rawLine.trim(),
      in_app: f.in_app,
      minified: (line ?? 0) > 10_000 || /\/(dist|build|_next\/static)\/|\.min\.js/.test(f.file),
    };
    if (row.in_app) {
      flush();
      out.push(row);
    } else run.push(row);
  }
  flush();
  return out;
}

/** The frame a stack opens on: the first of the product's own, else the first frame. */
export function leadFrame(rows: StackRow[]): number | null {
  const frames = rows.flatMap((r) => (r.type === "frame" ? [r] : r.type === "library" ? r.frames : []));
  return (frames.find((f) => f.in_app) ?? frames[0])?.i ?? null;
}

// ── Activity: every change to an issue on one list ──

export type ActivityItem = {
  at: number;
  /** What happened, as a verb phrase. */
  what: string;
  tone: "bad" | "good" | "fix" | "quiet";
  release?: string;
  sha?: string;
  session?: string;
  task?: string;
  /** Who or what did it, on a resolve: a person, a recovery, the vendor. */
  resolver?: Resolver;
  /** The same step repeated back to back, folded into one line. */
  n?: number;
};

const TRANSITION_WORDS: Record<string, { what: string; tone: ActivityItem["tone"] }> = {
  new: { what: "first seen", tone: "bad" },
  regressed: { what: "regressed", tone: "bad" },
  spike: { what: "spiked", tone: "bad" },
  resolved: { what: "resolved", tone: "good" },
  check_failed: { what: "check failed", tone: "bad" },
  check_recovered: { what: "check recovered", tone: "good" },
  metric_alert: { what: "crossed its line", tone: "bad" },
  metric_recovered: { what: "back within its line", tone: "good" },
  job_failed: { what: "job failed", tone: "bad" },
};

/**
 * The issue's transitions and its fix chain as one list, newest first:
 * every flip the server announced, the resolve a regression implies (which
 * the transitions alone may not carry), the fix session started from the
 * issue, and how its problem task closed. The same step repeated back to
 * back (two deliveries of one spike) folds into one line with a count, and
 * the latest resolve names who or what did it.
 */
export function issueActivity(
  g: Pick<OpsGroup, "_id" | "short_id" | "first_seen" | "first_release" | "resolved_at" | "resolved_in" | "fix_conversation_id" | "fix_started_at"> &
    Partial<Pick<OpsGroup, "kind" | "resolved_via" | "resolved_by" | "external" | "last_transition" | "last_transition_at">>,
  events: OpsEvent[],
  task: (FixTask & { short_id?: string }) | null,
): ActivityItem[] {
  const out: ActivityItem[] = [];
  for (const e of events) {
    if (e.group_id !== g._id && e.data?.group_short_id !== g.short_id) continue;
    const t = e.data?.transition ?? (e.kind === "error_new" ? "new" : e.kind === "error_regressed" ? "regressed" : e.kind);
    const w = TRANSITION_WORDS[t] ?? { what: t.replace(/_/g, " "), tone: "quiet" as const };
    out.push({ at: e.created_at, what: w.what, tone: w.tone, release: e.data?.release });
  }
  const near = (at: number, what: string) => out.some((i) => i.what === what && Math.abs(i.at - at) < 5 * 60_000);
  if (!out.some((i) => i.what === "first seen")) out.push({ at: g.first_seen, what: "first seen", tone: "bad", release: g.first_release });
  if (g.resolved_at !== undefined && !near(g.resolved_at, "resolved") && !near(g.resolved_at, "check recovered") && !near(g.resolved_at, "back within its line")) {
    out.push({ at: g.resolved_at, what: "resolved", tone: "good", release: g.resolved_in });
  }
  if (g.fix_conversation_id && g.fix_started_at) out.push({ at: g.fix_started_at, what: "fix session started", tone: "fix", session: g.fix_conversation_id });
  if (task?.landed) out.push({ at: task.landed.at, what: "fix landed", tone: "fix", sha: task.landed.sha, task: task.short_id });
  else if (task?.cause?.dissolved) out.push({ at: task.cause.dissolved.at, what: "problem dissolved", tone: "quiet", task: task.short_id });
  else if (task?.closed_at && (task.status === "done" || task.status === "dropped")) out.push({ at: task.closed_at, what: task.status === "done" ? "problem closed" : "problem dropped", tone: task.status === "done" ? "fix" : "quiet", task: task.short_id });
  out.sort((a, b) => b.at - a.at);
  // The resolve the group's stamps describe names its resolver; an older vendor resolve names the vendor.
  const latest = g.resolved_at !== undefined ? out.find((i) => i.what === "resolved" && Math.abs(i.at - g.resolved_at!) < 5 * 60_000) : undefined;
  if (latest) latest.resolver = resolverOf(g, events);
  for (const i of out) if (i.what === "resolved" && !i.resolver && g.external) i.resolver = { via: "vendor" };
  const folded: ActivityItem[] = [];
  const same = (a: ActivityItem, b: ActivityItem) => a.what === b.what && a.release === b.release && a.sha === b.sha && a.task === b.task && a.session === b.session && !a.resolver && !b.resolver;
  for (const i of out) {
    const prev = folded[folded.length - 1];
    if (prev && same(prev, i)) prev.n = (prev.n ?? 1) + 1;
    else folded.push(i);
  }
  return folded;
}

// ── What broke it: CI runs and the suspect commit ──

export type CiRunRow = { at: number; sha: string | null; ok: boolean; conclusion: string; url?: string; run_id?: string; branch?: string };

const PASSING_CONCLUSIONS = new Set(["success"]);

/**
 * A check's kept runs, newest first, each with its commit, branch and how it
 * ended. A CI run's sample carries the sha, branch and run in its context
 * and the conclusion as the message's word before "at" (ingest.recordCiRun).
 */
export function ciRuns(samples: Pick<OpsSample, "at" | "message" | "url" | "context_json">[]): CiRunRow[] {
  const out: CiRunRow[] = [];
  for (const s of samples) {
    const ctx = parseTags(s.context_json);
    const m = /\s(\w+)(?: at [0-9a-f]{7,40})?$/.exec(s.message ?? "");
    // Only a run: its context names the commit or run, or its message ends "at <sha>". A check's own words are not a conclusion.
    if (!(ctx && (ctx.sha || ctx.run_id)) && !/ at [0-9a-f]{7,40}$/.test(s.message ?? "")) continue;
    const conclusion = m?.[1] ?? "unknown";
    const sha = typeof ctx?.sha === "string" ? ctx.sha.toLowerCase() : null;
    out.push({
      at: s.at,
      sha,
      ok: PASSING_CONCLUSIONS.has(conclusion),
      conclusion,
      url: s.url,
      ...(typeof ctx?.run_id === "string" ? { run_id: ctx.run_id } : {}),
      ...(typeof ctx?.branch === "string" ? { branch: ctx.branch } : {}),
    });
  }
  return out.sort((a, b) => b.at - a.at);
}

/** The last time a check was green: when, and for a CI run the commit it passed at. */
export type GreenMark = { at: number; sha: string | null; url?: string };

/**
 * Where the current red streak began, on the branch the newest run is on:
 * the run that broke it and the last green before it. The commits between
 * the two hold the break; the first red one is the suspect.
 *
 * The first red run is found three ways, in order: a kept passing run with
 * failures after it; the kept run whose time is the flip to failing
 * (`failingSince`, the check_failed transition, stamped at the run); or the
 * oldest kept failure after the last recorded pass (`lastOk`) when the kept
 * runs reach back past that pass. Otherwise the boundary was not kept and
 * `firstFail` is null: an older sample is never offered in its place.
 * Null when the newest run passed.
 */
export function ciBreak(runs: CiRunRow[], opts: { failingSince?: number | null; lastOk?: { at: number; sha?: string | null; branch?: string | null } | null } = {}): { firstFail: CiRunRow | null; lastPass: GreenMark | null; branch: string | null } | null {
  if (!runs.length || runs[0].ok) return null;
  const branch = runs[0].branch ?? null;
  const own = runs.filter((r) => (r.branch ?? null) === branch);
  const okOnBranch = opts.lastOk && (!opts.lastOk.branch || !branch || opts.lastOk.branch === branch) ? opts.lastOk : null;
  const recorded: GreenMark | null = okOnBranch ? { at: okOnBranch.at, sha: okOnBranch.sha ?? null } : null;
  let firstFail: CiRunRow | null = null;
  for (const r of own) {
    if (r.ok) return { firstFail, lastPass: { at: r.at, sha: r.sha, url: r.url }, branch };
    firstFail = r;
  }
  const since = opts.failingSince;
  const flip = since != null ? own.find((r) => !r.ok && Math.abs(r.at - since) < 60_000) : undefined;
  if (flip) return { firstFail: flip, lastPass: recorded, branch };
  if (recorded && own.some((r) => r.at <= recorded.at)) {
    const after = own.filter((r) => !r.ok && r.at > recorded.at);
    if (after.length) return { firstFail: after[after.length - 1], lastPass: recorded, branch };
  }
  return { firstFail: null, lastPass: recorded, branch };
}

const HEX = /^[0-9a-f]{7,40}$/i;

/**
 * The commit an error issue is tied to, when releases are commits: the
 * release it came back in when it regressed (a suspect: the code changed and
 * it returned), else the release it was first seen in. A first-seen release
 * only says which build was running, so `why: "first"` is shown as the
 * release, never as the commit that broke it. Null when releases are not
 * commits.
 */
export function suspectSha(g: Pick<OpsGroup, "first_release"> & Partial<Pick<OpsGroup, "regressed_in" | "regressed_at" | "resolved_at" | "status">>): { sha: string; why: "regressed" | "first" } | null {
  const back = g.status === "open" && g.regressed_at !== undefined && g.regressed_at >= (g.resolved_at ?? 0) ? g.regressed_in : undefined;
  if (back && HEX.test(back.trim())) return { sha: back.trim().toLowerCase(), why: "regressed" };
  if (g.first_release && HEX.test(g.first_release.trim())) return { sha: g.first_release.trim().toLowerCase(), why: "first" };
  return null;
}

export type MessagePart = { t: "text"; v: string } | { t: "task"; v: string } | { t: "pr"; n: number };

/** A commit message's first line, its task ids (ct-123) and pull request numbers (#45) split out to render as live references. */
const SQUASH_PR = /\s*\(#(\d+)\)\s*$/;

/** The pull request a squash merge's subject ends with ("… (#123)"), which its commit card names on a line of its own. */
export function squashPr(message: string | undefined): number | null {
  const m = String(message ?? "").split("\n")[0].match(SQUASH_PR);
  return m ? Number(m[1]) : null;
}

export function commitMessageParts(message: string | undefined): MessagePart[] {
  // A squash merge's trailing "(#123)" is its pull request, which the card names beside the subject (squashPr): dropped, never a pill inside the subject's own parentheses.
  const line = String(message ?? "").split("\n")[0].replace(SQUASH_PR, "");
  const out: MessagePart[] = [];
  let at = 0;
  for (const m of line.matchAll(/\b(ct-\d+)\b|#(\d+)\b/gi)) {
    if (m.index! > at) out.push({ t: "text", v: line.slice(at, m.index) });
    out.push(m[1] ? { t: "task", v: m[1].toLowerCase() } : { t: "pr", n: Number(m[2]) });
    at = m.index! + m[0].length;
  }
  if (at < line.length) out.push({ t: "text", v: line.slice(at) });
  return out;
}

// ── Readings: what a check or metric reported, one row per kept sample ──

export type ReadingRow = {
  id: string;
  at: number;
  /** The reading's own words: an app check's message, a metric's sample line. */
  text: string;
  /** A metric's value at the reading, when the line carries one. */
  value: number | null;
  /** Whether the reading was past the line (metric) or red (check); null when unknown. */
  failing: boolean | null;
  /** A CI run's commit, branch, conclusion and link. */
  run?: CiRunRow;
};

const METRIC_VALUE = /=\s*(-?\d[\d,]*(?:\.\d+)?(?:e[+-]?\d+)?)/i;

/**
 * A check's or metric's kept samples as readings, newest first. A metric's
 * value is read from its sample line ("Name = 112 (alerts above 15)") and
 * judged against the line; a CI run carries its commit; any other check
 * reading is its message, kept whole. Only failures are kept for a check, so
 * each of its readings is red.
 */
export function readingRows(
  g: Pick<OpsGroup, "kind" | "title">,
  samples: Pick<OpsSample, "_id" | "at" | "message" | "url" | "context_json">[],
  line?: { threshold?: number; direction?: "above" | "below" } | null,
): ReadingRow[] {
  const runs = new Map(ciRuns(samples).map((r) => [`${r.at}|${r.url ?? ""}`, r]));
  return [...samples]
    .sort((a, b) => b.at - a.at)
    .map((s) => {
      const run = runs.get(`${s.at}|${s.url ?? ""}`);
      if (g.kind === "metric") {
        const m = METRIC_VALUE.exec(s.message ?? "");
        const value = m ? Number(m[1].replace(/,/g, "")) : null;
        const failing = value === null || line?.threshold === undefined ? null : line.direction === "below" ? value < line.threshold : value > line.threshold;
        return { id: s._id, at: s.at, text: s.message ?? "", value: Number.isFinite(value) ? value : null, failing };
      }
      return { id: s._id, at: s.at, text: s.message ?? "", value: null, failing: run ? !run.ok : true, ...(run ? { run } : {}) };
    });
}

/** Readings whose words repeat back to back fold into one row with a count, the newest of them kept. */
export function foldReadings(rows: ReadingRow[]): (ReadingRow & { n: number; oldest: number })[] {
  const out: (ReadingRow & { n: number; oldest: number })[] = [];
  for (const r of rows) {
    const prev = out[out.length - 1];
    const same = prev && !r.run && !prev.run && prev.failing === r.failing && (r.value !== null ? r.value === prev.value : r.text === prev.text);
    if (same) {
      prev.n++;
      prev.oldest = r.at;
    } else out.push({ ...r, n: 1, oldest: r.at });
  }
  return out;
}

// ── What drives a metric alert: the error groups behind it ──

export type Contributor = { group: OpsGroup; n: number; share: number; exact: boolean };

/**
 * The error groups that fired inside a metric alert's window, ranked by
 * their events there. Only the alert's own source can say what drove its
 * number: those rows carry a share of their total. Other sources' errors in
 * the same window are context (`others`), with no share, since they are not
 * what the metric counted.
 */
/**
 * Where "the last 24 hours" begins: the start of the hour 23 hours before
 * this one, the same 24 hourly buckets escalation() counts. A window cut
 * mid-hour would leave a partial bucket and a "+" on a count the issue's own
 * page states exactly.
 */
export function lastDayStart(now: number): number {
  return Math.floor(now / HOUR) * HOUR - 23 * HOUR;
}

export function metricContributors(alert: Pick<OpsGroup, "_id" | "source_id">, groups: OpsGroup[], since: number, now: number, max = 6): { rows: Contributor[]; total: number; others: Contributor[] } {
  const fired = (g: OpsGroup) => {
    if (g._id === alert._id || (g.kind !== "error" && g.kind !== "log") || g.last_seen <= since || g.status === "ignored" || g.status === "muted") return null;
    const c = occurrencesSince(g, since, now);
    return c.n ? { group: g, n: c.n, exact: c.exact } : null;
  };
  const all = groups.map(fired).filter((x): x is { group: OpsGroup; n: number; exact: boolean } => x !== null);
  const rank = (a: { n: number; group: OpsGroup }, b: { n: number; group: OpsGroup }) => b.n - a.n || b.group.last_seen - a.group.last_seen;
  const own = all.filter((x) => x.group.source_id === alert.source_id);
  const total = own.reduce((a, x) => a + x.n, 0);
  const rows = own.sort(rank).slice(0, max).map((x) => ({ ...x, share: total ? x.n / total : 0 }));
  const others = all.filter((x) => x.group.source_id !== alert.source_id).sort(rank).slice(0, max).map((x) => ({ ...x, share: 0 }));
  return { rows, total, others };
}

/** An exception's type and message as one string: what a breakdown groups by, and what leaving one out compares. */
const EXCEPTION_KEY = "concat(coalesce(JSONExtractString(properties.$exception_types, 1), properties.$exception_type, 'Error'), ': ', coalesce(JSONExtractString(properties.$exception_values, 1), properties.$exception_message, ''))";
const COUNT_WHERE = /^(\s*select\s+count\s*\(\s*\*?\s*\)\s+from\s+events\s+where\s+)([\s\S]+?)(\s*;?\s*)$/i;

/**
 * A HogQL count watch with one of its breakdown's parts left out (known
 * browser noise such as a ResizeObserver loop): the same filter, and not
 * that part, compared the way the breakdown keyed it. Null for a query
 * hogqlBreakdown cannot split.
 */
export function hogqlExclude(query: string, key: string): string | null {
  const m = COUNT_WHERE.exec(query);
  if (!m || !hogqlBreakdown(query)) return null;
  const expr = /\$exception\b/.test(m[2]) ? EXCEPTION_KEY : "event";
  const lit = `'${key.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  return `${m[1]}(${m[2]}) and ${expr} != ${lit}${m[3]}`;
}

/**
 * The query that splits a HogQL count watch into what it counted: the same
 * filter grouped by what each event was (an exception's type and message,
 * else the event's name), biggest first. Null when the watch is not one plain
 * count over events, which has no honest split.
 */
export function hogqlBreakdown(query: string, limit = 8): string | null {
  const m = /^\s*select\s+count\s*\(\s*\*?\s*\)\s+from\s+events\s+where\s+([\s\S]+?)\s*;?\s*$/i.exec(query);
  if (!m || /\b(group\s+by|order\s+by|limit|union|join|having)\b/i.test(m[1])) return null;
  const key = /\$exception\b/.test(m[1]) ? EXCEPTION_KEY : "event";
  return `select ${key} as k, count() as n from events where ${m[1]} group by k order by n desc limit ${limit}`;
}

/** One part of a metric's value: what it counted, how many, its share, and the codecast issue that names it when one does. */
export type BreakdownRow = { key: string; n: number; share: number; group: OpsGroup | null };

/**
 * A breakdown's rows (`[key, n]` pairs, as HogQL answers) with each share
 * taken of their sum, and each matched to the open or resolved error issue
 * whose title carries its message, when one does.
 */
export function breakdownRows(results: unknown, groups: OpsGroup[]): BreakdownRow[] {
  const pairs = (Array.isArray(results) ? results : []).flatMap((r) => (Array.isArray(r) && typeof r[0] === "string" && Number.isFinite(Number(r[1])) ? [[r[0], Number(r[1])] as const] : []));
  const total = pairs.reduce((a, [, n]) => a + n, 0);
  const errors = groups.filter((g) => g.kind === "error" || g.kind === "log");
  const norm = (t: string) => t.toLowerCase().replace(/\s+/g, " ").trim();
  return pairs.map(([key, n]) => {
    const message = norm(key.replace(/^[^:]{1,60}:\s*/, ""));
    const group = message.length >= 8 ? errors.find((g) => norm(g.title).includes(message) || (norm(g.title).length >= 12 && message.includes(norm(g.title)))) ?? null : null;
    return { key, n, share: total ? n / total : 0, group };
  });
}

/** A metric alert's failure for a fix prompt: its latest reading and the biggest parts of what it counted. */
export function metricFailure(reading: string | undefined, parts: Pick<BreakdownRow, "key" | "n" | "share">[]): string | undefined {
  const lines = [reading?.trim(), ...parts.slice(0, 3).map((p) => `${Math.round(p.share * 100)}% (${p.n}) ${p.key}`)].filter(Boolean);
  return lines.length ? lines.join("\n") : undefined;
}

// ── An app check's readings as numbers ──

/** A number in a reading's words: an optional currency sign, the figure, and a unit glued to it (%, /day, /h). */
const READING_NUMBER = /(\$|€|£)?(-?\d[\d,]*(?:\.\d+)?)(%|\/day|\/h|\/hr|\/min|\/s)?/g;
const STOP_WORDS = new Set(["at", "of", "in", "on", "the", "a", "an", "to", "by", "is", "and", "or", "for", "with", "past", "over", "under", "about"]);

export type ReadingColumn = { label: string; pre: string; post: string };
export type ReadingTemplate = {
  /** The newest reading's words: said once, as what the check reports. */
  text: string;
  /** The figures each reading is judged by, each a column: the fields that make it fail, or the ones that move. */
  cols: ReadingColumn[];
  /** Each reading's figures, by its id, in column order. */
  values: Map<string, number[]>;
  /** A figure that never changes and the check names as its level (or "past ... level"): what the first column is held against. */
  line: number | null;
  /** The column the trend draws first: the first that moves, else the first. */
  charted: number;
};

/** A figure the check's own words mark as not counting toward its verdict. */
const INFORMATIONAL = /^[^,;]*\b(informational|info only|for info)\b/i;
/** A fixed figure named as the level a figure is held to. */
const LEVEL_AFTER = /^\s*(level|threshold|limit|line|floor|minimum|maximum|target)\b/i;
const LEVEL_BEFORE = /(below|under|above|threshold|limit|minimum|maximum|target|floor|[<>≤≥])\s*$/i;

/**
 * An app check's readings, when they are one sentence whose figures change
 * (a balance, days left, a rate) or a list of fields (`1 stale, 3
 * no-response, 19 replied (informational)`): the sentence once, and its
 * figures as columns, each named by the words that follow it up to the next
 * comma, its rate unit, or the word before it. A list that marks some fields
 * informational is judged by the others, so those are the columns and the
 * informational ones are left out. Null when the readings do not share one
 * shape, or nothing in them is a field or moves.
 */
export function readingTemplate(rows: Pick<ReadingRow, "id" | "text">[]): ReadingTemplate | null {
  const parse = (t: string) => {
    const nums: { pre: string; n: number; post: string; before: string; after: string }[] = [];
    const skeleton = t.replace(READING_NUMBER, (m, pre: string | undefined, num: string, post: string | undefined, off: number) => {
      nums.push({ pre: pre ?? "", n: Number(num.replace(/,/g, "")), post: post ?? "", before: t.slice(0, off), after: t.slice(off + m.length) });
      return "#";
    });
    return { skeleton, nums };
  };
  const withText = rows.filter((r) => r.text);
  if (withText.length < 2) return null;
  const head = parse(withText[0].text);
  if (!head.nums.length) return null;
  const same = withText.map((r) => ({ r, p: parse(r.text) })).filter((x) => x.p.skeleton === head.skeleton);
  if (same.length < 2) return null;
  const moving = head.nums.map((_, i) => same.some((x) => x.p.nums[i].n !== head.nums[i].n));
  const info = head.nums.map((x) => INFORMATIONAL.test(x.after));
  // A field list judged by some of its fields: those are the columns, moving or not.
  const fields = info.some(Boolean) ? head.nums.flatMap((_, i) => (info[i] ? [] : [i])) : [];
  const idx = fields.length ? fields : moving.flatMap((m, i) => (m ? [i] : []));
  if (!idx.length) return null;
  const label = (x: (typeof head.nums)[number], i: number) => {
    const phrase = /^\s+([A-Za-z][A-Za-z-]{1,20}(?:\s+[A-Za-z][A-Za-z-]{1,20}){0,2})(?=\s*(?:[,;(.:]|$))/.exec(x.after)?.[1];
    if (phrase && !STOP_WORDS.has(phrase.split(/\s+/)[0].toLowerCase())) return phrase.toLowerCase();
    const next = /^\s+([A-Za-z][A-Za-z-]{1,20})/.exec(x.after)?.[1];
    if (next && !STOP_WORDS.has(next.toLowerCase())) return next.toLowerCase();
    if (x.post.startsWith("/")) return `per ${x.post.slice(1)}`;
    const prev = /([A-Za-z][A-Za-z-]{1,20})\W*$/.exec(x.before)?.[1];
    if (prev && !STOP_WORDS.has(prev.toLowerCase())) return prev.toLowerCase();
    return `#${i + 1}`;
  };
  const cols = idx.map((i, k) => ({ label: label(head.nums[i], k), pre: head.nums[i].pre, post: head.nums[i].post.startsWith("/") || head.nums[i].post === "%" ? head.nums[i].post : "" }));
  const values = new Map(same.map((x) => [x.r.id, idx.map((i) => x.p.nums[i].n)]));
  const first = head.nums[idx[0]];
  // Only a figure the words name as a level is a line; a field that holds still (1 stale) is not one.
  const level = head.nums.find((x, i) => !moving[i] && !idx.includes(i) && x.pre === first.pre && x.post === first.post && x.n !== 0 && (LEVEL_AFTER.test(x.after) || LEVEL_BEFORE.test(x.before)));
  const charted = Math.max(0, idx.findIndex((i) => moving[i]));
  return { text: withText[0].text, cols, values, line: level ? level.n : null, charted };
}

/**
 * When a falling figure reaches zero at the rate its readings fell since it
 * last rose: a least-squares line over those readings (time, value). Null
 * unless it is falling and still above zero.
 */
export function projectZero(all: { at: number; v: number }[]): number | null {
  // Only the stretch since the figure last rose (a top-up starts a new run).
  const sorted = [...all].sort((a, b) => a.at - b.at);
  let from = 0;
  for (let i = 1; i < sorted.length; i++) if (sorted[i].v > sorted[i - 1].v) from = i;
  const points = sorted.slice(from);
  if (points.length < 2) return null;
  const n = points.length;
  const mx = points.reduce((a, p) => a + p.at, 0) / n;
  const my = points.reduce((a, p) => a + p.v, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.at - mx) * (p.v - my);
    den += (p.at - mx) ** 2;
  }
  if (!den) return null;
  const slope = num / den;
  const last = points.reduce((a, p) => (p.at > a.at ? p : a));
  if (slope >= 0 || last.v <= 0) return null;
  return last.at + last.v / -slope;
}

// ── A job's failures, split by what they said ──

/** The sample filter key a failure split's row sets (sampleTag). */
export const FAILURE_KEY = "failure";

export type FailurePart = { key: string; label: string; n: number; share: number; first: number; last: number };
export type FailureSplit = {
  rows: FailurePart[];
  /** What the rows count: every failure since `since` (the server's tally), or only the kept samples. */
  from: "tally" | "kept";
  total: number;
  since: number | null;
};

/**
 * A job's failures by what each said, biggest first: the server's tally
 * (event_groups.messages) when the group holds one, else its kept samples
 * split the same way (failureMessageKey). Each row's label drops the lead
 * every row shares ("Agent run failed: broker: "), so the rows read by what
 * differs. Null when there is nothing to split.
 */
export function jobFailureSplit(g: Pick<OpsGroup, "kind" | "messages">, samples: Pick<OpsSample, "message" | "at">[]): FailureSplit | null {
  if (g.kind !== "job") return null;
  let from: FailureSplit["from"] = "tally";
  let parts = (g.messages ?? []).map((m) => ({ key: m.key, n: m.count, first: m.first_seen, last: m.last_seen }));
  if (!parts.length) {
    from = "kept";
    const by = new Map<string, { key: string; n: number; first: number; last: number }>();
    for (const s of samples) {
      const key = failureMessageKey(s.message) || "(no message)";
      const hit = by.get(key);
      if (hit) {
        hit.n++;
        hit.first = Math.min(hit.first, s.at);
        hit.last = Math.max(hit.last, s.at);
      } else by.set(key, { key, n: 1, first: s.at, last: s.at });
    }
    parts = [...by.values()];
  }
  if (!parts.length) return null;
  parts.sort((a, b) => b.n - a.n || b.last - a.last);
  const total = parts.reduce((a, p) => a + p.n, 0);
  const lead = parts.length > 1 ? sharedLead(parts.map((p) => p.key)) : "";
  return {
    rows: parts.map((p) => ({ ...p, label: p.key.slice(lead.length) || p.key, share: total ? p.n / total : 0 })),
    from,
    total,
    since: Math.min(...parts.map((p) => p.first)),
  };
}

/**
 * Rows whose titles open the same way as another shown row (up to a ": "):
 * the length of the lead they share, so a row can dim it and lead with the
 * part that tells it apart. Rows with no twin are absent.
 */
export function sharedTitleLeads(rows: Pick<OpsGroup, "_id" | "title">[]): Map<string, number> {
  const byLead = new Map<string, Pick<OpsGroup, "_id" | "title">[]>();
  for (const r of rows) {
    const i = r.title.indexOf(": ");
    if (i <= 0 || i > 80) continue;
    const lead = r.title.slice(0, i + 2);
    byLead.set(lead, [...(byLead.get(lead) ?? []), r]);
  }
  const out = new Map<string, number>();
  for (const twins of byLead.values()) {
    if (twins.length < 2) continue;
    const lead = sharedLead(twins.map((t) => t.title));
    for (const t of twins) if (lead && t.title.length > lead.length) out.set(t._id, lead.length);
  }
  return out;
}

/** The lead every key shares, cut at its last ": " so a row never starts mid-word. */
export function sharedLead(keys: string[]): string {
  if (!keys.length) return "";
  let lead = keys[0];
  for (const k of keys) while (!k.startsWith(lead)) lead = lead.slice(0, -1);
  const cut = lead.lastIndexOf(": ");
  return cut > 0 ? lead.slice(0, cut + 2) : "";
}

const NOISE: { re: RegExp; label: string }[] = [
  { re: /ResizeObserver loop (completed with undelivered notifications|limit exceeded)/i, label: "browser noise" },
  { re: /^(Uncaught |Error: )?Script error\.?$/i, label: "browser noise" },
  { re: /\b(chrome|moz|safari(-web)?)-extension:\/\//i, label: "extension" },
  { re: /ChunkLoadError|Loading (CSS )?chunk [\w-]+ failed|Failed to fetch dynamically imported module|Importing a module script failed/i, label: "stale chunk" },
];

/**
 * Whether a message is known noise, and which: a harmless browser warning,
 * an extension's own error, or a stale chunk after a deploy. Its cure is to
 * leave it out of what is counted, not a fix session.
 */
export function noiseOf(text: string | null | undefined): string | null {
  if (!text) return null;
  return NOISE.find((n) => n.re.test(text))?.label ?? null;
}

/**
 * A job that has stopped failing: none for well past its usual gap between
 * failures (its count over its life), and at least six hours. A job reports
 * only its failures, so this is as close to "passing" as it can say; a quiet
 * job reads quiet with its last failure, never "failing" days later.
 */
export function jobQuiet(g: Pick<OpsGroup, "kind" | "count" | "first_seen" | "last_seen">, now: number): boolean {
  if (g.kind !== "job") return false;
  const usual = g.count > 1 ? (g.last_seen - g.first_seen) / (g.count - 1) : DAY;
  return now - g.last_seen > Math.max(6 * HOUR, Math.min(7 * DAY, 4 * usual));
}

// ── One row per root cause ──
// Issues one template bug produced (the same message with one parameter
// changed) are one cause: the Ops home, a source's overview and the Issues
// list fold them into one row with the same rule, so each says the same count
// and offers one fix for all of them.

/** Titles this short fold on nothing: one word of five is too much of the message to call a parameter. */
const SHAPE_MIN_TOKENS = 5;

/**
 * A title as words with its parameters blanked: a `(key=value, …)` list, ids
 * (uuids, long hex) and numbers. Two titles whose words then differ in at
 * most one place are one message with one parameter.
 */
export function titleShape(title: string): string[] {
  return title
    .replace(/\([^()]*=[^()]*\)/g, "(…)")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f-]{20,}\b/gi, "#")
    .replace(/\b[0-9a-f]{12,}\b/gi, "#")
    .replace(/\d+/g, "#")
    .split(/\s+/)
    .filter(Boolean);
}

/** The keys a title's shape matches under: the shape itself, and the shape with each word in turn blanked. A short title has none: it folds with nothing. */
function shapeKeys(shape: string[]): string[] {
  if (shape.length < SHAPE_MIN_TOKENS) return [];
  return [shape.join(" "), ...shape.map((_, i) => shape.map((w, j) => (i === j ? "\u0000" : w)).join(" "))];
}

/**
 * A title with every path in it read as its route (routeOf: ids, phone
 * numbers and emails to `:id`), or null when it names no path. Two short
 * titles that fold to the same route are one endpoint's failure whatever the
 * record (`GET /api/contacts/by-phone/:id answers 404`), so they fold however
 * few their words.
 */
export function routeTitle(title: string): string | null {
  const words = title.split(/\s+/).filter(Boolean);
  if (!words.some((w) => w.startsWith("/"))) return null;
  return words.map((w) => (w.startsWith("/") ? routeOf(w) : w)).join(" ");
}

/** What the variants' titles share, the part that differs written "…": "budget context missing: … — wrap the origin in withBudget(...)". */
export function foldedTitle(titles: readonly string[]): string {
  if (titles.length < 2) return titles[0] ?? "";
  // One endpoint's failure across records reads as its route, never as "GET … answers 404".
  const routes = titles.map(routeTitle);
  if (routes[0] && routes.every((r) => r === routes[0])) return routes[0];
  const words = titles.map((t) => t.split(/\s+/).filter(Boolean));
  const min = Math.min(...words.map((w) => w.length));
  let pre = 0;
  while (pre < min && words.every((w) => w[pre] === words[0][pre])) pre++;
  let suf = 0;
  while (suf < min - pre && words.every((w) => w[w.length - 1 - suf] === words[0][words[0].length - 1 - suf])) suf++;
  const head = words[0].slice(0, pre).join(" ");
  const tail = words[0].slice(words[0].length - suf).join(" ");
  return [head, "…", tail].filter(Boolean).join(" ");
}

/** What a fold compares: the issue's source, kind, release and title. */
export type FoldGroup = Pick<OpsGroup, "source_id" | "kind" | "last_release" | "title" | "count">;

/**
 * Rows grouped by root cause: the same source, kind and release, titles that
 * differ in one word once their parameters are blanked (titleShape). Sentry
 * fingerprints these as one issue. Each cluster is heaviest first (`weight`,
 * then events, then title), so its lead is the same row on every surface; the
 * clusters keep the order their first row had. A row with no twin is a
 * cluster of one.
 */
export function foldIssueRows<T>(rows: readonly T[], groupOf: (r: T) => FoldGroup, weight: (r: T) => number): T[][] {
  const parent = rows.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const firstBy = new Map<string, number>();
  rows.forEach((r, i) => {
    const g = groupOf(r);
    const scope = `${g.source_id}|${g.kind}|${g.last_release ?? ""}|`;
    const route = routeTitle(g.title);
    for (const k of [...shapeKeys(titleShape(g.title)), ...(route ? [`route:${route}`] : [])]) {
      const key = scope + k;
      const j = firstBy.get(key);
      if (j === undefined) firstBy.set(key, i);
      else parent[find(i)] = find(j);
    }
  });
  const clusters = new Map<number, T[]>();
  rows.forEach((r, i) => clusters.set(find(i), [...(clusters.get(find(i)) ?? []), r]));
  return [...clusters.values()].map((c) => c.sort((a, b) => weight(b) - weight(a) || groupOf(b).count - groupOf(a).count || groupOf(a).title.localeCompare(groupOf(b).title)));
}

/** A group's weight in a fold off the home: its events in the last day (all of them for one born today), as the home weighs its rows. */
export function foldWeight(g: Pick<OpsGroup, "buckets" | "count" | "first_seen">, now: number): number {
  const day = bucketSeries(g.buckets, now, 24).reduce((a, b) => a + b, 0);
  return Math.max(day, now - g.first_seen < DAY ? g.count : 0);
}
