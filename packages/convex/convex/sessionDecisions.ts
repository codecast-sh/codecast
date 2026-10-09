// The decision queue's backend: explicit questions agents hand to their people.
//
// `cast decide` posts a row here (via /cli/decide in http.ts). The web queue
// subscribes with listForUser, and a web answer happens local-first on the
// client: the store marks the row answered (resolve) AND sends the chosen
// option into the session as a normal user message through the existing send
// pipeline. A SERVER-side answer (`cast decide answer`, a role under a grant,
// a stack auto default) records the same way and delivers the answer itself
// (finalizeAnswer with deliver: true), because no client is there to do it.
//
// W2 (docs/architecture/decisions-as-documents.md): a decision is a document
// with rich options (doc_id, option bodies, evidence, cost, risk, a form), it
// is routed through the org as a race (people in decision_inbox, roles on a
// ladder that may recommend, a holder that may answer under a grant), it is
// bound to a task and station, and it may sit in a stack (decisionStacks.ts).
import { fireRoleNeedsInput } from "./agentTasks";
import { mutation, query, internalMutation } from "./functions";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { verifyApiToken } from "./apiTokens";
import { canAccessConversation, canAccessTask, computeWorkspaceKey } from "./lib/access";
import { teamVisibleConvTeam } from "./privacy";
import { pickAnsweredDecision, formatDecisionAnswer, decisionAnswerClientId, decisionAnswerLabel, advisoryAnswerOpen, isHostedAgentType } from "@codecast/shared/contracts";
import type { Doc, Id } from "./_generated/dataModel";
import { emitNotification } from "./notificationRouter";
import { nextShortId } from "./counters";
import { enqueuePendingMessage, reachableRole, tellRole, wakeHostedConversation } from "./pendingMessages";
import { roleStartsOnItsOwn } from "./lib/orgCaps";
import { roleOfConversation } from "./lib/actor";
import { projectLeadRole, roleGrants, userCanAccessRole, userCanAdminRole } from "./lib/orgAccess";
import { assignCategory, isHumanOnlyCategory } from "./lib/decisionCategory";
import { artifactUrl } from "./artifacts";
import { humanStarterUser, listSessionOwnerIds } from "./sessionOwners";
import { findConversationByAnyRefWhere } from "./conversationSessionLookup";
import { resolveAskedPeople } from "./lib/decisionAudience";
import { learnFromCardGate } from "./lineLearn";
import { settleCardWaiting } from "./lineNotices";
import { settleExpectationCard } from "./lib/expectationsApply";
import { reopenTaskWaits, scheduleDecisionSettle } from "./taskWaits";
import { validateChangeCard, type ChangeCard } from "@codecast/shared/contracts/changeCard";

export const optionValidator = v.object({
  label: v.string(),
  description: v.optional(v.string()),
  body_md: v.optional(v.string()),
  evidence: v.optional(v.array(v.object({ label: v.string(), url: v.string() }))),
  cost: v.optional(v.string()),
  risk: v.optional(v.string()),
  // A published page of its own (the-line.md L6), rendered as a comparison row.
  page_slug: v.optional(v.string()),
});

export const formValidator = v.object({
  fields: v.array(
    v.object({
      key: v.string(),
      label: v.string(),
      type: v.union(v.literal("text"), v.literal("number"), v.literal("select"), v.literal("bool")),
      options: v.optional(v.array(v.string())),
    })
  ),
});

export const kindValidator = v.union(v.literal("single"), v.literal("multi"), v.literal("rank"), v.literal("form"));

type DecisionKind = "single" | "multi" | "rank" | "form";
type DecisionRow = Doc<"session_decisions">;
// Resolve paths run in mutations, so the scheduler is there to wake a hosted
// conversation (wakeHostedConversation) and to settle the task waits on the
// row (task-graph.md TG2); reads pass a bare { db }. A settle that needs only
// the scheduler is handed `{ scheduler: ctx.scheduler }`, so the narrowing
// scheduleDecisionSettle declares stays live. reopenTaskWaits takes the real
// mutation ctx, which this structural type cannot satisfy, so it casts; typing
// that chain honestly means typing every module that reaches it (dispatch,
// workflow_runs, org, orgInit).
type Ctx = { db: any; scheduler?: any };

// Resolved rows stay in the subscription window briefly so an answer made on
// one device reconciles on others instead of the row just vanishing.
const RESOLVED_WINDOW_MS = 24 * 60 * 60 * 1000;
// A role's recommendation is expected within this; a later one still lands.
export const HOP_DEADLINE_MS = 5 * 60 * 1000;
// A grant expires after this (D2).
export const GRANT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// "Handled without you" looks back this far.
const HANDLED_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
// The grant rule (D2): agreed with N times, from M different askers.
export const GRANT_RULE = { agreements: 3, askers: 2 };
// How far back agreement history and the role ladder listing scan.
const HISTORY_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

// ── Id resolution ─────────────────────────────────────────────────────────────

// `sd-N` (the short id the CLI prints) or a raw Convex id.
export async function findDecision(ctx: Ctx, ref: string): Promise<DecisionRow | null> {
  if (/^sd-\d+$/.test(ref)) {
    return (
      (await ctx.db
        .query("session_decisions")
        .withIndex("by_short_id", (q: any) => q.eq("short_id", ref))
        .first()) ?? null
    );
  }
  const id = ctx.db.normalizeId("session_decisions", ref);
  return id ? await ctx.db.get(id) : null;
}

async function findTask(ctx: Ctx, ref: string): Promise<any | null> {
  if (/^ct-\d+$/.test(ref)) {
    return (
      (await ctx.db
        .query("tasks")
        .withIndex("by_short_id", (q: any) => q.eq("short_id", ref))
        .first()) ?? null
    );
  }
  const id = ctx.db.normalizeId("tasks", ref);
  return id ? await ctx.db.get(id) : null;
}

export async function findStack(ctx: Ctx, ref: string): Promise<Doc<"decision_stacks"> | null> {
  if (/^ds-\d+$/.test(ref)) {
    return (
      (await ctx.db
        .query("decision_stacks")
        .withIndex("by_short_id", (q: any) => q.eq("short_id", ref))
        .first()) ?? null
    );
  }
  const id = ctx.db.normalizeId("decision_stacks", ref);
  return id ? await ctx.db.get(id) : null;
}

// One boundary for the task and the stack a decision binds to, shared by the
// ask, the edit and the list so the rules cannot drift: the task must be
// readable by the caller, the stack must sit inside a role the caller can
// reach, and a write may not append to a stack that is done.
export async function resolveDecisionBindings(
  ctx: Ctx,
  userId: Id<"users">,
  refs: { task?: string; stack?: string },
  opts: { write?: boolean } = {}
): Promise<{ task: any | null; stack: Doc<"decision_stacks"> | null } | { error: string }> {
  let task: any = null;
  if (refs.task) {
    task = await findTask(ctx, refs.task);
    if (!task) return { error: `Task not found: ${refs.task}` };
    if (!(await canAccessTask(ctx, userId, task))) return { error: `Task not accessible: ${refs.task}` };
  }
  let stack: Doc<"decision_stacks"> | null = null;
  if (refs.stack) {
    // Short ids are sequential, so a bare lookup would list any team's stack.
    stack = await findStack(ctx, refs.stack);
    if (!stack) return { error: `Stack not found: ${refs.stack}` };
    if (!(await userCanAccessRole(ctx, userId, { host_user_id: stack.owner_user_id, scope_user_id: stack.scope_user_id, team_id: stack.team_id }))) {
      return { error: `Stack not accessible: ${refs.stack}` };
    }
    if (opts.write && stack.status === "done") return { error: `Stack ${stack.short_id} is done; create a new one` };
  }
  return { task, stack };
}

// Joining a stack: the stack lists the decision once, and the returned patch
// gives the row its stack pointer and scope key. Empty when the row already
// sits in that stack, so the caller can tell a real join from a no-op.
export async function joinStack(
  ctx: Ctx,
  stack: Doc<"decision_stacks">,
  row: { _id: Id<"session_decisions">; stack_id?: Id<"decision_stacks">; scope_keys?: string[] },
  now: number
): Promise<{ stack_id?: Id<"decision_stacks">; stack_joined_at?: number; scope_keys?: string[] }> {
  if (!stack.decision_ids.includes(row._id)) {
    await ctx.db.patch(stack._id, { decision_ids: [...stack.decision_ids, row._id], updated_at: now });
  }
  if (row.stack_id === stack._id) return {};
  const key = `stack:${stack._id}`;
  const keys = row.scope_keys ?? [];
  return { stack_id: stack._id, stack_joined_at: now, scope_keys: keys.includes(key) ? keys : [...keys, key] };
}

// ── People, ladder, holder ────────────────────────────────────────────────────

// The role a session speaks as: the role it reports to, or the role it IS
// (a standing session; that field may not exist yet on every deployment).
export { roleOfConversation } from "./lib/actor";

type Hop = { role_id: Id<"org_roles">; recommendation?: number; note?: string; at: number };

// The ladder (D2): the roles from the asker up to the first person. A paused
// or retired role is recorded as a skipped hop so the card can show the gap;
// only active roles may recommend, and only the first is told (routeFor).
export async function buildLadder(
  ctx: Ctx,
  startRole: Doc<"org_roles"> | null,
  now: number,
): Promise<{ hops: Hop[]; firstPersonId?: Id<"users">; activeRoles: Doc<"org_roles">[] }> {
  const hops: Hop[] = [];
  const activeRoles: Doc<"org_roles">[] = [];
  const seen = new Set<string>();
  let cur = startRole;
  let firstPersonId: Id<"users"> | undefined;
  while (cur && !seen.has(cur._id) && seen.size < 32) {
    seen.add(cur._id);
    if (cur.status === "active") {
      hops.push({ role_id: cur._id, at: now });
      activeRoles.push(cur);
    } else {
      hops.push({ role_id: cur._id, note: `skipped: ${cur.status}`, at: now });
    }
    if (cur.reports_to.kind === "user") {
      firstPersonId = cur.reports_to.user_id;
      break;
    }
    cur = await ctx.db.get(cur.reports_to.role_id);
  }
  return { hops, firstPersonId, activeRoles };
}

// The people a decision is visible to — whose question stack it sits on.
// The session's owners, never the runner (conversations.user_id). Assignment
// is how a question moves; including the runner kept it on the previous
// person's stack after they handed the session over. Only a person can be
// asked: an agent account (users.is_bot) runs sessions but reads no queue, so
// an unowned session it runs has no people here and routeFor finds them.
//
// `firstPersonId` is the person the reporting line ends at, when the caller
// wants them in (routeFor): the first person above a hand's role, so a
// manager sees questions from work that reports to them, and the person a
// lead's role reports to, who may not be the host its seat runs on.
export async function peopleFor(ctx: Ctx, conversation: any, firstPersonId?: Id<"users">): Promise<Id<"users">[]> {
  const owners = await listSessionOwnerIds(ctx, conversation._id);
  // The join table is canonical. A stale owner_user_id cache (the runner
  // after the seat was assigned away) must not keep questions on that person.
  const ids: Id<"users">[] = [...owners];
  if (ids.length === 0) {
    const implicit = conversation.owner_user_id ?? (await humanStarterUser(ctx, conversation))?._id;
    if (implicit) ids.push(implicit);
  }
  if (firstPersonId) ids.push(firstPersonId);
  return Array.from(new Set(ids.map(String))) as Id<"users">[];
}

