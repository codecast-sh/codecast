// Decision stacks (docs/architecture/decisions-as-documents.md D5): an ordered
// set of decisions one person clears in one sitting, with a policy.
//
// Access is the anchor rule (lib/orgAccess): team_id / scope_user_id carry the
// boundary and owner_user_id is the host, so a stack is visible to every
// member of its team, or to its owner when personal.
//
// Policies: `auto_default_after_ms` answers ADVISORY members with their
// default when the deadline passes (a cron drives applyAutoDefaults; blocking
// members never auto answer). `delegate_role_id` grants that role every open
// category for the stack's members (scope_key "stack:<id>") and re-resolves
// the pending members' holder.
import { mutation, query, internalMutation } from "./functions";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { verifyApiToken } from "./apiTokens";
import { teamVisibleConvTeam } from "./privacy";
import { nextShortId } from "./counters";
import type { Doc, Id } from "./_generated/dataModel";
import { userCanAccessRole, userCanAdminRole, type ScopedSeat } from "./lib/orgAccess";
import { OPEN_CATEGORIES } from "./lib/decisionCategory";
import { findDecision, findStack, finalizeAnswer, refreshHolder, activeGrantFor, GRANT_TTL_MS } from "./sessionDecisions";

type Ctx = { db: any };
type StackRow = Doc<"decision_stacks">;

function seatOf(stack: StackRow): ScopedSeat {
  return { host_user_id: stack.owner_user_id, scope_user_id: stack.scope_user_id, team_id: stack.team_id };
}

async function authUser(ctx: any, apiToken?: string): Promise<Id<"users"> | null> {
  if (apiToken) return (await verifyApiToken(ctx, apiToken))?.userId ?? null;
  return getAuthUserId(ctx);
}

// The stack the caller may act on. `admin` = reshape (policy, reorder,
// delegate): owner, personal owner, or team admin; else any member may read
// and add.
async function accessibleStack(
  ctx: Ctx,
  userId: Id<"users">,
  ref: string,
  admin = false,
): Promise<{ stack: StackRow } | { error: string }> {
  const stack = await findStack(ctx, ref);
  if (!stack) return { error: `Stack not found: ${ref}` };
  const ok = admin ? await userCanAdminRole(ctx, userId, seatOf(stack)) : await userCanAccessRole(ctx, userId, seatOf(stack));
  if (!ok) return { error: admin ? "Only the stack's owner or a team admin can change it" : `Stack not accessible: ${ref}` };
  return { stack };
}

// A role by handle or short id inside the stack's boundary (for --delegate).
async function findRole(ctx: Ctx, stack: StackRow, ref: string): Promise<Doc<"org_roles"> | null> {
  const handle = ref.replace(/^@/, "");
  if (/^or-\d+$/.test(handle)) {
    return (
      (await ctx.db.query("org_roles").withIndex("by_short_id", (q: any) => q.eq("short_id", handle)).first()) ?? null
    );
  }
  const id = ctx.db.normalizeId("org_roles", handle);
  if (id) return ctx.db.get(id);
  if (stack.team_id) {
    return (
      (await ctx.db
        .query("org_roles")
        .withIndex("by_team_handle", (q: any) => q.eq("team_id", stack.team_id).eq("handle", handle))
        .first()) ?? null
    );
  }
  return (
    (await ctx.db
      .query("org_roles")
      .withIndex("by_scope_user_handle", (q: any) => q.eq("scope_user_id", stack.scope_user_id).eq("handle", handle))
      .first()) ?? null
  );
}

const policyValidator = v.object({
  auto_default_after_ms: v.optional(v.number()),
  delegate_role_id: v.optional(v.id("org_roles")),
});

async function membersOf(ctx: Ctx, stack: StackRow): Promise<Doc<"session_decisions">[]> {
  const rows = await Promise.all(stack.decision_ids.map((id) => ctx.db.get(id)));
  return rows.filter(Boolean) as Doc<"session_decisions">[];
}

