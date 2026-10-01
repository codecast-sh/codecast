// Knowledge handoff when roles change (docs/architecture/org-staffing.md S32).
// A role's knowledge is its brief: notes plus the dated lines under "Where it
// stands". When an area (a project or a plan) moves from one role to another
// (a retire, a split, a scope edit, a hire that takes an area from a wider
// role), codecast:
//
//   1. copies the outgoing role's standing lines for the moved areas into
//      each receiver's brief, marked "(from @outgoing)";
//   2. records on each receiver which role it succeeded for which area, so
//      its page says where the lines came from;
//   3. arms one trigger on the outgoing role's standing session, run once in
//      its own thread, to hand each receiver what the lines do not say, which
//      lands with `cast role handoff @receiver -` (performHandoffWrite);
//   4. a retire that moved the area waits for that handoff, up to a deadline,
//      before decommissioning (orgRoles.performRetireRole reads
//      `handing_over.retire`; the sweep below closes handoffs past deadline).
//
// The move itself is read from the one ownership rule (contracts/orgLead
// ownerOf): a snapshot of who owns each area before the write, and who after.

import { internalMutation, mutation } from "./functions";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { ownerOf, type OwnedWork } from "@codecast/shared/contracts/orgLead";
import { parseStandingSection, standingLineFor, standingLineFrom, withStandingLines, type StandingLine } from "@codecast/shared/contracts/briefStanding";
import { insertTask, applyRunNow } from "./agentTasks";
import { ROLE_HANDOFF_TITLE_PREFIX, roleHandoffPrompt, roleHandoffTitle, type HandoffReceiverSpec } from "./lib/orgRoutine";
import { liveRoleByHandle, rolesInBoundary, requireRole, userCanAdminRole } from "./lib/orgAccess";
import { mirrorBriefState, performRetireRole, roleForSession } from "./orgRoles";
import { getAuthenticatedUserId, reachableRole, tellRole } from "./pendingMessages";

type Ctx = { db: any; scheduler?: any };

export const HANDOFF_DEADLINE_MS = 24 * 60 * 60 * 1000;

export type AreaRef = { project_id?: Id<"projects">; plan_id?: Id<"plans"> };
export type AreaMove = AreaRef & { from: any; to: any };
export type HandoffReason = "retire" | "split" | "scope";

const areaKey = (a: AreaRef) => (a.project_id ? `project:${String(a.project_id)}` : `plan:${String(a.plan_id)}`);

/** The work an area is, as the ownership rule reads it: a plan carries its
 *  project so a role listing the project covers the plan. */
async function workOf(ctx: Ctx, a: AreaRef): Promise<OwnedWork> {
  if (a.project_id) return { project_id: a.project_id };
  const plan = a.plan_id ? await ctx.db.get(a.plan_id) : null;
  return { plan_id: a.plan_id, project_id: plan?.project_id };
}

/** Every area a set of roles names, deduplicated. */
export function areasOf(roles: Array<{ scope?: { project_ids?: any[]; plan_ids?: any[] } | null }>): AreaRef[] {
  const seen = new Map<string, AreaRef>();
  for (const r of roles) {
    for (const id of r.scope?.project_ids ?? []) seen.set(`project:${String(id)}`, { project_id: id });
    for (const id of r.scope?.plan_ids ?? []) seen.set(`plan:${String(id)}`, { plan_id: id });
  }
  return [...seen.values()];
}

/** Who holds each area right now, by the rule, over the boundary's live
 *  roles: the one owner, or the roles watching it when two list it and
 *  neither is above the other (a scope being moved in two steps passes
 *  through that state). `except` leaves one role out, the way a retire will. */
export async function ownerSnapshot(ctx: Ctx, boundary: { team_id?: any; scope_user_id?: any }, areas: AreaRef[], except?: any): Promise<Map<string, any[]>> {
  const roles = (await rolesInBoundary(ctx, boundary)).filter((r) => !except || String(r._id) !== String(except._id));
  const out = new Map<string, any[]>();
  for (const a of areas) {
    const o = ownerOf(await workOf(ctx, a), roles);
    out.set(areaKey(a), o.kind === "owner" ? [o.role] : o.kind === "watchers" ? o.roles : []);
  }
  return out;
}

/** The moves between two snapshots: for each area, every role that held it
 *  before and not after hands it to every role that holds it after. A role
 *  that merely gained a share while the holder kept it is no move. */