// Where a session's decision goes (org-staffing.md S28). A hand's ladder
// starts at its role. A standing session's starts at its parent, never at the
// role that asked: a lead that reports to a person has no role above it and
// its people are its owners and that person; a sub-lead's people are its
// owners alone, and its parent role reads it first. `hears` is the one role
// told about the decision, the first on the ladder, when it can be told
// (reachableRole). While a role hears, the decision enters no person's queue:
// the role answers, recommends, or raises it in its own thread, and the
// person's queue holds only what a lead that reports to them asks. With no
// role to hear, the people's queue is where it lands, so it is never lost.
//
// A session no person answers for (an agent account runs it, nobody owns it)
// asks on behalf of the work: the question climbs the line of the task's
// project lead to the person it ends at, and the lead hears it first. With no
// such line, the workspace's admins are asked. Every decision has a person.
export async function routeFor(ctx: Ctx, conversation: any, now: number, task?: any) {
  // A hosted conversation's question is its owner's alone (hostedAnswerRefusal):
  // no role hears it and nobody else is asked.
  if (isHostedAgentType(conversation.agent_type)) {
    return { role: null, ladder: await buildLadder(ctx, null, now), people: [conversation.user_id as Id<"users">], hears: null };
  }
  const role = await roleOfConversation(ctx, conversation);
  const parent = conversation.standing_role_id ? role?.reports_to : undefined;
  const first = parent ? (parent.kind === "role" ? await ctx.db.get(parent.role_id) : null) : role;
  const ladder = await buildLadder(ctx, first, now);
  const people = await peopleFor(ctx, conversation, parent ? (parent.kind === "user" ? parent.user_id : undefined) : ladder.firstPersonId);
  const hears = first && (await reachableRole(ctx, first._id)) ? first : null;
  if (people.length > 0) return { role, ladder, people, hears };
  const lead = await projectLeadRole(ctx, task);
  const leadLadder = lead ? await buildLadder(ctx, lead, now) : null;
  if (lead && leadLadder?.firstPersonId) {
    return { role, ladder: leadLadder, people: [leadLadder.firstPersonId], hears: (await reachableRole(ctx, lead._id)) ? lead : null };
  }
  return { role, ladder, people: await workspaceAdmins(ctx, conversation.team_id), hears };
}

async function workspaceAdmins(ctx: Ctx, teamId: Id<"teams"> | undefined): Promise<Id<"users">[]> {
  if (!teamId) return [];
  const members = await ctx.db.query("team_memberships").withIndex("by_team_id", (q: any) => q.eq("team_id", teamId)).collect();
  const admins: Id<"users">[] = [];
  for (const m of members) {
    if (m.role !== "admin") continue;
    const u = await ctx.db.get(m.user_id);
    if (u && !u.is_bot) admins.push(m.user_id);
  }
  return admins;
}

// Keep decision_inbox in lockstep with asked_user_ids: insert missing pending
// rows, delete rows for people who are no longer in the set. Deleting is
// required — a done inbox row for a still-pending decision still lists in
// listForUserCore, so marking it done would leave the card on their stack.
// `queue: false` (a role hears the decision, routeFor) inserts nothing: a
// row already in front of a person stays there, and no new one is made.
export async function syncDecisionInbox(
  ctx: Ctx,
  decisionId: Id<"session_decisions">,
  people: Id<"users">[],
  now: number,
  queue = true,
): Promise<void> {
  const wanted = new Set(people.map(String));
  const existing = await ctx.db
    .query("decision_inbox")
    .withIndex("by_decision", (q: any) => q.eq("decision_id", decisionId))
    .collect();
  const have = new Set<string>();
  for (const row of existing) {
    const key = String(row.user_id);
    if (wanted.has(key)) {
      have.add(key);
      if (row.status !== "pending") await ctx.db.patch(row._id, { status: "pending" });
    } else {
      await ctx.db.delete(row._id);
    }
  }
  for (const userId of queue ? people : []) {
    if (have.has(String(userId))) continue;
    await ctx.db.insert("decision_inbox", { decision_id: decisionId, user_id: userId, status: "pending", created_at: now });
  }
}

// Recompute people, inbox rows and holder for every open decision on this
// session. Called after ownership changes so the question stack follows
// assignment instead of staying with the runner or the role parent.
export async function reroutePendingDecisionsForConversation(
  ctx: Ctx,
  conversationId: Id<"conversations">,
  now: number,
): Promise<{ moved: number }> {
  // The open rows first: most sessions that change hands have no question
  // open, and the ladder walk is several reads that a takeover of 100
  // sessions would otherwise repeat for nothing.
  const openRows: DecisionRow[] = await ctx.db
    .query("session_decisions")
    .withIndex("by_conversation_status", (q: any) => q.eq("conversation_id", conversationId).eq("status", "pending"))
    .collect();
  if (openRows.length === 0) return { moved: 0 };
  const conversation = await ctx.db.get(conversationId);
  if (!conversation) return { moved: 0 };
  for (const row of openRows) {
    const task = row.task_id ? await ctx.db.get(row.task_id) : null;
    const { people, hears, ladder } = await routeFor(ctx, conversation, now, task);
    // A row asked with no ladder takes the one it now climbs, and its first
    // role hears; a row that has one keeps it and the recommendations on it.
    const climbs = !row.hops?.length && ladder.hops.length > 0;
    await ctx.db.patch(row._id, { asked_user_ids: people, ...(climbs ? { hops: ladder.hops } : {}) });
    const woken = climbs ? await tellHearingRole(ctx, hears, row, now) : [];
    await syncDecisionInbox(ctx, row._id, people, now, !hears || (climbs && woken.length === 0));
    const updated = await ctx.db.get(row._id);
    if (updated) await refreshHolder(ctx, updated, now);
  }
  return { moved: openRows.length };
}

// Repair for questions asked before routing knew an agent account is nobody's
// reader: every open decision whose people include one is routed again.
export const rerouteDecisionsHeldByAgents = internalMutation({
  args: { dry_run: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const open: DecisionRow[] = await ctx.db
      .query("session_decisions")
      .withIndex("by_status_created", (q: any) => q.eq("status", "pending"))
      .collect();
    const conversations = new Set<string>();
    const held: string[] = [];
    for (const row of open) {
      for (const id of row.asked_user_ids ?? [row.user_id]) {
        const u = await ctx.db.get(id);
        if (!u?.is_bot) continue;
        conversations.add(String(row.conversation_id));
        held.push(row.short_id ?? String(row._id));
        break;
      }
    }
    if (!args.dry_run) {
      for (const id of conversations) await reroutePendingDecisionsForConversation(ctx, id as Id<"conversations">, Date.now());
    }
    return { held, conversations: conversations.size, dry_run: !!args.dry_run };
  },
});

// Repair path for a session that was assigned before questions followed
// owners: recompute people and inbox rows from the current owner set.
export const reroutePendingForConversation = internalMutation({
  args: { conversation_id: v.string() },
  handler: async (ctx, args) => {
    const ref = args.conversation_id.trim();
    if (/^sd-\d+$/.test(ref)) {
      const d = await findDecision(ctx, ref);
      if (!d) throw new Error(`No decision ${ref}`);
      return reroutePendingDecisionsForConversation(ctx, d.conversation_id, Date.now());
    }
    // Newest short-id match that still has open questions, else the newest
    // match. `.first()` on by_short_id is the oldest collision and is how a
    // repair of jx76e8h moved 0 rows.
    const withOpen = await findConversationByAnyRefWhere(ctx, ref, async (c) => {
      const pending = await ctx.db
        .query("session_decisions")
        .withIndex("by_conversation_status", (q: any) => q.eq("conversation_id", c._id).eq("status", "pending"))
        .first();
      return !!pending;
    });
    const conversation = withOpen ?? await findConversationByAnyRefWhere(ctx, ref, () => true);
    if (!conversation) throw new Error(`No session ${ref}`);
    return reroutePendingDecisionsForConversation(ctx, conversation._id, Date.now());
  },
});

// The scope keys a grant may match for this decision: the asker's role and
// its projects and plans, the task's project and plan, the stack.
export function scopeKeysFor(role: Doc<"org_roles"> | null, task: any | null, stackId?: Id<"decision_stacks">): string[] {
  const keys: string[] = [];
  if (role) {
    keys.push(`role:${role._id}`);
    for (const p of role.scope?.project_ids ?? []) keys.push(`project:${p}`);
    for (const p of role.scope?.plan_ids ?? []) keys.push(`plan:${p}`);
  }
  if (task?.project_id) keys.push(`project:${task.project_id}`);
  if (task?.plan_id) keys.push(`plan:${task.plan_id}`);
  if (stackId) keys.push(`stack:${stackId}`);
  return Array.from(new Set(keys));
}

export function grantIsLive(g: Doc<"decision_grants">, now: number): boolean {
  return !g.revoked_at && g.expires_at > now;
}

// The first live grant among these roles for (category, one of the scopes).
export async function activeGrantFor(
  ctx: Ctx,
  roleIds: Id<"org_roles">[],
  category: string,
  scopeKeys: string[],
  now: number,
): Promise<Doc<"decision_grants"> | null> {
  for (const roleId of roleIds) {
    const rows: Doc<"decision_grants">[] = await ctx.db
      .query("decision_grants")
      .withIndex("by_role", (q: any) => q.eq("role_id", roleId).eq("category", category))
      .collect();
    const hit = rows.find((g) => grantIsLive(g, now) && scopeKeys.includes(g.scope_key));
    if (hit) return hit;
  }
  return null;
}

// Who may answer (D2): the people, unless a ladder role (or the stack's
// delegate) holds a live grant for the category in one of the scopes. A human
// only category never resolves to a role.
export async function resolveHolder(
  ctx: Ctx,
  input: {
    people: Id<"users">[];
    roleIds: Id<"org_roles">[];
    category: string;
    scopeKeys: string[];
    now: number;
  },
): Promise<{ holder: { kind: "user" | "role"; id: string }; holder_key: string; grant: Doc<"decision_grants"> | null }> {
  const person = { kind: "user" as const, id: String(input.people[0]) };
  if (isHumanOnlyCategory(input.category) || input.roleIds.length === 0) {
    return { holder: person, holder_key: `user:${person.id}`, grant: null };
  }
  const grant = await activeGrantFor(ctx, input.roleIds, input.category, input.scopeKeys, input.now);
  if (grant) {
    return { holder: { kind: "role", id: String(grant.role_id) }, holder_key: `role:${grant.role_id}`, grant };
  }
  return { holder: person, holder_key: `user:${person.id}`, grant: null };
}

async function stackDelegateRoleId(ctx: Ctx, stackId: Id<"decision_stacks"> | undefined): Promise<Id<"org_roles"> | undefined> {
  if (!stackId) return undefined;
  const stack = await ctx.db.get(stackId);
  return stack?.policy?.delegate_role_id;
}

// Recompute and store the holder of a pending row (after a grant, a stack
// delegate, or a reopen changed who may answer).
export async function refreshHolder(
  ctx: Ctx,
  row: DecisionRow,
  now: number,
  opts: { excludeRoleIds?: Id<"org_roles">[] } = {},
): Promise<void> {
  const excluded = new Set((opts.excludeRoleIds ?? []).map(String));
  const roleIds = (row.hops ?? [])
    // "escalated" is a note only rows from before S28 carry: a role that
    // passed the question up without a recommendation gave up its hold.
    .filter((h) => !h.note?.startsWith("skipped") && !h.note?.startsWith("escalated"))
    .map((h) => h.role_id)
    .filter((id) => !excluded.has(String(id)));
  const delegate = await stackDelegateRoleId(ctx, row.stack_id);
  if (delegate && !excluded.has(String(delegate))) roleIds.push(delegate);
  const resolved = await resolveHolder(ctx, {
    people: row.asked_user_ids ?? [row.user_id],
    roleIds,
    category: row.category ?? "unknown",
    scopeKeys: (row as any).scope_keys ?? [],
    now,
  });
  await ctx.db.patch(row._id, { holder: resolved.holder, holder_key: resolved.holder_key });
}

// Tell the role that hears a decision (routeFor), once, through its
// needs-input trigger (org-staffing.md S25, S28): a session under it waits on
// a decision, and the run names the session and the question. Only that role:
// the ones above it hear when it raises the question itself, up its own line.
// Empty when the role cannot be told (its trigger paused or cancelled, no
// session), so the caller puts the decision in front of the people instead.
async function tellHearingRole(
  ctx: Ctx,
  role: Doc<"org_roles"> | null,
  row: { _id: Id<"session_decisions">; short_id?: string; question: string; conversation_id?: Id<"conversations"> },
  now: number,
) {
  if (!role) return [];
  const conv = row.conversation_id ? await ctx.db.get(row.conversation_id) : null;
  const id = await fireRoleNeedsInput(ctx as any, role._id, {
    short_id: conv?.short_id ?? String(row.conversation_id ?? "").slice(0, 7),
    title: (conv?.title ?? "").slice(0, 80),
    why: "decision",
    since: now,
    decision: row.short_id ?? String(row._id),
    state: row.question.split("\n")[0].slice(0, 200),
  }, `decision:${row._id}:${role._id}`);
  return id ? [role._id] : [];
}