// The list row: the stack plus its progress, so the queue groups and the
// checklist header count without loading every member.
async function listRow(ctx: Ctx, stack: StackRow) {
  const members = await membersOf(ctx, stack);
  const resolved = members.filter((m) => m.status !== "pending").length;
  const next = members.find((m) => m.status === "pending");
  return {
    _id: stack._id,
    short_id: stack.short_id,
    title: stack.title,
    team_id: stack.team_id,
    scope_user_id: stack.scope_user_id,
    owner_user_id: stack.owner_user_id,
    role_id: stack.role_id,
    policy: stack.policy,
    status: stack.status,
    decision_ids: stack.decision_ids,
    client_key: stack.client_key,
    total: members.length,
    resolved,
    pending: members.length - resolved,
    next_decision_id: next?._id,
    next_short_id: next?.short_id,
    created_at: stack.created_at,
    updated_at: stack.updated_at,
  };
}

// Delegation (D5): one grant per open category, scope "stack:<id>", then the
// pending members are re-resolved so the role holds them at once.
export async function delegateStack(ctx: Ctx, userId: Id<"users">, stack: StackRow, roleId: Id<"org_roles">, now: number) {
  const role = await ctx.db.get(roleId);
  if (!role) return { error: "Role not found" };
  if (!(await userCanAdminRole(ctx, userId, role))) return { error: "Only the role's host or a team admin can delegate to it" };
  const scopeKey = `stack:${stack._id}`;
  let created = 0;
  for (const category of OPEN_CATEGORIES) {
    if (await activeGrantFor(ctx, [roleId], category, [scopeKey], now)) continue;
    await ctx.db.insert("decision_grants", {
      role_id: roleId,
      category,
      scope_key: scopeKey,
      granted_by: userId,
      granted_at: now,
      expires_at: now + GRANT_TTL_MS,
      override_streak: 0,
    });
    created += 1;
  }
  await ctx.db.patch(stack._id, { policy: { ...stack.policy, delegate_role_id: roleId }, updated_at: now });
  for (const m of await membersOf(ctx, stack)) {
    if (m.status !== "pending") continue;
    const keys = (m as any).scope_keys ?? [];
    if (!keys.includes(scopeKey)) await ctx.db.patch(m._id, { scope_keys: [...keys, scopeKey] });
    await refreshHolder(ctx, { ...m, scope_keys: [...keys, scopeKey] } as any, now);
  }
  return { grants_created: created, role: { id: roleId, name: role.name } };
}

export async function createStackCore(
  ctx: Ctx,
  userId: Id<"users">,
  args: { title: string; session_id?: string; team_id?: Id<"teams">; policy?: { auto_default_after_ms?: number; delegate_role_id?: Id<"org_roles"> }; delegate?: string; client_key?: string },
) {
  if (!args.title.trim()) return { error: "A stack needs a title" };
  const now = Date.now();
  // Boundary: the session's team when it is team visible, an explicit team,
  // else personal.
  let teamId = args.team_id;
  if (!teamId && args.session_id) {
    const conversation = await ctx.db
      .query("conversations")
      .withIndex("by_session_id", (q: any) => q.eq("session_id", args.session_id))
      .first();
    if (conversation) teamId = teamVisibleConvTeam(conversation) ?? undefined;
  }
  if (teamId) {
    const m = await ctx.db
      .query("team_memberships")
      .withIndex("by_user_team", (q: any) => q.eq("user_id", userId).eq("team_id", teamId))
      .first();
    if (!m) return { error: "Not a member of that team" };
  }
  const short_id = await nextShortId(ctx.db as any, "ds");
  const id: Id<"decision_stacks"> = await ctx.db.insert("decision_stacks", {
    short_id,
    title: args.title.trim(),
    team_id: teamId,
    scope_user_id: teamId ? undefined : userId,
    owner_user_id: userId,
    decision_ids: [],
    policy: { auto_default_after_ms: args.policy?.auto_default_after_ms },
    ...(args.client_key ? { client_key: args.client_key } : {}),
    status: "open",
    created_at: now,
    updated_at: now,
  });
  const stack = await ctx.db.get(id);
  let delegated: any = undefined;
  const delegateRef = args.delegate ?? (args.policy?.delegate_role_id ? String(args.policy.delegate_role_id) : undefined);
  if (delegateRef) {
    const role = await findRole(ctx, stack, delegateRef);
    if (!role) return { error: `Role not found: ${delegateRef}`, id, short_id };
    delegated = await delegateStack(ctx, userId, stack, role._id, now);
    if (delegated?.error) return { ...delegated, id, short_id };
  }
  return { id, short_id, delegated };
}