export function areaMoves(areas: AreaRef[], before: Map<string, any[]>, after: Map<string, any[]>): AreaMove[] {
  const out: AreaMove[] = [];
  for (const a of areas) {
    const was = before.get(areaKey(a)) ?? [];
    const now = after.get(areaKey(a)) ?? [];
    const lost = was.filter((r) => !now.some((n) => String(n._id) === String(r._id)));
    if (!lost.length || !now.length) continue;
    for (const from of lost) for (const to of now) out.push({ ...a, from, to });
  }
  return out;
}

async function areaTitle(ctx: Ctx, a: AreaRef): Promise<{ title: string; short_id?: string | null }> {
  const row = a.project_id ? await ctx.db.get(a.project_id) : a.plan_id ? await ctx.db.get(a.plan_id) : null;
  return { title: row?.title ?? (a.project_id ? "a project" : "a plan"), short_id: row?.short_id ?? null };
}

async function briefOf(ctx: Ctx, role: any): Promise<{ doc: any | null; content: string }> {
  const doc = role.brief_doc_id ? await ctx.db.get(role.brief_doc_id) : null;
  return { doc, content: doc?.content ?? "" };
}

/** Write a brief's content through the one mirror every brief write uses,
 *  creating the doc when the role has none yet. */
export async function writeBrief(ctx: Ctx, role: any, content: string, now: number): Promise<void> {
  if (role.brief_doc_id) {
    await ctx.db.patch(role.brief_doc_id, { content, updated_at: now });
  } else {
    const id = await ctx.db.insert("docs", { user_id: role.host_user_id, team_id: role.team_id ?? undefined, title: `Brief: ${role.name}`, content, doc_type: "brief", source: "agent", created_at: now, updated_at: now });
    await ctx.db.patch(role._id, { brief_doc_id: id, updated_at: now });
    role.brief_doc_id = id;
  }
  await mirrorBriefState(ctx, role, content);
}

export type HandoffResult = {
  receivers: Array<{ role_id: string; handle: string; areas: string[]; lines: number }>;
  trigger_id: Id<"agent_tasks"> | null;
  deadline: number;
};

/** Record a set of moves from ONE outgoing role: copy its lines, stamp the
 *  receivers, arm its handoff trigger, mark it handing over. `retire` makes
 *  the retire wait on it. Returns null when nothing moved. */