// ── Answers ───────────────────────────────────────────────────────────────────

export type Verdict = {
  // withdrawn: the asker took the question back (withdrawCore); it settles
  // like a dismissal so the ladder learns the fact, and never scores a grant.
  status: "answered" | "dismissed" | "withdrawn";
  answer_index?: number;
  answer_text?: string;
  answer_json?: any;
};

/** The verdict a resolved row stands at, or null while it is pending. */
export function verdictOfRow(row: DecisionRow): Verdict | null {
  if (row.status === "answered") return { status: "answered", answer_index: row.answer_index, answer_text: row.answer_text, answer_json: row.answer_json };
  return row.status === "pending" ? null : { status: row.status };
}

// The one line the asking agent acts on, per kind.
export function answerLabel(row: { kind?: string; options: { label: string }[] }, verdict: Verdict): string | undefined {
  if (verdict.status !== "answered") return undefined;
  return decisionAnswerLabel(row, verdict);
}

// Validate an answer against the row's kind. Returns the normalized verdict.
export function normalizeVerdict(row: DecisionRow, raw: Verdict): Verdict | { error: string } {
  if (raw.status === "dismissed") return { status: "dismissed" };
  const kind: DecisionKind = (row.kind ?? "single") as DecisionKind;
  const n = row.options.length;
  const inRange = (i: any) => Number.isInteger(i) && i >= 0 && i < n;
  if (kind === "single") {
    if (raw.answer_index === undefined && !raw.answer_text) return { error: "answer_index or answer_text required" };
    if (raw.answer_index !== undefined && !inRange(raw.answer_index)) return { error: "answer_index out of range" };
    return { status: "answered", answer_index: raw.answer_index, answer_text: raw.answer_text };
  }
  if (kind === "multi" || kind === "rank") {
    const list = Array.isArray(raw.answer_json) ? raw.answer_json : raw.answer_index !== undefined ? [raw.answer_index] : null;
    if (!list || list.length === 0) return { error: `${kind} answer needs a list of option indexes` };
    if (!list.every(inRange)) return { error: "an option index is out of range" };
    if (new Set(list).size !== list.length) return { error: "an option index repeats" };
    return { status: "answered", answer_json: list, answer_index: list[0], answer_text: raw.answer_text };
  }
  // form
  const values = raw.answer_json;
  if (!values || typeof values !== "object" || Array.isArray(values)) return { error: "form answer needs key=value pairs" };
  const fields = row.form?.fields ?? [];
  for (const f of fields) {
    if (!(f.key in values)) return { error: `form field missing: ${f.key}` };
    const val = values[f.key];
    // Each value must match the field's declared type: the CLI coerces by
    // that type, and the web sends typed inputs; anything else is refused.
    if (f.type === "number" && !(typeof val === "number" && Number.isFinite(val))) return { error: `form field ${f.key} must be a number` };
    if (f.type === "bool" && typeof val !== "boolean") return { error: `form field ${f.key} must be true or false` };
    if (f.type === "text" && typeof val !== "string") return { error: `form field ${f.key} must be text` };
    if (f.type === "select" && (typeof val !== "string" || (f.options && !f.options.includes(val)))) {
      return { error: `form field ${f.key} must be one of: ${(f.options ?? []).join(", ")}` };
    }
  }
  return { status: "answered", answer_json: values, answer_text: raw.answer_text };
}

export type AnsweredBy = { kind: "user" | "role" | "policy"; id: string; user_id?: Id<"users">; grant_id?: Id<"decision_grants">; via?: Id<"conversations"> };

export const HOSTED_ANSWER_REFUSED = "Only the owner can answer a hosted assistant's question";

// A hosted conversation's question is its consent gate
// (docs/architecture/hosted-assistant.md): only the conversation's owner
// answers or dismisses it, in person. An asked teammate, a role under a grant
// and a stack default are all refused. Every resolve path checks this before
// it writes: finalizeAnswer (CLI, web resolve, a run's gate, a stack
// default), answerCore (so the CLI gets the reason back as an error), the
// stack's auto default (which skips the row) and the web's dispatch rail. Returns why the answer is refused, or null.
export async function hostedAnswerRefusal(ctx: Ctx, row: { conversation_id?: Id<"conversations"> }, by: AnsweredBy): Promise<string | null> {
  const conversation: any = row.conversation_id ? await ctx.db.get(row.conversation_id) : null;
  if (!conversation || !isHostedAgentType(conversation.agent_type)) return null;
  if (by.kind === "user" && String(by.user_id) === String(conversation.user_id)) return null;
  return HOSTED_ANSWER_REFUSED;
}

// The one place a decision is resolved, for every path (web resolve, CLI
// answer, a role under a grant, a stack auto default, a dismissal). First
// writer wins: a row that is no longer pending is left alone.
//
// deliver: send the answer into the asking session as the "Decision: …" user
// message. The web client does that itself (store answerDecision), so the web
// path passes false; every server-side answer passes true.
export async function finalizeAnswer(
  ctx: Ctx,
  row: DecisionRow,
  verdict: Verdict,
  by: AnsweredBy,
  opts: { deliver: boolean; now?: number },
): Promise<{ already_resolved: boolean; answer_label?: string; delivered?: boolean; resumed_run?: boolean }> {
  if (row.status !== "pending") return { already_resolved: true };
  const refusal = await hostedAnswerRefusal(ctx, row, by);
  if (refusal) throw new Error(refusal);
  const now = opts.now ?? Date.now();
  const label = answerLabel(row, verdict);
  await ctx.db.patch(row._id, {
    status: verdict.status,
    answer_index: verdict.answer_index,
    answer_text: verdict.answer_text,
    answer_json: verdict.answer_json,
    resolved_at: now,
    resolved_by: by.user_id,
    answered_by: { kind: by.kind, id: by.id, ...(by.via ? { via: by.via } : {}) },
    grant_id: by.grant_id,
  });
  const consumed = await settleResolution(ctx, row, verdict, by, now);
  // A decision bound to a run (the-line.md L4) is never delivered by a
  // client, so the server delivers it unless the run consumed it as its
  // open gate (the runner's poll reads gate_response instead). A failure
  // gate on a run that is already failed is still delivered to its asker.
  // A silent card (a pointer) is cleared by the answer and delivers nothing.
  const delivered = (opts.deliver || !!row.workflow_run_id) && !consumed && !row.silent;
  if (delivered) await deliverAnswer(ctx, row, verdict, by);
  // `resumed_run` tells a caller the run took the answer (the-line.md L4), so
  // the CLI can say "the run resumes" instead of promising a message.
  return { already_resolved: false, answer_label: label, delivered, resumed_run: consumed };
}

// The "Decision: …" user message into the asking session, the one delivery
// for every server path (finalizeAnswer, settleClientResolution).
async function deliverAnswer(ctx: Ctx, row: DecisionRow, verdict: Verdict, by: AnsweredBy) {
  const label = answerLabel(row, verdict);
  if (verdict.status !== "answered" || !label) return;
  const conversation = await ctx.db.get(row.conversation_id);
  if (!conversation) return;
  await enqueuePendingMessage(ctx, conversation, by.user_id ?? conversation.user_id, {
    content: formatDecisionAnswer({ id: String(row._id), question: row.question, answer: label }),
    client_id: decisionAnswerClientId(String(row._id)),
    human: by.kind === "user",
    // Only the owner answers a hosted conversation's question
    // (hostedAnswerRefusal), so this always wakes it as an approval; every
    // other conversation ignores the cause. It is a scheduling hint, never
    // consent: a hosted turn executes a write only after reading its
    // session_decisions row.
    wake_cause: "approval",
  });
}

// A gate decision resumes its run (the-line.md L4): gate_response is the
// chosen option's gate key (gate_choices[i].key, by option index) or the
// typed text, and the run goes back to running so the runner's poll picks
// it up. A dismissed gate has no answer for the run to route on, so the run
// fails the same way a withdrawn gate does. Every resolve path (server
// answers through finalizeAnswer, the web's dispatch patch through
// settleClientResolution) lands here, so the run cannot miss an answer.
// Returns true when the run consumed the answer (it was paused on this
// decision); a decision on a run that is past it, or failed, is not consumed
// and is delivered to its asker like any other.
async function settleGateRun(ctx: Ctx, row: DecisionRow, verdict: Verdict, now: number): Promise<boolean> {
  if (!row.workflow_run_id) return false;
  const run = await ctx.db.get(row.workflow_run_id);
  if (!run || run.status !== "paused") return false;
  if (String(run.gate_decision_id ?? "") !== String(row._id)) return false;
  if (verdict.status !== "answered") {
    await ctx.db.patch(run._id, { status: "failed", fail_reason: "gate dismissed", updated_at: now });
    return true;
  }
  const key: string | undefined = verdict.answer_index !== undefined ? run.gate_choices?.[verdict.answer_index]?.key : undefined;
  const text = verdict.answer_text?.trim();
  let response: string;
  if (!key) response = text || answerLabel(row, verdict) || "";
  else if (!text) response = key;
  else {
    // A note typed beside a chosen option keeps the key in front so the
    // runner routes on it and still hands the note to the next node.
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    response = new RegExp(`^\\[?${escaped}\\]?([:\\s]|$)`, "i").test(text) ? text : `${key}: ${text}`;
  }
  await ctx.db.patch(run._id, { gate_response: response, status: "running", updated_at: now });
  return true;
}

// The side effects every resolution carries, whoever wrote it: the people's
// inbox rows close, a reopened granted answer is scored, the stack closes when
// this was its last member. Shared by finalizeAnswer (server answers) and the
// web's generic dispatch patch (settleClientResolution), so the two paths
// cannot drift. Returns whether a run consumed the answer as its open gate.
async function settleResolution(ctx: Ctx, row: DecisionRow, verdict: Verdict, by: AnsweredBy, now: number): Promise<boolean> {
  await setInboxStatus(ctx, row._id, "done");
  await scoreOverride(ctx, row, verdict, by, now);
  await closeStackIfDone(ctx, row.stack_id, row._id, now);
  // An answered card gate is recorded and learned from (LE12).
  await learnFromCardGate(ctx, row, verdict, by.user_id);
  // Its "card waiting" notice stops claiming a card waits (LE16).
  await settleCardWaiting(ctx, row);
  await noticeAnsweredForPeople(ctx, row, verdict, by);
  // An expectations proposal's card applies or drops it (LM5).
  await settleExpectationCard(ctx, row, verdict, by, now);
  // Tasks waiting on this decision settle (task-graph.md TG2).
  await scheduleDecisionSettle({ scheduler: ctx.scheduler }, row, by);
  // A dismissal delivers no message, so a hosted turn parked on this
  // question is woken here to read the declined row and move on. An answer
  // wakes through its delivered message (deliverAnswer).
  if (verdict.status === "dismissed") {
    const conversation = await ctx.db.get(row.conversation_id);
    if (conversation) await wakeHostedConversation(ctx, conversation, "approval");
  }
  return await settleGateRun(ctx, row, verdict, now);
}