export const createStack = mutation({
  args: {
    api_token: v.optional(v.string()),
    title: v.string(),
    session_id: v.optional(v.string()),
    team_id: v.optional(v.id("teams")),
    policy: v.optional(policyValidator),
    delegate: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await authUser(ctx, args.api_token);
    if (!userId) return { error: "Unauthorized" };
    const { api_token: _t, ...rest } = args;
    return createStackCore(ctx, userId, rest);
  },
});

export async function addToStackCore(ctx: Ctx, userId: Id<"users">, stackRef: string, decisionRef: string) {
  const found = await accessibleStack(ctx, userId, stackRef);
  if ("error" in found) return found;
  const { stack } = found;
  if (stack.status === "done") return { error: `Stack ${stack.short_id} is done` };
  const row = await findDecision(ctx, decisionRef);
  if (!row) return { error: `Decision not found: ${decisionRef}` };
  const people = (row.asked_user_ids ?? [row.user_id]).map(String);
  if (!people.includes(String(userId)) && row.user_id.toString() !== userId.toString()) {
    return { error: "Only a person the decision was asked of can add it to a stack" };
  }
  if (row.stack_id && row.stack_id !== stack._id) {
    const old = await ctx.db.get(row.stack_id);
    if (old) await ctx.db.patch(old._id, { decision_ids: old.decision_ids.filter((id: any) => id !== row._id), updated_at: Date.now() });
  }
  const now = Date.now();
  if (!stack.decision_ids.includes(row._id)) {
    await ctx.db.patch(stack._id, { decision_ids: [...stack.decision_ids, row._id], updated_at: now });
  }
  const scopeKey = `stack:${stack._id}`;
  const keys: string[] = (row as any).scope_keys ?? [];
  const scope_keys = keys.includes(scopeKey) ? keys : [...keys, scopeKey];
  await ctx.db.patch(row._id, { stack_id: stack._id, stack_joined_at: now, scope_keys, updated_at: now });
  if (row.status === "pending") await refreshHolder(ctx, { ...row, stack_id: stack._id, scope_keys } as any, now);
  return { stack: { id: stack._id, short_id: stack.short_id }, decision: { id: row._id, short_id: row.short_id } };
}

// The queue's "group into a stack" (D5): create and add the members in one
// call, so the web's optimistic stub reconciles to one server row and one
// round trip instead of N + 1.
export async function createStackWithCore(ctx: Ctx, userId: Id<"users">, args: { title: string; decision_ids: string[]; team_id?: Id<"teams">; client_key?: string }) {
  const created = await createStackCore(ctx, userId, { title: args.title, team_id: args.team_id, client_key: args.client_key });
  if ("error" in created && created.error) return created;
  const added: string[] = [];
  for (const ref of args.decision_ids) {
    const r = await addToStackCore(ctx, userId, String(created.id), ref);
    if ("error" in r) return { ...created, error: r.error, added };
    added.push(ref);
  }
  return { ...created, added };
}

export const createStackWith = mutation({
  args: { title: v.string(), decision_ids: v.array(v.string()), team_id: v.optional(v.id("teams")), client_key: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return { error: "Unauthorized" };
    return createStackWithCore(ctx, userId, args);
  },
});

export const addToStack = mutation({
  args: { api_token: v.optional(v.string()), stack: v.string(), decision: v.string() },
  handler: async (ctx, args) => {
    const userId = await authUser(ctx, args.api_token);
    if (!userId) return { error: "Unauthorized" };
    return addToStackCore(ctx, userId, args.stack, args.decision);
  },
});

