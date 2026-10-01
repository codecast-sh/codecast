import { v } from "convex/values";
import { internalMutation, query } from "./functions";
import { isWholeWorkspaceRole } from "@codecast/shared/contracts/orgLead";
import type { Id } from "./_generated/dataModel";
import { resolveScope } from "./org";
import { capsFor, cardsCapOf, countersFor, roleStartsOnItsOwn } from "./lib/orgCaps";
import { recordHandStart } from "./spawn";
import { insertTaskComment } from "./tasks";
import { createRunCore } from "./workflow_runs";
import { lineSlugOf } from "./orgRoles";
import { allRolesInBoundary, resolveRoleRef, userCanAccessRole } from "./lib/orgAccess";
import { taskWork } from "./lib/orgOwnership";
import { ownsWork } from "@codecast/shared/contracts/orgLead";
import { NO_GOAL, type GoalPriority } from "@codecast/shared/contracts/goalsBrief";
import { priority as linePriority, type Severity } from "./lib/linePriority";
import { getAuthenticatedUserId } from "./pendingMessages";

// The line (docs/architecture/the-line.md L2, L9). A scope owns one workflow,
// named by `org_roles.line_workflow_slug`; the sweep below starts that
// workflow on every open task the role's agent is assigned to. Every function
// takes the db and the role row so the fake db tests drive the same code the
// cron runs.

type Ctx = { db: any };

// How many runs one sweep may start in total, so a large backlog is drained
// two minutes at a time instead of in one long mutation.
export const MAX_STARTS_PER_SWEEP = 10;

export const LINE_STARTED_PREFIX = "the line started: run ";

const agentAssignee = (role: { handle: string }) => `agent:${role.handle}`;

// L9 and LE6: what a role's line may start. Two kinds, both open, with no
// run yet, no blocker that is still open, and work the role owns by the one
// ownership rule (org-staffing.md S26), so a wider role never starts what a
// narrower one owns:
//   - a task assigned to the role (its agent or the role itself);
//   - a cause (LE4): a task the signal door opened, grounded ready with a
//     goal_ref (LE5), unassigned or assigned to the role.
// A scoped role reads its scope through the resolver the scope feed uses; a
// whole workspace role reads what it was handed in its boundary plus the open
// causes there, since the rule leaves it the work no narrower role covers.
// Highest computed priority first (lib/linePriority.ts); ties drain oldest
// first, in the order they were filed.
export async function lineCandidates(ctx: Ctx, role: any): Promise<any[]> {
  return (await rankedCandidates(ctx, role)).map((c) => c.task);
}

export type RankedCandidate = { task: any; priority: number };

export async function rankedCandidates(ctx: Ctx, role: any): Promise<RankedCandidate[]> {
  const assignees = new Set([agentAssignee(role), String(role._id)]);
  const pool = await linePool(ctx, role, assignees);
  const roles = await allRolesInBoundary(ctx, role);
  const goals = new Map<string, GoalPriority | "unranked" | null>();
  const out: RankedCandidate[] = [];
  const seen = new Set<string>();
  for (const task of pool) {
    if (seen.has(String(task._id))) continue;
    seen.add(String(task._id));
    if (task.status !== "open" || task.workflow_run_id) continue;
    const assigned = assignees.has(task.assignee);
    if (!assigned && !(isReadyCause(task) && !task.assignee)) continue;
    if (!ownsWork(role, await taskWork(ctx, task), roles)) continue;
    if (await isBlocked(ctx, task)) continue;
    out.push({ task, priority: linePriority(await goalPriorityOf(ctx, task, goals), severityOf(task), task.cause?.signal_count ?? 1) });
  }
  const age = (t: any) => t.created_at ?? t._creationTime ?? 0;
  out.sort((a, b) => b.priority - a.priority || age(a.task) - age(b.task));
  return out;
}

// LE5: a cause reaches the line once ground marked it ready and named the
// goal it threatens ("none" included; it ranks low, linePriority.NO_GOAL_WEIGHT).
function isReadyCause(task: any): boolean {
  return task.source === "signal" && task.readiness === "ready" && !!task.goal_ref?.trim();
}

const SEVERITIES = new Set<Severity>(["urgent", "high", "medium", "low", "none"]);
function severityOf(task: any): Severity {
  return SEVERITIES.has(task.priority) ? task.priority : "none";
}

// goal_ref is a metric ref `in-N:key`, a project's short id, or "none"
// (goalsBrief.ts). The goal's priority is read from its row in the task's own
// workspace; a ref that names nothing readable there counts as unranked.
async function goalPriorityOf(ctx: Ctx, task: any, cache: Map<string, GoalPriority | "unranked" | null>): Promise<GoalPriority | "unranked" | null> {
  const ref = task.goal_ref?.trim();
  if (!ref || ref === NO_GOAL) return null;
  const key = `${task.workspace}|${ref}`;
  if (cache.has(key)) return cache.get(key)!;
  const shortId = ref.split(":")[0];
  const table = /^in-\d+$/.test(shortId) ? "initiatives" : "projects";
  const row = await ctx.db.query(table).withIndex("by_short_id", (q: any) => q.eq("short_id", shortId)).first();
  const value = row && row.workspace === task.workspace ? (row.priority ?? "unranked") : "unranked";
  cache.set(key, value);
  return value;
}