// Any reader of a decision may answer it, not only the people it was asked
// of (userMayRead); hosted conversations keep their owner-only rule
// (hostedAnswerRefusal). When someone outside the people acts, the people
// hear who answered for them, so an answer they did not give never lands
// unannounced.
async function noticeAnsweredForPeople(ctx: Ctx, row: DecisionRow, verdict: Verdict, by: AnsweredBy) {
  if (by.kind !== "user" || !by.user_id) return;
  const people = (row.asked_user_ids ?? [row.user_id]).map(String);
  if (people.includes(by.id)) return;
  const question = row.question.length > 120 ? `${row.question.slice(0, 117)}...` : row.question;
  const label = answerLabel(row, verdict);
  await emitNotification(ctx as any, {
    event_type: "decision_answered_for_you",
    actor_user_id: by.user_id,
    entity_type: "conversation",
    entity_id: String(row.conversation_id),
    conversation_id: row.conversation_id,
    message: verdict.status === "dismissed" || !label
      ? `dismissed "${question}" for you`
      : `answered "${question}" for you: ${label}`,
    ...(row.short_id ? { link: `/decisions/${row.short_id}` } : {}),
    recipient_ids: people.map((id) => ctx.db.normalizeId("users", id)).filter((id): id is Id<"users"> => !!id),
  });
}

// A web client resolved the row through the dispatch collection patch (the
// store's answerDecision). The client already sent the answer message into
// the session, so nothing is delivered here; the row gets its answered_by
// stamp and the shared side effects. `row` is the PRE-patch row. The one
// exception is a decision bound to a run (the-line.md L4): the client never
// delivers those, so the server delivers when the run did not consume it.
export async function settleClientResolution(
  ctx: Ctx,
  row: DecisionRow,
  patch: { status?: string; answer_index?: number; answer_text?: string; answer_json?: any },
  userId: Id<"users">,
  now: number,
) {
  if (patch.status !== "answered" && patch.status !== "dismissed") return;
  // A person changing an advisory answer (advisoryAnswerOpen): the client sent
  // the new answer into the session, and the side effects already ran when
  // the row first settled, so the row only learns who answered last, and the
  // waits it met carry the new answer (taskWaits.restateAnswer).
  if (row.status !== "pending") {
    if (patch.status === "answered" && advisoryAnswerOpen(row)) {
      await ctx.db.patch(row._id, { answered_by: { kind: "user", id: String(userId) }, resolved_by: userId, resolved_at: now });
      await scheduleDecisionSettle({ scheduler: ctx.scheduler }, row, { user_id: userId });
    }
    return;
  }
  const verdict: Verdict = {
    status: patch.status,
    answer_index: patch.answer_index,
    answer_text: patch.answer_text,
    answer_json: patch.answer_json,
  };
  const by: AnsweredBy = { kind: "user", id: String(userId), user_id: userId };
  await ctx.db.patch(row._id, { answered_by: { kind: "user", id: String(userId) }, resolved_by: userId, resolved_at: now });
  const consumed = await settleResolution(ctx, row, verdict, by, now);
  if (row.workflow_run_id && !consumed) await deliverAnswer(ctx, row, verdict, by);
}

// The dispatch rail's pending guard (first writer wins on every rail): a
// resolution patch on a row that is no longer pending is dropped whole, so a
// web answer cannot overwrite what a role already wrote. The one exception is
// a new answer on an advisory ask (advisoryAnswerOpen): the agent went ahead
// on its default, and a person may still change its course.
// Pure, so it is unit tested without the dispatch mutation.
const RESOLUTION_FIELDS = ["status", "answer_index", "answer_text", "answer_json", "resolved_at"];
export function guardClientResolution(doc: { status?: string; blocking?: boolean; workflow_run_id?: unknown; answered_by?: { kind: string } | null }, safe: Record<string, any>): Record<string, any> {
  if (doc.status === "pending") return safe;
  if (safe.status === "answered" && advisoryAnswerOpen(doc as any)) return safe;
  return RESOLUTION_FIELDS.some((f) => f in safe) ? {} : safe;
}

// Whether a signed-in person may resolve this row from the web: anyone in its
// people set (asked_user_ids), or the legacy owner.
export function personMayResolve(row: { user_id: any; asked_user_ids?: any[] }, userId: any): boolean {
  if (row.asked_user_ids !== undefined) {
    return row.asked_user_ids.some((id) => id.toString() === userId.toString());
  }
  return row.user_id?.toString() === userId.toString();
}

export async function setInboxStatus(ctx: Ctx, decisionId: Id<"session_decisions">, status: "pending" | "done") {
  const rows = await ctx.db
    .query("decision_inbox")
    .withIndex("by_decision", (q: any) => q.eq("decision_id", decisionId))
    .collect();
  for (const r of rows) if (r.status !== status) await ctx.db.patch(r._id, { status });
}

// Override tracking (D2): a person answering a reopened granted decision
// differently is an override; two in a row revoke the grant. An agreement
// resets the streak.
async function scoreOverride(ctx: Ctx, row: DecisionRow, verdict: Verdict, by: AnsweredBy, now: number) {
  if (by.kind !== "user" || !row.reopened_from || verdict.status === "withdrawn") return;
  const grant = await ctx.db.get(row.reopened_from.grant_id);
  if (!grant || grant.revoked_at) return;
  const agreed = verdict.status === "answered" && verdict.answer_index === row.reopened_from.answer_index;
  if (agreed) {
    if (grant.override_streak) await ctx.db.patch(grant._id, { override_streak: 0 });
    return;
  }
  const streak = (grant.override_streak ?? 0) + 1;
  if (streak >= 2) {
    await ctx.db.patch(grant._id, {
      override_streak: streak,
      revoked_at: now,
      revoked_reason: `overridden ${streak} times in a row (last: ${row.short_id ?? row._id})`,
    });
  } else {
    await ctx.db.patch(grant._id, { override_streak: streak });
  }
}

// A stack is done when every member is resolved. `resolvingId` is the row
// being patched in this same transaction (its status is already written).
async function closeStackIfDone(ctx: Ctx, stackId: Id<"decision_stacks"> | undefined, resolvingId: Id<"session_decisions">, now: number) {
  if (!stackId) return;
  const stack = await ctx.db.get(stackId);
  if (!stack || stack.status === "done") return;
  for (const id of stack.decision_ids) {
    if (id === resolvingId) continue;
    const d = await ctx.db.get(id);
    if (d && d.status === "pending") return;
  }
  await ctx.db.patch(stackId, { status: "done", updated_at: now });
}

// ── Ask ───────────────────────────────────────────────────────────────────────

export type AskArgs = {
  session_id: string;
  question: string;
  options: Array<{ label: string; description?: string; body_md?: string; evidence?: { label: string; url: string }[]; cost?: string; risk?: string; page_slug?: string }>;
  context_md?: string;
  report_slug?: string;
  /** A change card (LE10) the decision is about; rendered natively by the web. */
  card?: ChangeCard;
  blocking?: boolean;
  /** A pointer card: answering resolves it and delivers nothing into the
   *  asking session (a staffing proposal's queue card, org-staffing.md S4). */
  silent?: boolean;
  default_option?: number;
  kind?: DecisionKind;
  category?: string;
  doc_md?: string;
  form?: { fields: Array<{ key: string; label: string; type: "text" | "number" | "select" | "bool"; options?: string[] }> };
  task?: string;
  station?: string;
  stack?: string;
  // A gate on the line (the-line.md L4): the run this question pauses and
  // the node that asked. Set by workflow_runs.pauseAtGate and the runner's
  // failure gates; finalizeAnswer resumes the run.
  workflow_run_id?: Id<"workflow_runs">;
  gate_node_id?: string;
  /** Who answers, named: a person's name, email or id in the session's
   *  workspace (`cast decide --to`, the morning agenda of org-staffing.md
   *  S31). The card goes to those people alone; no role hears it. */
  to?: string[];
};

// An option's page (the-line.md L6) must be a published page: a mistyped
// file path would otherwise be stored as a slug and render a dead card.
async function missingOptionPage(ctx: Ctx, options: Array<{ page_slug?: string }>): Promise<string | null> {
  for (let i = 0; i < options.length; i++) {
    const slug = options[i]?.page_slug;
    if (!slug) continue;
    const page = await ctx.db.query("artifacts").withIndex("by_slug", (q: any) => q.eq("slug", slug)).first();
    if (!page) return `Option ${i + 1}: no page ${slug}`;
  }
  return null;
}

// A card is held to the same contract `cast card build` checks, so a
// decision never carries one the web cannot draw.
function invalidCard(card: unknown): string | null {
  if (card === undefined) return null;
  const checked = validateChangeCard(card);
  return checked.ok ? null : `Invalid change card: ${checked.errors.slice(0, 5).join("; ")}`;
}

function validateShape(kind: DecisionKind, args: { question: string; options: any[]; default_option?: number; form?: any; card?: unknown }): string | null {
  if (args.question.trim().length === 0) return "Empty question";
  const cardError = invalidCard(args.card);
  if (cardError) return cardError;
  if (kind === "form") {
    if (!args.form || args.form.fields.length === 0) return "A form decision needs at least one field";
    const keys = args.form.fields.map((f: any) => f.key);
    if (new Set(keys).size !== keys.length) return "Form field keys must be unique";
  } else if (args.options.length < 2) return "At least two options required";
  if (args.options.length > 9) return "At most nine options (they map to keys 1-9)";
  if (args.default_option !== undefined && (args.default_option < 0 || args.default_option >= args.options.length)) {
    return "default_option out of range";
  }
  return null;
}

// The ask, as a plain function so tests drive it against the fake db.
// The decision's long body as a docs row. A re-ask of an open question
// updates the row it already has instead of orphaning a new one.
async function upsertDecisionDoc(
  ctx: Ctx,
  conversation: any,
  question: string,
  doc_md: string,
  now: number,
  existingDocId?: Id<"docs">,
): Promise<Id<"docs">> {
  if (existingDocId) {
    const doc = await ctx.db.get(existingDocId);
    if (doc) {
      await ctx.db.patch(existingDocId, { title: question, content: doc_md, updated_at: now });
      return existingDocId;
    }
  }
  return ctx.db.insert("docs", {
    user_id: conversation.user_id,
    team_id: teamVisibleConvTeam(conversation),
    workspace: computeWorkspaceKey({ user_id: conversation.user_id } as any, conversation as any),
    title: question,
    content: doc_md,
    doc_type: "decision",
    source: "agent",
    conversation_id: conversation._id,
    project_path: conversation.project_path,
    created_at: now,
    updated_at: now,
  });
}