export async function beginAreaHandoff(
  ctx: Ctx,
  userId: Id<"users">,
  from: any,
  moves: AreaMove[],
  reason: HandoffReason,
  opts: { now?: number; deadline_ms?: number; retire?: { standing_session?: "keep" | "retire" } } = {},
): Promise<HandoffResult | null> {
  const mine = moves.filter((m) => String(m.from._id) === String(from._id));
  if (!mine.length) return null;
  const now = opts.now ?? Date.now();
  const deadline = now + (opts.deadline_ms ?? HANDOFF_DEADLINE_MS);
  const lines = parseStandingSection((await briefOf(ctx, from)).content);
  const byReceiver = new Map<string, { role: any; moves: AreaMove[] }>();
  for (const m of mine) {
    const slot = byReceiver.get(String(m.to._id)) ?? { role: m.to, moves: [] };
    slot.moves.push(m);
    byReceiver.set(String(m.to._id), slot);
  }
  const receivers: HandoffResult["receivers"] = [];
  const specs: HandoffReceiverSpec[] = [];
  const stored: any[] = [];
  // A role that held the area only as the workspace's remainder (it never
  // named it) and wrote no line about it has nothing to hand over: no copy,
  // no trigger. A role that named the area is asked even with no line.
  const named = (a: AreaRef) => (a.project_id ? (from.scope?.project_ids ?? []).some((id: any) => String(id) === String(a.project_id)) : (from.scope?.plan_ids ?? []).some((id: any) => String(id) === String(a.plan_id)));
  for (const { role: to, moves: mv } of byReceiver.values()) {
    const receiver = await ctx.db.get(to._id);
    if (!receiver || receiver.status === "retired") continue;
    const copied: string[] = [];
    const titles: string[] = [];
    const succeeded: any[] = [...(receiver.succeeded ?? [])];
    let anyNamed = false;
    for (const m of mv) {
      const area = await areaTitle(ctx, m);
      const line: StandingLine | null = standingLineFor(lines, area);
      if (!line && !named(m)) continue;
      anyNamed = true;
      titles.push(area.title);
      if (line) copied.push(standingLineFrom(line, from.handle));
      succeeded.push({ ...(m.project_id ? { project_id: m.project_id } : {}), ...(m.plan_id ? { plan_id: m.plan_id } : {}), from_role_id: from._id, from_handle: from.handle, from_name: from.name, at: now, lines: line ? 1 : 0 });
    }
    if (!anyNamed) continue;
    if (copied.length) await writeBrief(ctx, receiver, withStandingLines((await briefOf(ctx, receiver)).content, copied), now);
    await ctx.db.patch(receiver._id, { succeeded, updated_at: now });
    receivers.push({ role_id: String(receiver._id), handle: receiver.handle, areas: titles, lines: copied.length });
    specs.push({ handle: receiver.handle, areas: titles });
    stored.push({ role_id: receiver._id, handle: receiver.handle, project_ids: mv.flatMap((m) => (m.project_id ? [m.project_id] : [])), plan_ids: mv.flatMap((m) => (m.plan_id ? [m.plan_id] : [])) });
  }
  if (!receivers.length) return null;
  // The trigger: once, now, on the outgoing role's standing session, when it
  // has one that can still run. Without one there is nobody to hand over
  // what the lines do not say, and the handoff is the lines alone.
  const standing = from.status === "active" ? (await reachableRole(ctx, from._id))?.standing ?? null : null;
  let trigger_id: Id<"agent_tasks"> | null = null;
  if (standing) {
    const created = await insertTask(ctx as any, standing.user_id, {
      title: roleHandoffTitle(specs),
      prompt: roleHandoffPrompt(specs, reason, deadline),
      originating_conversation_id: String(standing._id),
      project_path: standing.project_path ?? undefined,
      schedule_type: "once",
      run_at: now,
      mode: "apply",
      role_id: from._id,
    });
    trigger_id = created.id;
  }
  // A handoff already in flight takes the new receivers in (one row holds
  // one handoff); its deadline and any retire waiting on it stand.
  const prior = from.handing_over;
  const merged = [...(prior?.receivers ?? [])];
  for (const r of stored) {
    const at = merged.findIndex((m: any) => String(m.role_id) === String(r.role_id));
    if (at < 0) merged.push(r);
    else merged[at] = { ...merged[at], project_ids: [...new Set([...merged[at].project_ids, ...r.project_ids].map(String))], plan_ids: [...new Set([...merged[at].plan_ids, ...r.plan_ids].map(String))], done_at: undefined };
  }
  const retire = opts.retire ? { ...(opts.retire.standing_session ? { standing_session: opts.retire.standing_session } : {}) } : prior?.retire;
  await ctx.db.patch(from._id, {
    handing_over: { reason: prior?.reason ?? reason, started_at: prior?.started_at ?? now, deadline: prior?.deadline ?? deadline, by: userId, trigger_id: trigger_id ?? prior?.trigger_id, receivers: merged, ...(retire ? { retire } : {}) },
    updated_at: now,
  });
  return { receivers, trigger_id, deadline: prior?.deadline ?? deadline };
}

/** `cast role handoff @receiver -` from the outgoing role's own session (or
 *  an admin): the body lands in the receiver's brief as a dated section, the
 *  receiver is woken to read it, and the handoff to that receiver is done.
 *  When every receiver is done and a retire waits on it, the retire runs. */
export async function performHandoffWrite(ctx: Ctx, userId: Id<"users">, args: { from_session?: string; from_role?: string; receiver: string; body: string }, now = Date.now()): Promise<any> {
  const body = args.body.trim();
  if (!body) throw new Error("An empty handoff: pass what the receiver needs on stdin");
  const ownSummary = args.from_session ? await roleForSession(ctx as any, userId, args.from_session) : null;
  const own = ownSummary ? await ctx.db.get(ownSummary.role_id) : null;
  const from = own ?? (args.from_role ? await requireRole(ctx, userId, args.from_role, "admin") : null);
  if (!from) throw new Error("Run this inside the outgoing role's session, or name it with --from @handle as an admin");
  if (!own && !(await userCanAdminRole(ctx, userId, from))) throw new Error("Only the role's own session or an admin may hand over for it");
  const byHandle = await liveRoleByHandle(ctx, from, args.receiver.replace(/^@/, ""));
  const receiver = byHandle ?? await requireRole(ctx, userId, args.receiver, "access");
  if (receiver.status === "retired") throw new Error(`@${receiver.handle} is retired`);
  const hand = from.handing_over;
  const slot = hand?.receivers.find((r: any) => String(r.role_id) === String(receiver._id));
  const areas: string[] = [];
  for (const id of slot?.project_ids ?? []) areas.push((await ctx.db.get(id))?.title ?? "a project");
  for (const id of slot?.plan_ids ?? []) areas.push((await ctx.db.get(id))?.title ?? "a plan");
  const day = new Date(now).toISOString().slice(0, 10);
  const heading = `## Handed over from @${from.handle} (${day})${areas.length ? `: ${areas.join(", ")}` : ""}`;
  const current = (await briefOf(ctx, receiver)).content.replace(/\s+$/, "");
  await writeBrief(ctx, receiver, `${current}${current ? "\n\n" : ""}${heading}\n${body}`, now);
  // The receiver's succession rows for these areas now carry when the words came.
  const succeeded = (receiver.succeeded ?? []).map((s: any) => String(s.from_role_id) === String(from._id) && !s.handed_at ? { ...s, handed_at: now } : s);
  await ctx.db.patch(receiver._id, { succeeded, updated_at: now });
  await tellRole(ctx, receiver._id, {
    content: `@${from.handle} handed over ${areas.length ? areas.join(", ") : "its area"} to you: read the "Handed over from @${from.handle}" section at the end of your brief (cast brief) and fold it into your lines.`,
    client_id: `handoff:${from._id}:${receiver._id}:${now}`,
    from_user_id: userId,
  });
  let finished: any = null;
  if (hand && slot) {
    const receivers = hand.receivers.map((r: any) => (String(r.role_id) === String(receiver._id) ? { ...r, done_at: now } : r));
    const allDone = receivers.every((r: any) => r.done_at);
    await ctx.db.patch(from._id, { handing_over: { ...hand, receivers }, updated_at: now });
    if (allDone) finished = await closeHandoff(ctx, await ctx.db.get(from._id), "done", now);
  }
  return { from: from.handle, to: receiver.handle, areas, chars: body.length, handoff: hand ? (finished ? "complete" : "partial") : "none", retired: finished?.retired ?? false };
}