async function linePool(ctx: Ctx, role: any, assignees: Set<string>): Promise<any[]> {
  if (!isWholeWorkspaceRole(role)) return (await resolveScope(ctx, role.host_user_id, { role_id: String(role._id) }))?.tasks ?? [];
  const key = role.team_id ? `team:${role.team_id}` : `user:${role.scope_user_id}`;
  const rows: any[] = [];
  for (const a of assignees) rows.push(...await ctx.db.query("tasks").withIndex("by_assignee_updated", (q: any) => q.eq("assignee", a)).collect());
  // Open causes in the boundary (LE6). Bounded: the sweep runs every two
  // minutes and a backlog drains across runs.
  const open = role.team_id
    ? ctx.db.query("tasks").withIndex("by_team_status", (q: any) => q.eq("team_id", role.team_id).eq("status", "open"))
    : ctx.db.query("tasks").withIndex("by_user_status", (q: any) => q.eq("user_id", role.scope_user_id).eq("status", "open"));
  rows.push(...(await open.take(OPEN_CAUSE_SCAN)).filter((t: any) => t.source === "signal"));
  return rows.filter((t) => t.workspace === key);
}

const OPEN_CAUSE_SCAN = 500;

// blocked_by holds task short ids (tasks.ts ready): a blocker counts as open
// until it is done or dropped. An unknown id blocks nothing.
async function isBlocked(ctx: Ctx, task: any): Promise<boolean> {
  for (const shortId of task.blocked_by ?? []) {
    const blocker = await ctx.db.query("tasks").withIndex("by_short_id", (q: any) => q.eq("short_id", shortId)).first();
    if (blocker && blocker.status !== "done" && blocker.status !== "dropped") return true;
  }
  return false;
}

export function roleMayStartHands(role: any, now: number): boolean {
  if (role.status !== "active" || !roleStartsOnItsOwn(role)) return false;
  // A role retiring behind a knowledge handoff (org-staffing.md S32) starts
  // nothing new: its area already belongs to the heirs.
  if (role.handing_over?.retire) return false;
  return countersFor(role, now).hands < capsFor(role).hands_per_day;
}

// LE6: the gate node a change card asks its person at (LE11), on a line run.
export const LINE_CARD_GATE_NODE = "decide";

// The owner's open card decisions on this role's line: pending and blocking,
// asked at the card gate of a run the role's standing session spawned.
// Answering one frees a slot.
export async function openLineCards(ctx: Ctx, role: any): Promise<number> {
  const anchor = role.anchor_id ? await ctx.db.get(role.anchor_id) : null;
  const standing = anchor?.conversation_id ? String(anchor.conversation_id) : null;
  if (!standing) return 0;
  const pending: any[] = await ctx.db
    .query("session_decisions")
    .withIndex("by_user_status", (q: any) => q.eq("user_id", role.host_user_id).eq("status", "pending"))
    .collect();
  let open = 0;
  for (const d of pending) {
    if (!d.blocking || !d.workflow_run_id || d.gate_node_id !== LINE_CARD_GATE_NODE) continue;
    const run = await ctx.db.get(d.workflow_run_id);
    if (run && String(run.spawner_conversation_id ?? "") === standing) open++;
  }
  return open;
}

export type AdmissionWait = "off" | "hands" | "cards";

// LE6: why the line may not admit its next cause now, or null when it may.
export function admissionWait(role: any, openCards: number, now: number): AdmissionWait | null {
  if (!roleMayStartHands(role, now)) return countersFor(role, now).hands < capsFor(role).hands_per_day ? "off" : "hands";
  if (openCards >= cardsCapOf(role)) return "cards";
  return null;
}

export function admissionWaitWords(wait: AdmissionWait, openCards: number): string {
  if (wait === "cards") return `queued behind ${openCards} open card${openCards === 1 ? "" : "s"}`;
  if (wait === "hands") return "hands cap reached";
  return "line is off";
}