export async function askCore(ctx: Ctx, auth: { userId: Id<"users"> }, args: AskArgs): Promise<any> {
  const kind: DecisionKind = args.kind ?? "single";
  const shapeError = validateShape(kind, args) ?? (await missingOptionPage(ctx, args.options));
  if (shapeError) return { error: shapeError };

  const conversation = await ctx.db
    .query("conversations")
    .withIndex("by_session_id", (q: any) => q.eq("session_id", args.session_id))
    .first();
  if (!conversation) return { error: "Session not found" };
  if (conversation.user_id.toString() !== auth.userId.toString()) {
    return { error: "Unauthorized: not your session" };
  }

  const now = Date.now();

  const bound = await resolveDecisionBindings(ctx, auth.userId, args, { write: true });
  if ("error" in bound) return bound;
  const { task, stack } = bound;

  const { category, pinned } = assignCategory({ question: args.question, options: args.options, context_md: args.context_md }, args.category);

  // Re-asking the same question from the same session updates the open row
  // instead of stacking duplicates (an agent may retry after a crash).
  const openRows: DecisionRow[] = await ctx.db
    .query("session_decisions")
    .withIndex("by_conversation_status", (q: any) => q.eq("conversation_id", conversation._id).eq("status", "pending"))
    .collect();
  // Earlier asks still open in this session: the poster is the one party who
  // can withdraw the ones the work has moved past, so the response names them.
  const staleOpen = (excludeId?: string) =>
    openRows
      .filter((r) => r._id !== excludeId)
      .map((r) => ({
        id: r._id,
        short_id: r.short_id,
        question: r.question,
        created_at: r.created_at,
        messages_since:
          r.asked_message_count !== undefined ? Math.max(0, conversation.message_count - r.asked_message_count) : undefined,
      }));

  const existing = openRows.find((r) => r.question === args.question);
  const docId = args.doc_md ? await upsertDecisionDoc(ctx, conversation, args.question, args.doc_md, now, existing?.doc_id) : undefined;
  const routed = await routeFor(ctx, conversation, now, task);
  // A hosted conversation asks its owner only, so an address (--to) is ignored.
  const addressed = args.to?.length && !isHostedAgentType(conversation.agent_type)
    ? await resolveAskedPeople(ctx, conversation, args.to)
    : null;
  if (addressed && "error" in addressed) return addressed;
  // An addressed card (--to) is the named people's alone: the ladder does not
  // hear it and nobody else is asked.
  const { role, ladder, people, hears } = addressed
    ? { ...routed, ladder: { ...routed.ladder, activeRoles: [], hops: [] }, people: addressed.people, hears: null }
    : routed;
  if (existing) {
    // The re-ask lands on the open row: text, category and task move with it,
    // a --stack appends it (once), and the holder is recomputed because the
    // category or the stack's delegate may have changed who may answer.
    const joined = stack ? await joinStack(ctx, stack, existing as any, now) : {};
    await ctx.db.patch(existing._id, {
      options: args.options,
      context_md: args.context_md,
      report_slug: args.report_slug,
      card: args.card,
      blocking: args.blocking ?? true,
      default_option: args.default_option,
      kind,
      category,
      category_proposed: args.category,
      form: args.form,
      asked_user_ids: people,
      ...(docId ? { doc_id: docId } : {}),
      ...(task ? { task_id: task._id, station: args.station ?? task.status_id ?? task.status } : {}),
      ...(args.workflow_run_id ? { workflow_run_id: args.workflow_run_id, gate_node_id: args.gate_node_id } : {}),
      ...joined,
      created_at: now,
      asked_message_count: conversation.message_count,
      session_title: conversation.title,
      project_path: conversation.project_path,
    });
    await syncDecisionInbox(ctx, existing._id, people, now, !hears);
    const updated = await ctx.db.get(existing._id);
    if (updated) await refreshHolder(ctx, updated, now);
    return {
      id: existing._id,
      short_id: existing.short_id,
      updated: true,
      category,
      category_pinned: pinned,
      holder: updated?.holder,
      stack: stack ? { id: stack._id, short_id: stack.short_id } : undefined,
      doc_id: docId,
      other_open: staleOpen(existing._id),
    };
  }

  const scopeKeys = scopeKeysFor(role, task, stack?._id);
  const roleIds = ladder.activeRoles.map((r) => r._id);
  if (stack?.policy?.delegate_role_id) roleIds.push(stack.policy.delegate_role_id);
  const { holder, holder_key, grant } = await resolveHolder(ctx, { people, roleIds, category, scopeKeys, now });

  const short_id = await nextShortId(ctx.db as any, "sd");
  const id: Id<"session_decisions"> = await ctx.db.insert("session_decisions", {
    conversation_id: conversation._id,
    session_id: args.session_id,
    user_id: conversation.user_id,
    short_id,
    question: args.question,
    context_md: args.context_md,
    kind,
    category,
    category_proposed: args.category,
    doc_id: docId,
    options: args.options,
    form: args.form,
    report_slug: args.report_slug,
    card: args.card,
    blocking: args.blocking ?? true,
    silent: args.silent || undefined,
    default_option: args.default_option,
    status: "pending",
    task_id: task?._id,
    station: task ? args.station ?? task.status_id ?? task.status : args.station,
    stack_id: stack?._id,
    stack_joined_at: stack ? now : undefined,
    workflow_run_id: args.workflow_run_id,
    gate_node_id: args.gate_node_id,
    holder,
    holder_key,
    asked_user_ids: people,
    hops: ladder.hops,
    scope_keys: scopeKeys,
    created_at: now,
    asked_message_count: conversation.message_count,
    session_title: conversation.title,
    project_path: conversation.project_path,
  });
  // The role hears first; when it cannot, the decision is the people's.
  const woken = await tellHearingRole(ctx, hears, { _id: id, short_id, question: args.question, conversation_id: conversation._id }, now);
  await syncDecisionInbox(ctx, id, people, now, woken.length === 0);
  if (stack) await joinStack(ctx, stack, { _id: id, stack_id: stack._id, scope_keys: scopeKeys }, now);

  return {
    id,
    short_id,
    updated: false,
    category,
    category_pinned: pinned,
    holder,
    grant_id: grant?._id,
    people: people.length,
    ladder: ladder.hops.map((h) => ({ role_id: h.role_id, skipped: h.note, woken: woken.includes(h.role_id) })),
    task: task ? { id: task._id, short_id: task.short_id, station: args.station ?? task.status_id ?? task.status } : undefined,
    stack: stack ? { id: stack._id, short_id: stack.short_id } : undefined,
    doc_id: docId,
    other_open: staleOpen(),
  };
}

export const ask = mutation({
  args: {
    api_token: v.string(),
    session_id: v.string(),
    question: v.string(),
    options: v.array(optionValidator),
    context_md: v.optional(v.string()),
    report_slug: v.optional(v.string()),
    card: v.optional(v.any()),
    blocking: v.optional(v.boolean()),
    default_option: v.optional(v.number()),
    kind: v.optional(kindValidator),
    category: v.optional(v.string()),
    doc_md: v.optional(v.string()),
    form: v.optional(formValidator),
    task: v.optional(v.string()),
    station: v.optional(v.string()),
    stack: v.optional(v.string()),
    // the-line.md L4: the runner's failure gates bind their decision to the run.
    workflow_run_id: v.optional(v.id("workflow_runs")),
    gate_node_id: v.optional(v.string()),
    to: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) return { error: "Unauthorized" };
    const { api_token: _t, ...rest } = args;
    return askCore(ctx, auth, rest as AskArgs);
  },
});

// The row an agent may act on: it must exist and belong to the token's user.
// A decision id is the handle `cast decide` printed; the session id is only a
// sanity check (an agent must not edit another session's question by id).
async function ownedDecision(
  ctx: any,
  auth: { userId: any },
  decisionRef: string,
  sessionId?: string
): Promise<{ row: DecisionRow } | { error: string }> {
  const row = await findDecision(ctx, decisionRef);
  if (!row) return { error: "Decision not found" };
  if (row.user_id.toString() !== auth.userId.toString()) return { error: "Unauthorized: not your decision" };
  if (sessionId && row.session_id !== sessionId) return { error: "Decision belongs to another session" };
  return { row };
}

// Every non-pending row explains itself the same way to the CLI: the agent
// learns what happened to the question instead of a bare refusal.
function resolvedSummary(row: any): { status: string; answer_index?: number; answer_text?: string; answer_label?: string } {
  return {
    status: row.status,
    answer_index: row.answer_index,
    answer_text: row.answer_text,
    answer_label:
      row.answer_index !== undefined
        ? answerLabel(row, { status: "answered", answer_index: row.answer_index, answer_json: row.answer_json })
        : undefined,
  };
}

// `cast decide edit`: the facts changed, so the open question changes with
// them — in place, keeping its age and its place in the queue — instead of a
// second row that "supersedes" the first. Every field is optional; a field
// that is passed replaces the stored one (options as a whole list).
export const edit = mutation({
  args: {
    api_token: v.string(),
    decision_id: v.string(),
    session_id: v.optional(v.string()),
    question: v.optional(v.string()),
    options: v.optional(v.array(optionValidator)),
    context_md: v.optional(v.string()),
    report_slug: v.optional(v.string()),
    card: v.optional(v.any()),
    blocking: v.optional(v.boolean()),
    default_option: v.optional(v.number()),
    // true clears the default (an advisory ask becoming a blocking one).
    clear_default: v.optional(v.boolean()),
    // Every ask field (the-line.md L10): kind and form reshape the answer,
    // doc_md rewrites the decision document, task and station rebind the
    // hold (L5), stack appends, category is a new proposal re-assigned here.
    kind: v.optional(kindValidator),
    form: v.optional(formValidator),
    doc_md: v.optional(v.string()),
    task: v.optional(v.string()),
    station: v.optional(v.string()),
    stack: v.optional(v.string()),
    category: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) return { error: "Unauthorized" };
    const found = await ownedDecision(ctx, auth, args.decision_id, args.session_id);
    if ("error" in found) return found;
    const { row } = found;
    if (row.status !== "pending") {
      return { error: `Decision is already ${row.status}`, ...resolvedSummary(row) };
    }
    const now = Date.now();

    const question = args.question ?? row.question;
    const options = args.options ?? row.options;
    const blocking = args.blocking ?? row.blocking;
    const kind = (args.kind ?? row.kind ?? "single") as DecisionKind;
    const form = args.form ?? row.form;
    let defaultOption = args.clear_default ? undefined : args.default_option ?? row.default_option;
    const shapeError = validateShape(kind, { question, options, default_option: defaultOption, form, card: args.card }) ?? (await missingOptionPage(ctx, options));
    if (shapeError) return { error: shapeError };
    // A blocking ask has no default; an advisory one needs one.
    if (blocking) defaultOption = undefined;
    else if (defaultOption === undefined) return { error: "An advisory decision needs a default option" };

    const bound = await resolveDecisionBindings(ctx, auth.userId, args, { write: true });
    if ("error" in bound) return bound;
    const { task, stack } = bound;
    const conversation = args.doc_md ? await ctx.db.get(row.conversation_id) : null;
    const docId = args.doc_md && conversation ? await upsertDecisionDoc(ctx, conversation, question, args.doc_md, now, row.doc_id) : undefined;

    // Options that changed may pin a protected category the old text did not;
    // a new proposal is re-assigned the same way the ask assigned it.
    const proposed = args.category ?? row.category_proposed;
    const { category } = assignCategory({ question, options, context_md: args.context_md ?? row.context_md }, proposed);
    const joined = stack ? await joinStack(ctx, stack, row as any, now) : {};
    const joinsStack = "stack_id" in joined;
    await ctx.db.patch(row._id, {
      question,
      options,
      context_md: args.context_md ?? row.context_md,
      report_slug: args.report_slug ?? row.report_slug,
      card: args.card ?? row.card,
      blocking,
      default_option: defaultOption,
      kind,
      form,
      category,
      category_proposed: proposed,
      ...(docId ? { doc_id: docId } : {}),
      ...(task ? { task_id: task._id, station: args.station ?? task.status_id ?? task.status } : args.station ? { station: args.station } : {}),
      ...joined,
      updated_at: now,
    });
    // The holder follows the category and the stack's delegate.
    if (category !== row.category || joinsStack) {
      const updated = await ctx.db.get(row._id);
      if (updated) await refreshHolder(ctx, updated, now);
    }
    return {
      id: row._id,
      short_id: row.short_id,
      status: "pending",
      category,
      task: task ? { id: task._id, short_id: task.short_id, station: args.station ?? task.status_id ?? task.status } : undefined,
      stack: stack ? { id: stack._id, short_id: stack.short_id } : undefined,
      doc_id: docId,
    };
  },
});

// `cast decide cancel`: the agent takes its question back. Distinct from the
// human's dismiss so the transcript can say who closed it and why.
export const withdraw = mutation({
  args: {
    api_token: v.string(),
    decision_id: v.string(),
    session_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) return { error: "Unauthorized" };
    const found = await ownedDecision(ctx, auth, args.decision_id, args.session_id);
    if ("error" in found) return found;
    const { row } = found;
    if (row.status !== "pending") {
      return { error: `Decision is already ${row.status}`, ...resolvedSummary(row) };
    }
    return withdrawCore(ctx, row, Date.now(), row.conversation_id);
  },
});

// The one withdraw for every path (`cast decide cancel`, workflow_runs.cancel
// taking back its open gate). A gate decision (the-line.md L4) fails its run
// with "gate withdrawn" unless the run is already past it.
export async function withdrawCore(ctx: Ctx, row: DecisionRow, now: number, via?: Id<"conversations">) {
  await ctx.db.patch(row._id, { status: "withdrawn", resolved_at: now });
  if (row.workflow_run_id) {
    const run = await ctx.db.get(row.workflow_run_id);
    if (run && run.status === "paused" && String(run.gate_decision_id ?? "") === String(row._id)) {
      await ctx.db.patch(run._id, { status: "failed", fail_reason: "gate withdrawn", updated_at: now });
    }
  }
  // The same settle every resolution takes (the-line.md L4): inbox rows
  // close, the stack closes when this was its last member, and the ladder
  // roles receive the withdrawal as a passive fact. The run is failed above,
  // so the gate settle finds it past the pause and leaves "gate withdrawn".
  // `via`: the session withdrawing, so a task it parked on this is not woken by its own act.
  await settleResolution(ctx, row, { status: "withdrawn" }, { kind: "user", id: String(row.user_id), user_id: row.user_id, ...(via ? { via } : {}) }, now);
  return { id: row._id, short_id: row.short_id, status: "withdrawn" };
}

