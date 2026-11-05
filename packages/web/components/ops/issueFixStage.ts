// Where a fix for an issue stands: its stage, its task, the sessions on it.
// No React, no store.
import { GROUP_RULES } from "@codecast/shared/contracts/ingest";
import type { OpsGroup } from "./opsTypes";
import { DAY, HOUR, type Resolver, resolverOf } from "./issueState";

// ── Where a fix stands ──

export type FixStage = "none" | "dropped" | "other" | "filed" | "fixing" | "review" | "closed" | "shipped" | "recurring";
export const FIX_STAGES: FixStage[] = ["recurring", "none", "other", "dropped", "filed", "fixing", "review", "closed", "shipped"];
/** How a stage reads everywhere: the Fix facet, the list's Fix column, the page's badge and the hovers say the same words. */
export const FIX_STAGE_LABEL: Record<FixStage, string> = {
  none: "Untriaged",
  dropped: "Dropped",
  other: "Other task",
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

export const asTask = (t: FixTask | string | undefined): FixTask | undefined => (typeof t === "string" ? { status: t } : t);

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

/**
 * The fix press of a row that lists an issue with no fix session running:
 * the Fix card's own words for its stage, so a dropped task reads "Reopen
 * ct-N and fix" on every surface and the press does that.
 */
export function stageFixLabel(g: Pick<OpsGroup, "title">, stage: FixStage, task: Pick<FixTask, "title"> & { short_id?: string } | null | undefined): string {
  const mismatch = !!task?.title && !taskMatchesIssue(task.title, g.title);
  return fixActionLabel(stage === "dropped" ? "refile" : stage === "recurring" ? "followup" : "start", task?.short_id, mismatch) ?? "Start fix";
}