// L9: one run for one task, through the same core createFromCli uses, with
// the role as the caller: the run belongs to the host user, its spawner is
// the role's standing session (so hands spawn under the role, L1), its cwd
// is the anchor's project path, and its workflow is the host's row with the
// line's slug. When the host has no such row (the slug names a shipped
// template that was never pushed) the run carries `workflow_name` = the
// slug and no `workflow_id`; `cast workflow run-daemon` resolves the shipped
// template by that name (workflow/daemonGraph.ts).
export async function startLineRun(ctx: Ctx, role: any, task: any, now = Date.now()): Promise<Id<"workflow_runs">> {
  const hostId: Id<"users"> = role.host_user_id;
  const slug = lineSlugOf(role);
  const workflow = await ctx.db
    .query("workflows")
    .withIndex("by_user_slug", (q: any) => q.eq("user_id", hostId).eq("slug", slug))
    .first();
  const anchor = role.anchor_id ? await ctx.db.get(role.anchor_id) : null;

  // L8 is createRunCore's: the run's ACCESS key comes from the task's own
  // workspace, so a task private to its owner inside a team keeps a private
  // run. The task leaves `open` the moment its run exists, which is also
  // what keeps the next sweep from starting it twice.
  const { run_id: runId, primary_conversation_id: primaryConvId } = await createRunCore(ctx, hostId, {
    workflow_name: workflow?.name ?? slug,
    workflow_id: workflow?._id,
    task,
    goal_override: task.title,
    project_path: anchor?.project_path ?? undefined,
    spawner_conversation_id: anchor?.conversation_id ?? undefined,
    fallback_team_id: role.team_id ?? undefined,
    now,
  });

  await ctx.db.insert("daemon_commands", {
    user_id: hostId,
    command: "run_workflow",
    args: JSON.stringify({ workflow_run_id: runId, workflow_slug: slug }),
    created_at: now,
  });

  // The run's primary session is a hand of the role: it counts against
  // caps.hands_per_day and carries org_role_id, the same as a spawn.
  await recordHandStart(ctx, role, primaryConvId);
  await insertTaskComment(ctx, task._id, {
    author: `@${role.handle}`,
    text: `${LINE_STARTED_PREFIX}${runId}`,
    comment_type: "progress",
    conversation_id: primaryConvId,
  });
  return runId;
}

export type SweepResult = {
  started: Array<{ role_id: string; task_id: string; run_id: string }>;
  skipped_capped: string[];
  // Roles whose next cause waits behind open cards (LE6).
  skipped_cards: string[];
};

// L9 and LE6: every two minutes. Paused roles and roles whose switch is off
// never start anything. A role admits its candidates highest priority first
// while its open cards are under caps.cards and its hands under
// caps.hands_per_day; a role at either cap is reported and waits for a card
// to be answered or for tomorrow.
export async function sweepCore(ctx: Ctx, now = Date.now()): Promise<SweepResult> {
  const result: SweepResult = { started: [], skipped_capped: [], skipped_cards: [] };
  const roles: any[] = await ctx.db.query("org_roles").collect();
  for (const seed of roles) {
    if (seed.status !== "active" || !roleStartsOnItsOwn(seed)) continue;
    let role = seed;
    const candidates = await lineCandidates(ctx, role);
    if (!candidates.length) continue;
    // A run started here asks its card only later, so the count holds for
    // the whole pass.
    const cards = await openLineCards(ctx, role);
    for (const task of candidates) {
      if (result.started.length >= MAX_STARTS_PER_SWEEP) return result;
      const wait = admissionWait(role, cards, now);
      if (wait === "cards") { result.skipped_cards.push(String(role._id)); break; }
      if (wait) { result.skipped_capped.push(String(role._id)); break; }
      const runId = await startLineRun(ctx, role, task, now);
      result.started.push({ role_id: String(role._id), task_id: String(task._id), run_id: String(runId) });
      // recordHandStart patched the counters; read the row back before the
      // next cap check.
      role = await ctx.db.get(role._id);
    }
  }
  return result;
}

export const sweep = internalMutation({
  args: {},
  handler: async (ctx) => sweepCore(ctx),
});

export type LineQueueItem = { task_id: string; short_id: string | null; title: string; cause: boolean; priority: number; waiting: string | null };
export type LineQueue = { role_id: string; open_cards: number; cards_cap: number; hands: number; hands_cap: number; waiting: string | null; items: LineQueueItem[] };

// LE6: the line page's queue for one role: its candidates in admission order,
// each with why it waits (null: it starts at the next sweep). `waiting` on the
// queue is why the head has not started. The sweep holds the card count for a
// pass, so the hands left today decide how far down the queue one pass reaches.
export async function lineQueueFor(ctx: Ctx, role: any, now = Date.now()): Promise<LineQueue> {
  const ranked = await rankedCandidates(ctx, role);
  const cards = await openLineCards(ctx, role);
  const wait = admissionWait(role, cards, now);
  const waiting = wait ? admissionWaitWords(wait, cards) : null;
  const hands = countersFor(role, now).hands;
  const handsCap = capsFor(role).hands_per_day;
  return {
    role_id: String(role._id),
    open_cards: cards,
    cards_cap: cardsCapOf(role),
    hands,
    hands_cap: handsCap,
    waiting,
    items: ranked.map(({ task, priority }, i) => ({
      task_id: String(task._id),
      short_id: task.short_id ?? null,
      title: task.title,
      cause: task.source === "signal",
      priority,
      waiting: waiting ?? (hands + i >= handsCap ? admissionWaitWords("hands", cards) : null),
    })),
  };
}

export const queue = query({
  args: { api_token: v.optional(v.string()), role_id: v.string() },
  handler: async (ctx, { api_token, role_id }): Promise<LineQueue | null> => {
    const userId = await getAuthenticatedUserId(ctx, api_token);
    if (!userId) return null;
    const role = await resolveRoleRef(ctx, role_id);
    if (!role || !(await userCanAccessRole(ctx, userId, role))) return null;
    return lineQueueFor(ctx, role);
  },
});