// The CLI's row shape for `cast decide ls` and the ladder listings.
function cliRowShape(r: DecisionRow, conversation?: any) {
  return {
    id: r._id,
    short_id: r.short_id,
    question: r.question,
    kind: r.kind ?? "single",
    category: r.category,
    // An option page (the-line.md L6) prints as a url; the slug stays for edits.
    options: r.options.map((o) => (o.page_slug ? { ...o, page_url: artifactUrl(o.page_slug) } : o)),
    form: r.form,
    blocking: r.blocking,
    default_option: r.default_option,
    task_id: r.task_id,
    station: r.station,
    stack_id: r.stack_id,
    holder: r.holder,
    hops: r.hops,
    answered_by: r.answered_by,
    answer_json: r.answer_json,
    created_at: r.created_at,
    updated_at: r.updated_at,
    resolved_at: r.resolved_at,
    // How far the session has run past an open ask — the staleness signal
    // the CLI prints so the poster can cancel questions the work outgrew.
    messages_since:
      conversation && r.status === "pending" && r.asked_message_count !== undefined
        ? Math.max(0, conversation.message_count - r.asked_message_count)
        : undefined,
    ...resolvedSummary(r),
  };
}

// `cast decide ls`: what this session has asked, newest first, so an agent can
// find the id to edit or cancel and read how an earlier ask was answered.
// With `stack` or `task`, the members of that stack or the decisions on that
// task instead (any status). Those two and `mine` need no session: `cast task
// show` reads the decisions on a task from a plain shell (the-line.md L10),
// and the session only feeds messages_since for the asks it made itself.
export async function listForSessionCore(
  ctx: Ctx,
  auth: { userId: Id<"users"> },
  args: { session_id?: string; stack?: string; task?: string; mine?: boolean },
): Promise<any> {
  let conversation: any = undefined;
  if (args.session_id) {
    conversation = await ctx.db
      .query("conversations")
      .withIndex("by_session_id", (q: any) => q.eq("session_id", args.session_id))
      .first();
    if (!conversation) return { error: "Session not found" };
    if (conversation.user_id.toString() !== auth.userId.toString()) {
      return { error: "Unauthorized: not your session" };
    }
  } else if (!args.stack && !args.task && !args.mine) {
    return { error: "Missing session_id" };
  }
  const own = (r: DecisionRow) => (conversation && r.conversation_id === conversation._id ? conversation : undefined);
  let rows: DecisionRow[] = [];
  if (args.mine) {
    // `cast decide ls --mine` (the-line.md L10): every pending decision the
    // caller holds, from the same read the web queue uses, oldest first so
    // the list reads as the queue does.
    rows = (await listForUserCore(ctx, auth.userId, Date.now())).filter((r) => r.status === "pending");
    rows.sort((a, b) => a.created_at - b.created_at);
    return { decisions: rows.map((r) => cliRowShape(r, own(r))) };
  }
  if (args.stack) {
    const bound = await resolveDecisionBindings(ctx, auth.userId, { stack: args.stack });
    if ("error" in bound) return bound;
    const stack = bound.stack!;
    rows = (await Promise.all(stack.decision_ids.map((id) => ctx.db.get(id)))).filter(Boolean) as DecisionRow[];
    return { decisions: rows.map((r) => cliRowShape(r, own(r))) };
  }
  if (args.task) {
    const bound = await resolveDecisionBindings(ctx, auth.userId, { task: args.task });
    if ("error" in bound) return bound;
    const task = bound.task;
    for (const status of ["pending", "answered", "dismissed", "withdrawn"] as const) {
      rows.push(
        ...(await ctx.db
          .query("session_decisions")
          .withIndex("by_task", (q: any) => q.eq("task_id", task._id).eq("status", status))
          .collect())
      );
    }
  } else {
    for (const status of ["pending", "answered", "dismissed", "withdrawn"] as const) {
      rows.push(
        ...(await ctx.db
          .query("session_decisions")
          .withIndex("by_conversation_status", (q: any) => q.eq("conversation_id", conversation._id).eq("status", status))
          .collect())
      );
    }
  }
  rows.sort((a, b) => b.created_at - a.created_at);
  return { decisions: rows.map((r) => cliRowShape(r, own(r))) };
}

export const listForSession = mutation({
  args: {
    api_token: v.string(),
    session_id: v.optional(v.string()),
    stack: v.optional(v.string()),
    task: v.optional(v.string()),
    mine: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) return { error: "Unauthorized" };
    return listForSessionCore(ctx, auth, args);
  },
});

// ── The race: recommend, answer ───────────────────────────────────────────────

// The role the calling session speaks as, and its hop on this decision's
// ladder. A session with no role, or a role not on the ladder, may not act
// as a role here.
async function callerHop(
  ctx: Ctx,
  auth: { userId: Id<"users"> },
  row: DecisionRow,
  sessionId: string | undefined,
): Promise<{ role: Doc<"org_roles">; hopIndex: number } | { error: string }> {
  if (!sessionId) return { error: "A role acts from its session: pass --session or run inside one" };
  const conversation = await ctx.db
    .query("conversations")
    .withIndex("by_session_id", (q: any) => q.eq("session_id", sessionId))
    .first();
  if (!conversation) return { error: "Session not found" };
  if (conversation.user_id.toString() !== auth.userId.toString()) return { error: "Unauthorized: not your session" };
  const role = await roleOfConversation(ctx, conversation);
  if (!role) return { error: "This session speaks for no role; only a role on the ladder may recommend" };
  const hopIndex = (row.hops ?? []).findIndex((h) => h.role_id === role._id);
  if (hopIndex === -1) return { error: `${role.name} is not on this decision's ladder` };
  return { role, hopIndex };
}

export async function recommendCore(
  ctx: Ctx,
  auth: { userId: Id<"users"> },
  args: { decision_id: string; session_id?: string; recommendation: number; note?: string },
): Promise<any> {
  const row = await findDecision(ctx, args.decision_id);
  if (!row) return { error: "Decision not found" };
  if (row.status !== "pending") return { error: `Decision is already ${row.status}`, ...resolvedSummary(row) };
  if (!Number.isInteger(args.recommendation) || args.recommendation < 0 || args.recommendation >= row.options.length) {
    return { error: "recommendation out of range" };
  }
  const found = await callerHop(ctx, auth, row, args.session_id);
  if ("error" in found) return found;
  const now = Date.now();
  const hops = [...(row.hops ?? [])];
  hops[found.hopIndex] = { role_id: found.role._id, recommendation: args.recommendation, note: args.note, at: now };
  await ctx.db.patch(row._id, { hops, updated_at: now });
  return {
    id: row._id,
    short_id: row.short_id,
    role: { id: found.role._id, name: found.role.name },
    recommendation: args.recommendation,
    late: now - row.created_at > HOP_DEADLINE_MS,
  };
}

export const recommend = mutation({
  args: {
    api_token: v.string(),
    decision_id: v.string(),
    session_id: v.optional(v.string()),
    recommendation: v.number(),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) return { error: "Unauthorized" };
    return recommendCore(ctx, auth, args);
  },
});

// Who the caller is on this decision. Two identities may answer, and a
// calling session decides which: WITH a session, the caller is that session
// and may answer only as the holder role under a live grant when its switch
// is on; a session never answers as a person, whatever token it
// holds, because an agent holds its host's token and the asking session
// would otherwise answer its own question. WITHOUT a session (a signed in
// web user, or `cast decide answer` from a plain human shell), the caller is
// the person, who must be in asked_user_ids.
//
// The one exception is the person's own word: `--for-human` (for_human) from
// a session answers AS the session's human, because they told their agent to
// in that conversation. It is recorded as their answer with the session as
// its route (answered_by.via). An agent account speaks for nobody, and a
// session never answers a question it asked.
export const SESSION_CANNOT_ANSWER_AS_PERSON =
  "A session cannot answer as a person on its own judgment. If your human explicitly told you in this conversation to answer this decision (or agreed to this choice), pass --for-human. Otherwise they answer it from the web or a plain shell; only the holder role under a grant answers on its own.";

async function answererFor(
  ctx: Ctx,
  auth: { userId: Id<"users"> },
  row: DecisionRow,
  sessionId: string | undefined,
  now: number,
  forHuman = false,
): Promise<AnsweredBy | { error: string }> {
  if (sessionId) {
    const conversation = await ctx.db
      .query("conversations")
      .withIndex("by_session_id", (q: any) => q.eq("session_id", sessionId))
      .first();
    if (!conversation) return { error: "Session not found" };
    if (conversation.user_id.toString() !== auth.userId.toString()) return { error: "Unauthorized: not your session" };
    if (forHuman) {
      const person = await ctx.db.get(auth.userId);
      if (!person || person.is_bot) return { error: "This session runs on an agent account, which answers for no person. A person answers it from the web." };
      if (String(row.conversation_id) === String(conversation._id)) return { error: "A session cannot answer its own question; your human answers it." };
      if (!(await userMayRead(ctx, auth.userId, row))) return { error: "Unauthorized: not your human's decision" };
      return { kind: "user", id: String(auth.userId), user_id: auth.userId, via: conversation._id };
    }
    const role = await roleOfConversation(ctx, conversation);
    if (!role) return { error: SESSION_CANNOT_ANSWER_AS_PERSON };
    if (row.holder?.kind !== "role" || String(role._id) !== row.holder.id) {
      return { error: `${role.name} does not hold this decision; recommend instead (cast decide recommend), or a person answers it` };
    }
    // The switch (org-staffing.md S23.1): a role that does not start work on
    // its own reads and recommends; it may not answer, grant or no grant, and
    // it never asks a person to change its own settings.
    if (!roleStartsOnItsOwn(role)) {
      return { error: `${role.name} does not start work on its own, so it recommends rather than answers: cast decide recommend` };
    }
    const grant = await activeGrantFor(ctx, [role._id], row.category ?? "unknown", (row as any).scope_keys ?? [], now);
    if (!grant) return { error: `${role.name} no longer holds a grant for this decision; a person answers it` };
    return { kind: "role", id: String(role._id), grant_id: grant._id };
  }
  if (await userMayRead(ctx, auth.userId, row)) return { kind: "user", id: String(auth.userId), user_id: auth.userId };
  return { error: "Unauthorized: not your decision" };
}

export async function answerCore(
  ctx: Ctx,
  auth: { userId: Id<"users"> },
  args: { decision_id: string; session_id?: string; for_human?: boolean; answer_index?: number; answer_json?: any; answer_text?: string },
): Promise<any> {
  const row = await findDecision(ctx, args.decision_id);
  if (!row) return { error: "Decision not found" };
  if (row.status !== "pending") return { error: `Decision is already ${row.status}`, ...resolvedSummary(row) };
  const now = Date.now();
  const by = await answererFor(ctx, auth, row, args.session_id, now, !!args.for_human);
  if ("error" in by) return by;
  const refusal = await hostedAnswerRefusal(ctx, row, by);
  if (refusal) return { error: refusal };
  const verdict = normalizeVerdict(row, { status: "answered", answer_index: args.answer_index, answer_json: args.answer_json, answer_text: args.answer_text });
  if ("error" in verdict) return verdict;
  const result = await finalizeAnswer(ctx, row, verdict, by, { deliver: true, now });
  return { id: row._id, short_id: row.short_id, ...result, answered_by: { kind: by.kind, id: by.id, ...(by.via ? { via: by.via } : {}) } };
}

export const answer = mutation({
  args: {
    api_token: v.string(),
    decision_id: v.string(),
    session_id: v.optional(v.string()),
    for_human: v.optional(v.boolean()),
    answer_index: v.optional(v.number()),
    answer_json: v.optional(v.any()),
    answer_text: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) return { error: "Unauthorized" };
    return answerCore(ctx, auth, args);
  },
});