export async function removeFromStackCore(ctx: Ctx, userId: Id<"users">, stackRef: string, decisionRef: string) {
  const found = await accessibleStack(ctx, userId, stackRef, true);
  if ("error" in found) return found;
  const row = await findDecision(ctx, decisionRef);
  if (!row) return { error: `Decision not found: ${decisionRef}` };
  // The admin check covers this stack only; the decision must be its member,
  // or an admin of one stack could detach another team's decision.
  if (row.stack_id !== found.stack._id) return { error: `${row.short_id ?? row._id} is not in ${found.stack.short_id}` };
  const now = Date.now();
  await ctx.db.patch(found.stack._id, { decision_ids: found.stack.decision_ids.filter((id) => id !== row._id), updated_at: now });
  const scope_keys = ((row as any).scope_keys ?? []).filter((k: string) => k !== `stack:${found.stack._id}`);
  await ctx.db.patch(row._id, { stack_id: undefined, stack_joined_at: undefined, scope_keys, updated_at: now });
  if (row.status === "pending") await refreshHolder(ctx, { ...row, stack_id: undefined, scope_keys } as any, now);
  return { removed: true };
}

export const removeFromStack = mutation({
  args: { api_token: v.optional(v.string()), stack: v.string(), decision: v.string() },
  handler: async (ctx, args) => {
    const userId = await authUser(ctx, args.api_token);
    if (!userId) return { error: "Unauthorized" };
    return removeFromStackCore(ctx, userId, args.stack, args.decision);
  },
});

// The new order must be a permutation of the current members.
export async function reorderStackCore(ctx: Ctx, userId: Id<"users">, stackRef: string, decisionIds: Id<"session_decisions">[]) {
  const found = await accessibleStack(ctx, userId, stackRef, true);
  if ("error" in found) return found;
  const before = [...found.stack.decision_ids].map(String).sort();
  const after = [...decisionIds].map(String).sort();
  if (before.length !== after.length || before.some((id, i) => id !== after[i])) {
    return { error: "decision_ids must be a permutation of the stack's members" };
  }
  await ctx.db.patch(found.stack._id, { decision_ids: decisionIds, updated_at: Date.now() });
  return { reordered: true };
}

export const reorderStack = mutation({
  args: { api_token: v.optional(v.string()), stack: v.string(), decision_ids: v.array(v.id("session_decisions")) },
  handler: async (ctx, args) => {
    const userId = await authUser(ctx, args.api_token);
    if (!userId) return { error: "Unauthorized" };
    return reorderStackCore(ctx, userId, args.stack, args.decision_ids);
  },
});

export const setStackPolicy = mutation({
  args: {
    api_token: v.optional(v.string()),
    stack: v.string(),
    auto_default_after_ms: v.optional(v.number()),
    clear_auto_default: v.optional(v.boolean()),
    delegate: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await authUser(ctx, args.api_token);
    if (!userId) return { error: "Unauthorized" };
    const found = await accessibleStack(ctx, userId, args.stack, true);
    if ("error" in found) return found;
    const { stack } = found;
    const now = Date.now();
    const policy = { ...stack.policy };
    if (args.clear_auto_default) policy.auto_default_after_ms = undefined;
    else if (args.auto_default_after_ms !== undefined) {
      if (args.auto_default_after_ms <= 0) return { error: "auto_default_after_ms must be positive" };
      policy.auto_default_after_ms = args.auto_default_after_ms;
    }
    await ctx.db.patch(stack._id, { policy, updated_at: now });
    let delegated: any = undefined;
    if (args.delegate) {
      const role = await findRole(ctx, stack, args.delegate);
      if (!role) return { error: `Role not found: ${args.delegate}` };
      delegated = await delegateStack(ctx, userId, { ...stack, policy }, role._id, now);
      if (delegated?.error) return delegated;
    }
    return { id: stack._id, short_id: stack.short_id, policy: (await ctx.db.get(stack._id))?.policy ?? policy, delegated };
  },
});