/** Close a handoff: the row forgets it, and a retire that waited runs now
 *  (as the person who asked for it, with the choice they made). */
export async function closeHandoff(ctx: Ctx, from: any, how: "done" | "deadline", now = Date.now()): Promise<{ how: string; retired: boolean }> {
  const hand = from.handing_over;
  if (!hand) return { how, retired: false };
  if (hand.trigger_id && how === "deadline") {
    const t = await ctx.db.get(hand.trigger_id);
    if (t && (t.status === "scheduled" || t.status === "paused")) await ctx.db.patch(t._id, { status: "cancelled", updated_at: now });
  }
  await ctx.db.patch(from._id, { handing_over: undefined, updated_at: now });
  if (!hand.retire) return { how, retired: false };
  await performRetireRole(ctx, hand.by, { role_id: String(from._id), standing_session: hand.retire.standing_session, handoff: "done" });
  return { how, retired: true };
}

/** Every handoff past its deadline closes with what was written. */
export async function sweepCore(ctx: Ctx, now = Date.now()): Promise<{ closed: string[] }> {
  const closed: string[] = [];
  const roles: any[] = await ctx.db.query("org_roles").collect();
  for (const role of roles) {
    if (!role.handing_over || role.handing_over.deadline > now) continue;
    await closeHandoff(ctx, role, "deadline", now);
    closed.push(role.short_id);
  }
  return { closed };
}

export const sweep = internalMutation({ args: {}, handler: async (ctx) => sweepCore(ctx) });

export const write = mutation({
  args: { api_token: v.optional(v.string()), from_session: v.optional(v.string()), from_role: v.optional(v.string()), receiver: v.string(), body: v.string() },
  handler: async (ctx, { api_token, ...args }) => {
    const userId = await getAuthenticatedUserId(ctx, api_token);
    if (!userId) throw new Error("Authentication failed: invalid token or session");
    return performHandoffWrite(ctx, userId, args);
  },
});

/** A person runs the outgoing role's handoff trigger now (the role page's
 *  "Hand over now"), or closes the handoff without waiting. */
export const settle = mutation({
  args: { api_token: v.optional(v.string()), role_id: v.string(), how: v.union(v.literal("run"), v.literal("close")) },
  handler: async (ctx, { api_token, ...args }) => {
    const userId = await getAuthenticatedUserId(ctx, api_token);
    if (!userId) throw new Error("Authentication failed: invalid token or session");
    const role = await requireRole(ctx, userId, args.role_id, "admin");
    if (!role.handing_over) throw new Error("This role is not handing anything over");
    if (args.how === "close") return closeHandoff(ctx, role, "deadline");
    const t = role.handing_over.trigger_id ? await ctx.db.get(role.handing_over.trigger_id) : null;
    if (!t) throw new Error("The handoff has no trigger to run: the role has no standing session");
    await applyRunNow(ctx as any, t);
    return { how: "run", trigger: t.short_id };
  },
});

export { ROLE_HANDOFF_TITLE_PREFIX };