// `cast decide show`: one decision with its document, for a role reading its
// ladder or an agent re-reading its own ask.
export const showForCli = mutation({
  args: { api_token: v.string(), decision_id: v.string() },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) return { error: "Unauthorized" };
    const row = await findDecision(ctx, args.decision_id);
    if (!row) return { error: "Decision not found" };
    if (!(await userMayRead(ctx, auth.userId, row))) return { error: "Unauthorized: not your decision" };
    return { decision: cliRowShape(row), ...(await decisionContext(ctx, row, auth.userId)) };
  },
});

// ── Web: resolve, reopen, grants ──────────────────────────────────────────────

// The web's resolve: a person in asked_user_ids (or the legacy owner) answers
// or dismisses. Delivery stays on the client (store answerDecision).
export const resolve = mutation({
  args: {
    decision_id: v.id("session_decisions"),
    status: v.union(v.literal("answered"), v.literal("dismissed")),
    answer_index: v.optional(v.number()),
    answer_text: v.optional(v.string()),
    answer_json: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const row = await ctx.db.get(args.decision_id);
    if (!row) throw new Error("Decision not found");
    if (!(await userMayRead(ctx, userId, row))) throw new Error("Unauthorized: not your decision");
    // Answering an already-resolved row is a no-op, not an error — two devices
    // can race and the first resolution wins.
    if (row.status !== "pending") return { already_resolved: true };
    const verdict = normalizeVerdict(row, args);
    if ("error" in verdict) throw new Error(verdict.error);
    return finalizeAnswer(ctx, row, verdict, { kind: "user", id: String(userId), user_id: userId }, { deliver: false });
  },
});

// A person reopens an answer a role gave under a grant ("disagree" on the
// Handled without you list). The row goes back to pending, held by the
// people; the person's own answer is then scored against the role's.
export async function reopenCore(ctx: Ctx, userId: Id<"users">, decisionId: Id<"session_decisions">) {
    const row: DecisionRow | null = await ctx.db.get(decisionId);
    if (!row) throw new Error("Decision not found");
    const people = (row.asked_user_ids ?? [row.user_id]).map(String);
    if (!people.includes(String(userId))) throw new Error("Unauthorized: not your decision");
    if (row.status !== "answered" || row.answered_by?.kind !== "role" || !row.grant_id) {
      return { reopened: false, reason: "only an answer a role gave under a grant can be reopened" };
    }
    const now = Date.now();
    await ctx.db.patch(row._id, {
      status: "pending",
      answer_index: undefined,
      answer_text: undefined,
      answer_json: undefined,
      resolved_at: undefined,
      resolved_by: undefined,
      answered_by: undefined,
      grant_id: undefined,
      reopened_from: { grant_id: row.grant_id, answer_index: row.answer_index, at: now },
      holder: { kind: "user", id: String(userId) },
      holder_key: `user:${userId}`,
      updated_at: now,
    });
    await setInboxStatus(ctx, row._id, "pending");
    await reopenTaskWaits(ctx as any, row);
    const stack = row.stack_id ? await ctx.db.get(row.stack_id) : null;
    if (stack && stack.status === "done") await ctx.db.patch(stack._id, { status: "open", updated_at: now });
    return { reopened: true };
}

export const reopen = mutation({
  args: { decision_id: v.id("session_decisions") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    return reopenCore(ctx, userId, args.decision_id);
  },
});

// Agreement history (D2): answered decisions of this category in this scope
// where the role recommended and the person picked that option. The grant
// rule needs `agreements` of them from `askers` distinct sessions.
// One range read per category over the 90 day window (by_category_status_
// created), folded into a map keyed "role|scope" so a card with several hops
// and scope keys costs one read instead of one scan per pair.
export type AgreementMap = Map<string, { agreements: number; askers: Set<string> }>;

export async function agreementHistoryForCategory(ctx: Ctx, category: string, now: number): Promise<AgreementMap> {
  const rows: DecisionRow[] = await ctx.db
    .query("session_decisions")
    .withIndex("by_category_status_created", (q: any) =>
      q.eq("category", category).eq("status", "answered").gte("created_at", now - HISTORY_WINDOW_MS),
    )
    .collect();
  const out: AgreementMap = new Map();
  for (const r of rows) {
    if (r.category !== category || r.status !== "answered") continue; // the fake db ignores ranges
    if (r.answered_by?.kind !== "user") continue;
    for (const hop of r.hops ?? []) {
      if (hop.recommendation === undefined || hop.recommendation !== r.answer_index) continue;
      for (const scopeKey of (r as any).scope_keys ?? []) {
        const key = `${hop.role_id}|${scopeKey}`;
        const entry = out.get(key) ?? { agreements: 0, askers: new Set<string>() };
        entry.agreements += 1;
        entry.askers.add(String(r.conversation_id));
        out.set(key, entry);
      }
    }
  }
  return out;
}

export function agreementFor(
  map: AgreementMap,
  roleId: Id<"org_roles">,
  scopeKey: string,
): { agreements: number; askers: number; eligible: boolean } {
  const entry = map.get(`${roleId}|${scopeKey}`);
  const agreements = entry?.agreements ?? 0;
  const askers = entry?.askers.size ?? 0;
  return { agreements, askers, eligible: agreements >= GRANT_RULE.agreements && askers >= GRANT_RULE.askers };
}

export async function agreementHistory(
  ctx: Ctx,
  roleId: Id<"org_roles">,
  category: string,
  scopeKey: string,
  now: number,
): Promise<{ agreements: number; askers: number; eligible: boolean }> {
  return agreementFor(await agreementHistoryForCategory(ctx, category, now), roleId, scopeKey);
}

export async function grantCore(
  ctx: Ctx,
  userId: Id<"users">,
  args: { role_id: Id<"org_roles">; category: string; scope_key: string; from_decision_id?: Id<"session_decisions">; force?: boolean },
): Promise<any> {
  const role = await ctx.db.get(args.role_id);
  if (!role) return { error: "Role not found" };
  if (!(await userCanAdminRole(ctx, userId, role))) return { error: "Only the role's host or a team admin can grant" };
  if (isHumanOnlyCategory(args.category)) return { error: `${args.category} is always held by a person` };
  const now = Date.now();
  const existing = await activeGrantFor(ctx, [args.role_id], args.category, [args.scope_key], now);
  if (existing) return { id: existing._id, already_granted: true, expires_at: existing.expires_at };
  const history = await agreementHistory(ctx, args.role_id, args.category, args.scope_key, now);
  if (!history.eligible && !args.force) {
    return {
      error: `Not earned yet: ${history.agreements}/${GRANT_RULE.agreements} agreements from ${history.askers}/${GRANT_RULE.askers} askers. Pass --force as an admin to grant anyway.`,
      ...history,
    };
  }
  const id = await ctx.db.insert("decision_grants", {
    role_id: args.role_id,
    category: args.category,
    scope_key: args.scope_key,
    granted_by: userId,
    granted_from_decision_id: args.from_decision_id,
    granted_at: now,
    expires_at: now + GRANT_TTL_MS,
    override_streak: 0,
  });
  // Pending rows of this category in the scope move to the role.
  const pending: DecisionRow[] = await ctx.db
    .query("session_decisions")
    .withIndex("by_category_status_created", (q: any) => q.eq("category", args.category).eq("status", "pending"))
    .collect();
  for (const r of pending) {
    if (r.category !== args.category || r.status !== "pending") continue;
    if (!((r as any).scope_keys ?? []).includes(args.scope_key)) continue;
    await refreshHolder(ctx, r, now);
  }
  return { id, already_granted: false, expires_at: now + GRANT_TTL_MS, forced: !history.eligible };
}

// Web only: grants come from the card's "Let this role answer questions like
// this here" or from `cast stack delegate` (decisionStacks.delegateStack).
// No api token path: every agent session holds its host's token, and a
// role's host is by definition its admin, so a token path would let a role
// session grant itself any open category.
export const grant = mutation({
  args: {
    role_id: v.id("org_roles"),
    category: v.string(),
    scope_key: v.string(),
    from_decision_id: v.optional(v.id("session_decisions")),
    force: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return { error: "Unauthorized" };
    return grantCore(ctx, userId, args);
  },
});

// Web only, same reason as grant.
export const revoke = mutation({
  args: { grant_id: v.id("decision_grants"), reason: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return { error: "Unauthorized" };
    const g = await ctx.db.get(args.grant_id);
    if (!g) return { error: "Grant not found" };
    const role = await ctx.db.get(g.role_id);
    if (!role || !(await userCanAdminRole(ctx, userId, role))) return { error: "Only the role's host or a team admin can revoke" };
    if (g.revoked_at) return { id: g._id, already_revoked: true };
    const now = Date.now();
    await ctx.db.patch(g._id, { revoked_at: now, revoked_reason: args.reason ?? "revoked" });
    // Pending rows the role held under this grant go back to their people.
    const held: DecisionRow[] = await ctx.db
      .query("session_decisions")
      .withIndex("by_holder_status", (q: any) => q.eq("holder_key", `role:${g.role_id}`).eq("status", "pending"))
      .collect();
    for (const r of held) if (r.category === g.category) await refreshHolder(ctx, r, now);
    return { id: g._id, already_revoked: false };
  },
});

// ── Reads ─────────────────────────────────────────────────────────────────────

// Who may read a decision: its people, anyone who can read the asking
// conversation, and the HOST (or personal owner) of a role on its ladder,
// reading what their seat was asked. Not the role's whole team: a private
// conversation reporting to a team role must not open its decisions to every
// member; team visible conversations are covered by the conversation clause.
export async function userMayRead(ctx: Ctx, userId: Id<"users">, row: DecisionRow): Promise<boolean> {
  const people = (row.asked_user_ids ?? [row.user_id]).map(String);
  if (people.includes(String(userId))) return true;
  const conversation = await ctx.db.get(row.conversation_id);
  if (conversation && (await canAccessConversation(ctx, userId, conversation))) return true;
  for (const hop of row.hops ?? []) {
    const role = await ctx.db.get(hop.role_id);
    if (role && (await roleGrants(ctx, userId, role, () => false))) return true;
  }
  return false;
}

// A decision row the signed-in viewer may read.
async function readableDecision(ctx: any, decisionId: any): Promise<DecisionRow | null> {
  const userId = await getAuthUserId(ctx);
  if (!userId) return null;
  const row = await ctx.db.get(decisionId);
  if (!row) return null;
  return (await userMayRead(ctx, userId, row)) ? row : null;
}

// The fields the answer bubble renders: the question, the options with the
// chosen one, and the agent's reasoning. Shared by the by-id and by-answer
// lookups so both return the identical shape. The Doc parameter type is what
// keeps the query return types (and so the web bubble) fully typed.
function answerBubbleShape(row: Doc<"session_decisions">) {
  return {
    _id: row._id,
    short_id: row.short_id,
    conversation_id: row.conversation_id,
    question: row.question,
    context_md: row.context_md,
    kind: row.kind,
    category: row.category,
    options: row.options,
    form: row.form,
    report_slug: row.report_slug,
    card: row.card,
    doc_id: row.doc_id,
    blocking: row.blocking,
    default_option: row.default_option,
    status: row.status,
    answer_index: row.answer_index,
    answer_text: row.answer_text,
    answer_json: row.answer_json,
    answered_by: row.answered_by,
    task_id: row.task_id,
    station: row.station,
    stack_id: row.stack_id,
    created_at: row.created_at,
    resolved_at: row.resolved_at,
  };
}

// One decision by `sd-N` or Convex id, for the answer bubble in the
// transcript and for an `sd-N` reference pill: the queue subscription
// (listForUser) keeps resolved rows a day, so an older decision reads its
// options and context here.
export const get = query({
  args: { decision_id: v.string() },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const row = await findDecision(ctx, args.decision_id);
    if (!row || !(await userMayRead(ctx, userId, row))) return null;
    return answerBubbleShape(row);
  },
});