// Every stack in the viewer's boundaries: their teams' stacks and their
// personal ones, open first, newest first.
export async function listStacksCore(ctx: Ctx, userId: Id<"users">, opts: { include_done?: boolean } = {}) {
  const out = new Map<string, StackRow>();
  const personal: StackRow[] = await ctx.db
    .query("decision_stacks")
    .withIndex("by_scope_user", (q: any) => q.eq("scope_user_id", userId))
    .collect();
  for (const s of personal) out.set(String(s._id), s);
  const memberships = await ctx.db
    .query("team_memberships")
    .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
    .collect();
  for (const m of memberships) {
    const rows: StackRow[] = await ctx.db
      .query("decision_stacks")
      .withIndex("by_team", (q: any) => q.eq("team_id", m.team_id))
      .collect();
    for (const s of rows) out.set(String(s._id), s);
  }
  const stacks = Array.from(out.values()).filter((s) => opts.include_done || s.status === "open");
  stacks.sort((a, b) => (a.status === b.status ? b.created_at - a.created_at : a.status === "open" ? -1 : 1));
  return Promise.all(stacks.map((s) => listRow(ctx, s)));
}

export const listStacks = query({
  args: { include_done: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    return listStacksCore(ctx, userId, args);
  },
});

export const listStacksForCli = mutation({
  args: { api_token: v.string(), include_done: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) return { error: "Unauthorized" };
    return { stacks: await listStacksCore(ctx, auth.userId, args) };
  },
});

async function getStackCore(ctx: Ctx, userId: Id<"users">, ref: string) {
  const found = await accessibleStack(ctx, userId, ref);
  if ("error" in found) return found;
  const members = await membersOf(ctx, found.stack);
  const delegate = found.stack.policy.delegate_role_id ? await ctx.db.get(found.stack.policy.delegate_role_id) : null;
  return {
    stack: await listRow(ctx, found.stack),
    // Members in stack order, full rows: the checklist renders each as a card.
    decisions: members,
    delegate_role: delegate ? { _id: delegate._id, short_id: delegate.short_id, name: delegate.name, handle: delegate.handle } : null,
  };
}

export const getStack = query({
  args: { stack: v.string() },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const r = await getStackCore(ctx, userId, args.stack);
    return "error" in r ? null : r;
  },
});

export const getStackForCli = mutation({
  args: { api_token: v.string(), stack: v.string() },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) return { error: "Unauthorized" };
    return getStackCore(ctx, auth.userId, args.stack);
  },
});

// The auto default policy, as a plain function for the cron and the tests:
// every open stack with a deadline answers its ADVISORY pending members whose
// deadline passed with their default. Blocking members never auto answer.
export async function applyAutoDefaultsCore(ctx: Ctx, now: number): Promise<{ answered: number }> {
  const stacks: StackRow[] = await ctx.db
    .query("decision_stacks")
    .withIndex("by_status", (q: any) => q.eq("status", "open"))
    .collect();
  let answered = 0;
  for (const stack of stacks) {
    const ms = stack.policy.auto_default_after_ms;
    if (!ms) continue;
    for (const m of await membersOf(ctx, stack)) {
      if (m.status !== "pending" || m.blocking || m.default_option === undefined) continue;
      // The deadline counts from when the decision joined the stack, not from
      // the ask: an old advisory added to a fresh stack still gets its window.
      const since = Math.max(m.created_at, (m as any).stack_joined_at ?? 0);
      if (since + ms > now) continue;
      const r = await finalizeAnswer(
        ctx,
        m,
        { status: "answered", answer_index: m.default_option },
        { kind: "policy", id: `stack:${stack._id}` },
        { deliver: true, now },
      );
      if (!r.already_resolved) answered += 1;
    }
  }
  return { answered };
}

export const applyAutoDefaults = internalMutation({
  args: {},
  handler: async (ctx) => applyAutoDefaultsCore(ctx, Date.now()),
});