async function roleSummary(ctx: Ctx, roleId: Id<"org_roles">) {
  const role = await ctx.db.get(roleId);
  return role
    ? { _id: role._id, short_id: role.short_id, name: role.name, handle: role.handle, status: role.status, host_user_id: role.host_user_id }
    : null;
}

async function userSummary(ctx: Ctx, userId: Id<"users">) {
  const u = await ctx.db.get(userId);
  return u ? { _id: u._id, name: u.name ?? u.github_username ?? u.email?.split("@")[0] ?? "someone", avatar_url: u.avatar_url ?? u.image } : null;
}

// Everything the document page renders around the row: the doc body, the
// task, the stack, the ladder with role names, the people, the holder role,
// and (on an answered row) whether the card may offer a grant.
async function decisionContext(ctx: Ctx, row: DecisionRow, viewerId: Id<"users">) {
  const doc = row.doc_id ? await ctx.db.get(row.doc_id) : null;
  const task = row.task_id ? await ctx.db.get(row.task_id) : null;
  const stack = row.stack_id ? await ctx.db.get(row.stack_id) : null;
  const ladder = [];
  for (const hop of row.hops ?? []) {
    ladder.push({ ...hop, role: await roleSummary(ctx, hop.role_id) });
  }
  const asked_users = [];
  for (const id of row.asked_user_ids ?? [row.user_id]) {
    const u = await userSummary(ctx, id);
    if (u) asked_users.push(u);
  }
  const holder_role = row.holder?.kind === "role" ? await roleSummary(ctx, row.holder.id as Id<"org_roles">) : null;
  // The grant offer (D2): the person picked what a role recommended, and the
  // role has earned it in this category and scope.
  // may_grant is the server's own rule (userCanAdminRole: the role's host,
  // the personal scope owner, or an admin of the ROLE's team), so the card
  // never guesses from the viewer's active team.
  let grant_offer: { role_id: Id<"org_roles">; role_name: string; category: string; scope_key: string; agreements: number; askers: number; may_grant: boolean } | null = null;
  if (row.status === "answered" && row.answered_by?.kind === "user" && row.category && !isHumanOnlyCategory(row.category)) {
    const scopeKeys: string[] = (row as any).scope_keys ?? [];
    const now = Date.now();
    // One category read for the whole card, whatever the hop and scope count.
    const history = await agreementHistoryForCategory(ctx, row.category, now);
    for (const hop of row.hops ?? []) {
      if (hop.recommendation === undefined || hop.recommendation !== row.answer_index) continue;
      for (const scopeKey of scopeKeys) {
        const h = agreementFor(history, hop.role_id, scopeKey);
        if (h.eligible && !(await activeGrantFor(ctx, [hop.role_id], row.category, [scopeKey], now))) {
          const role = await ctx.db.get(hop.role_id);
          grant_offer = {
            role_id: hop.role_id,
            role_name: role?.name ?? "role",
            category: row.category,
            scope_key: scopeKey,
            ...h,
            may_grant: !!role && (await userCanAdminRole(ctx, viewerId, role)),
          };
          break;
        }
      }
      if (grant_offer) break;
    }
  }
  return {
    doc: doc ? { _id: doc._id, title: doc.title, content: doc.content, updated_at: doc.updated_at } : null,
    task: task ? { _id: task._id, short_id: task.short_id, title: task.title, status: task.status, status_id: task.status_id, project_id: task.project_id } : null,
    stack: stack ? { _id: stack._id, short_id: stack.short_id, title: stack.title, decision_ids: stack.decision_ids, policy: stack.policy, status: stack.status } : null,
    ladder,
    asked_users,
    holder_role,
    grant_offer,
    grant: row.grant_id ? await ctx.db.get(row.grant_id) : null,
  };
}

// The document page (D4): the decision, its doc body, task title, stack,
// ladder and people in one read.
export const getWithDoc = query({
  args: { decision_id: v.string() },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const row = await findDecision(ctx, args.decision_id);
    if (!row || !(await userMayRead(ctx, userId, row))) return null;
    const [live] = await withLiveSession(ctx, [row]);
    return { decision: live, ...(await decisionContext(ctx, row, userId)) };
  },
});

// Resolve a legacy answer bubble to its decision row. Messages sent before
// the wire format carried the id have only the chosen label, so the bubble
// asks by conversation + label (+ its own timestamp as the tiebreak when the
// same label answered several asks). Same access rule as reading by id:
// anyone who can read the conversation.
export const findByAnswer = query({
  args: {
    conversation_id: v.id("conversations"),
    answer: v.string(),
    near: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation || !(await canAccessConversation(ctx, userId, conversation))) return null;
    const rows = await ctx.db
      .query("session_decisions")
      .withIndex("by_conversation_status", (q) => q.eq("conversation_id", args.conversation_id).eq("status", "answered"))
      .collect();
    const row = pickAnsweredDecision(rows, args.answer, args.near);
    return row ? answerBubbleShape(row) : null;
  },
});

// Where in the transcript a decision was asked. The `cast decide` run's tool
// result carries the decision id, so the first message referencing the id —
// in a tool result, a tool call's argv, or plain content — anchors the ask.
// The queue's "asked 2h ago" line uses this to jump when the message is older
// than the client's loaded window.
export const findAskMessage = query({
  args: { decision_id: v.id("session_decisions") },
  handler: async (ctx, args) => {
    const row = await readableDecision(ctx, args.decision_id);
    if (!row) return null;

    const ids = [args.decision_id.toString(), ...(row.short_id ? [row.short_id] : [])];
    const mentions = (text: string | undefined) => !!text && ids.some((id) => text.includes(id));
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_conversation_timestamp", (q) => q.eq("conversation_id", row.conversation_id))
      .order("asc")
      .collect();
    // tool-call id → its message: a hit inside a tool RESULT resolves to the
    // message carrying the call, because the result rides a content-less
    // carrier row that the client renders folded into the call's row.
    const callMessage = new Map<string, (typeof messages)[number]>();
    for (const m of messages) for (const tc of m.tool_calls ?? []) callMessage.set(tc.id, m);
    for (const m of messages) {
      if (mentions(m.content) || m.tool_calls?.some((tc) => mentions(tc.input))) {
        return { message_id: m._id, timestamp: m.timestamp };
      }
      const hit = m.tool_results?.find((r) => mentions(r.content));
      if (hit) {
        const call = callMessage.get(hit.tool_use_id) ?? m;
        return { message_id: call._id, timestamp: call.timestamp };
      }
    }
    return null;
  },
});

// The queue (D2): pending rows from the viewer's decision_inbox, joined to
// their decisions, plus the day's resolved ones. Rows minted before the inbox
// existed have no inbox row and no asked_user_ids: they still list through the
// owner index as before, so nothing already in a queue disappears.
// The asking session, resolved when the row is READ. session_title and
// project_path are stamped at ask time, and a session is usually untitled in
// its first minutes — the stamp taken then is empty forever, which is why an
// old decision read "See the conversation" with nothing to identify it. The
// conversation's current title is the truth, so every read overlays it.
export async function withLiveSession<T extends { conversation_id: Id<"conversations">; session_title?: string; project_path?: string }>(
  ctx: Ctx,
  rows: T[],
): Promise<T[]> {
  const seen = new Map<string, { title?: string; project_path?: string }>();
  const out: T[] = [];
  for (const r of rows) {
    const key = String(r.conversation_id);
    let live = seen.get(key);
    if (!live) {
      const conversation = await ctx.db.get(r.conversation_id);
      live = { title: conversation?.title, project_path: conversation?.project_path };
      seen.set(key, live);
    }
    out.push({
      ...r,
      session_title: live.title ?? r.session_title,
      project_path: live.project_path ?? r.project_path,
    });
  }
  return out;
}

export async function listForUserCore(ctx: Ctx, userId: Id<"users">, now: number): Promise<DecisionRow[]> {
  const cutoff = now - RESOLVED_WINDOW_MS;
  const out = new Map<string, DecisionRow>();

  for (const status of ["pending", "done"] as const) {
    const inbox = await ctx.db
      .query("decision_inbox")
      .withIndex("by_user_status", (q: any) => q.eq("user_id", userId).eq("status", status))
      .collect();
    for (const r of inbox) {
      const d: DecisionRow | null = await ctx.db.get(r.decision_id);
      if (!d) continue;
      // A stale inbox row from before assignment must not keep the card on
      // the previous person's stack: asked_user_ids is the people set.
      if (d.asked_user_ids !== undefined && !d.asked_user_ids.some((id) => String(id) === String(userId))) continue;
      if (d.status === "pending" || (d.resolved_at ?? 0) >= cutoff) out.set(String(d._id), d);
    }
  }

  for (const status of ["pending", "answered", "dismissed", "withdrawn"] as const) {
    const rows: DecisionRow[] = await ctx.db
      .query("session_decisions")
      .withIndex("by_user_status", (q: any) => q.eq("user_id", userId).eq("status", status))
      .collect();
    for (const r of rows) {
      if (r.asked_user_ids !== undefined) continue; // an inbox row carries it
      if (r.status === "pending" || (r.resolved_at ?? 0) >= cutoff) out.set(String(r._id), r);
    }
  }
  return withLiveSession(ctx, Array.from(out.values()));
}

export const listForUser = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    return listForUserCore(ctx, userId, Date.now());
  },
});

// A role's view: pending decisions it holds, and pending decisions on whose
// ladder it sits (a recommendation still wanted). Readable by anyone who can
// access the role.
// The open decisions a role is on the hook for: rows it holds, plus pending
// rows whose ladder names it inside the window a role page shows. Shared by
// the role page list and the brief's open count (org.computeScopeSummary),
// so the two never disagree.
export async function pendingOnLadder(ctx: Ctx, roleId: Id<"org_roles">, now: number): Promise<DecisionRow[]> {
  const out = new Map<string, DecisionRow>();
  const held: DecisionRow[] = await ctx.db
    .query("session_decisions")
    .withIndex("by_holder_status", (q: any) => q.eq("holder_key", `role:${roleId}`).eq("status", "pending"))
    .collect();
  for (const r of held) out.set(String(r._id), r);
  const recent: DecisionRow[] = await ctx.db
    .query("session_decisions")
    .withIndex("by_status_created", (q: any) => q.eq("status", "pending").gte("created_at", now - HANDLED_WINDOW_MS))
    .collect();
  for (const r of recent) {
    if ((r.hops ?? []).some((h) => String(h.role_id) === String(roleId))) out.set(String(r._id), r);
  }
  return Array.from(out.values());
}

export const listForRole = query({
  args: { role_id: v.id("org_roles") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const role = await ctx.db.get(args.role_id);
    if (!role || !(await userCanAccessRole(ctx, userId, role))) return [];
    const rows = await pendingOnLadder(ctx, args.role_id, Date.now());
    // Any member may open the role page, but each row still answers to the
    // asking conversation's visibility (userMayRead), so a private session's
    // decisions do not show to the whole team through the role.
    const visible: DecisionRow[] = [];
    for (const r of rows) if (await userMayRead(ctx, userId, r)) visible.push(r);
    return visible.map((r) => ({ ...r, held_by_role: r.holder_key === `role:${args.role_id}` }));
  },
});

// "Handled without you": decisions among the viewer's people set that a role
// answered under a grant in the last 14 days, with the grant so the card can
// offer disagree and reopen.
export const listHandledByRoles = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const cutoff = Date.now() - HANDLED_WINDOW_MS;
    const inbox = await ctx.db
      .query("decision_inbox")
      .withIndex("by_user_status", (q) => q.eq("user_id", userId).eq("status", "done"))
      .collect();
    const out = [];
    for (const r of inbox) {
      const d = await ctx.db.get(r.decision_id);
      if (!d || d.status !== "answered" || d.answered_by?.kind !== "role" || (d.resolved_at ?? 0) < cutoff) continue;
      out.push({
        ...d,
        role: await roleSummary(ctx, d.answered_by.id as Id<"org_roles">),
        grant: d.grant_id ? await ctx.db.get(d.grant_id) : null,
      });
    }
    out.sort((a, b) => (b.resolved_at ?? 0) - (a.resolved_at ?? 0));
    return out;
  },
});
