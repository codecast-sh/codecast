import { query } from "./functions";
import { v } from "convex/values";
import { Id } from "./_generated/dataModel";
import { scopedFetch } from "./data";
import { collectOrgSessions, computeScopeFeed, requireWorkspaceCaller, resolveScope, type OrgScan } from "./org";
import { planProjectsOf } from "./orgRoles";
import { capsFor, countersFor, utcDay } from "./orgEvents";
import { isWholeWorkspace, scopeIds } from "./lib/orgScope";
import { capacity, capacityFlags, type HealthFlag, isOverloaded } from "@codecast/shared/contracts/orgCapacity";

// org.health (docs/architecture/org-staffing.md S3): the flow signals the
// capacity model needs, per role, per person and for the company, with the
// flags the shared model raises against them. Computed on read from the same
// scan org.tree uses plus bounded, indexed reads of the wake log, the
// decision ladder, the tasks in scope, the send ledger between standing
// sessions, chat mentions and the role history. Nothing here is stored.
//
// The thresholds live in @codecast/shared/contracts/orgCapacity; this file
// only measures. `roleActivity` is the one reading of a role's wakes and idle
// time, shared with the analyzer inputs (orgInit.computeAnalysisInputs).

type Ctx = { db: any };
const D = 86_400_000;
export const HEALTH_WINDOW_7D_MS = 7 * D;
export const HEALTH_WINDOW_30D_MS = 30 * D;
export const HEALTH_CAPS = {
  projects: 200,
  plans: 500,
  tasks: 2000,
  decisions: 1000,
  sends_per_session: 300,
  channels: 50,
  messages_per_channel: 300,
  inbox_per_person: 200,
  history_per_role: 1,
} as const;

export type RoleActivity = {
  last_scope_event_at: number | null;
  idle_days: number | null;
  /** Days since the seat was created: a new seat with no event is not idle yet. */
  age_days: number;
  idle: boolean;
  // total and by_day count DELIVERED wakes only, the count the flush gate
  // spends against the cap; a dropped frame bumps nothing and a held one
  // marks its day as a cap hit.
  wakes_7d: { total: number; delivered: number; dropped: number; held: number; days_at_cap: number; cap_hit_days: number; by_day: Record<string, number> };
};

/** The newest event in a workspace: the idle clock of a whole workspace role,
 *  whose scope resolves to no rows of its own. */
export function latestEventAnywhere(tasks: any[], plans: any[], scan: OrgScan): number | null {
  let latest: number | null = null;
  const see = (t: number | undefined) => { if (t && (latest === null || t > latest)) latest = t; };
  for (const t of tasks) see(t.updated_at);
  for (const p of plans) see(p.updated_at);
  for (const { session } of scan.sessions.values()) see(session.updated_at);
  return latest;
}

/** A role's last scope event and its wake log over the week. One reading for
 *  org.health and the analyzer inputs: the idle rule is the model's
 *  `idle_days` over the seat's age when it never had an event, and
 *  `wholeWorkspaceLatest` (latestEventAnywhere) is required so no caller can
 *  read a whole workspace role as idle by mistake. */
export async function roleActivity(ctx: Ctx, userId: Id<"users">, role: any, now: number, opts: { wholeWorkspaceLatest: number | null }): Promise<RoleActivity> {
  let lastScopeEventAt: number | null = null;
  if (isWholeWorkspace(scopeIds(role.scope ?? { project_ids: [], plan_ids: [] }))) {
    lastScopeEventAt = opts.wholeWorkspaceLatest;
  } else {
    const resolved = await resolveScope(ctx, userId, { role_id: String(role._id) });
    if (resolved) {
      const feed = await computeScopeFeed(ctx, resolved, { limit: 1, now });
      lastScopeEventAt = feed.rows[0]?.updated_at ?? null;
    }
  }
  const wakes: any[] = await ctx.db.query("role_wakes").withIndex("by_role_created", (q: any) => q.eq("role_id", role._id).gte("created_at", now - HEALTH_WINDOW_7D_MS)).collect();
  const byDay = new Map<string, number>();
  const heldDays = new Set<string>();
  let held = 0, dropped = 0, delivered = 0;
  for (const w of wakes) {
    if (w.status === "held") { held++; heldDays.add(utcDay(w.created_at)); continue; }
    if (w.status === "dropped") { dropped++; continue; }
    delivered++;
    const day = utcDay(w.created_at);
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
  }
  const caps = capsFor(role);
  const daysAtCap = Array.from(byDay.values()).filter((n) => n >= caps.wakes_per_day).length;
  const capHitDays = new Set([...heldDays, ...Array.from(byDay.entries()).filter(([, n]) => n >= caps.wakes_per_day).map(([d]) => d)]).size;
  const idle_days = lastScopeEventAt ? Math.floor((now - lastScopeEventAt) / D) : null;
  const age_days = Math.floor((now - (role.created_at ?? now)) / D);
  return {
    last_scope_event_at: lastScopeEventAt,
    idle_days,
    age_days,
    idle: (idle_days ?? age_days) >= capacity("idle_days"),
    wakes_7d: { total: delivered, delivered, dropped, held, days_at_cap: daysAtCap, cap_hit_days: capHitDays, by_day: Object.fromEntries(byDay) },
  };
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const isOpen = (t: any) => t.status !== "done" && t.status !== "dropped";
const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

export type OrgHealth = Awaited<ReturnType<typeof computeOrgHealth>>;

export async function computeOrgHealth(ctx: Ctx, userId: Id<"users">, teamId: Id<"teams"> | undefined, now: number) {
  const cut7 = now - HEALTH_WINDOW_7D_MS;
  const scan: OrgScan = await collectOrgSessions(ctx, userId, teamId, now);
  const roles: any[] = scan.roles;
  const roleById = new Map<string, any>(roles.map((r) => [String(r._id), r]));

  // ── Work items, one read each through the workspace chokepoint ──────────
  const fetchOpts = teamId ? { userId, workspace: "team" as const, teamId } : { userId, workspace: "personal" as const };
  const [projects, plans, tasks] = await Promise.all([
    scopedFetch(ctx, "projects", { ...fetchOpts, limit: HEALTH_CAPS.projects }).then((r) => r.records),
    scopedFetch(ctx, "plans", { ...fetchOpts, limit: HEALTH_CAPS.plans }).then((r) => r.records),
    scopedFetch(ctx, "tasks", { ...fetchOpts, limit: HEALTH_CAPS.tasks }).then((r) => r.records),
  ]);
  const plansByProject = new Map<string, any[]>();
  for (const p of plans) if (p.project_id) plansByProject.set(String(p.project_id), [...(plansByProject.get(String(p.project_id)) ?? []), p]);
  const planProjectOf = await planProjectsOf(ctx, roles.map((r) => r.scope));

  // What the narrower roles cover, once: a scope's projects (a named plan
  // covers its project too) and its plans (a covered project's plans too).
  // Ownership of a project is a role naming it, never a whole workspace
  // scope: that is the root's view (the chief of staff, a role created with
  // no scope), so it leaves the unowned signal alone.
  const coveredProjects = new Set<string>();
  const coveredPlans = new Set<string>();
  for (const r of roles) {
    const ids = scopeIds(r.scope ?? { project_ids: [], plan_ids: [] });
    for (const id of ids.project_ids) coveredProjects.add(id);
    for (const id of ids.plan_ids) { coveredPlans.add(id); const pr = planProjectOf.get(id); if (pr) coveredProjects.add(pr); }
  }
  for (const pid of coveredProjects) for (const p of plansByProject.get(pid) ?? []) coveredPlans.add(String(p._id));
  const inScope = (projectIds: Set<string>, planIds: Set<string>) => ({
    tasks: tasks.filter((t) => (t.project_id && projectIds.has(String(t.project_id))) || (t.plan_id && planIds.has(String(t.plan_id)))),
    plans: plans.filter((p) => planIds.has(String(p._id))),
    projectIds,
  });

  // A role's tasks and plans: the scope's projects, the scope's plans plus
  // every plan of a scope project, and the tasks filed under either. A whole
  // workspace role holds the remainder: what no narrower role covers, which
  // is the work it exists to find an owner for.
  const itemsOf = (role: any) => {
    const ids = scopeIds(role.scope ?? { project_ids: [], plan_ids: [] });
    if (isWholeWorkspace(ids)) {
      const projectIds = new Set(projects.map((p) => String(p._id)).filter((id) => !coveredProjects.has(id)));
      const planIds = new Set(plans.map((p) => String(p._id)).filter((id) => !coveredPlans.has(id)));
      const rest = inScope(projectIds, planIds);
      return { ...rest, tasks: [...rest.tasks, ...tasks.filter((t) => !t.project_id && !t.plan_id)] };
    }
    const projectIds = new Set(ids.project_ids);
    const planIds = new Set(ids.plan_ids);
    for (const pid of projectIds) for (const p of plansByProject.get(pid) ?? []) planIds.add(String(p._id));
    return inScope(projectIds, planIds);
  };

  // ── Standing sessions and the send ledger between them ──────────────────
  const standingConvOfRole = new Map<string, string>();
  for (const a of scan.anchors) if (a.org_role_id && a.conversation_id) standingConvOfRole.set(String(a.org_role_id), String(a.conversation_id));
  for (const r of roles) {
    if (standingConvOfRole.has(String(r._id)) || !r.anchor_id) continue;
    const a = scan.anchors.find((x: any) => String(x._id) === String(r.anchor_id));
    if (a?.conversation_id) standingConvOfRole.set(String(r._id), String(a.conversation_id));
  }
  const roleOfConv = async (convId: string): Promise<string | null> => {
    const c = scan.sessions.get(convId)?.raw ?? (await ctx.db.get(convId));
    const rid = c?.standing_role_id ?? c?.org_role_id;
    return rid && roleById.has(String(rid)) ? String(rid) : null;
  };
  // sends[from][to] over the week, read once from each standing session's
  // inbound rows (the ledger keeps delivered rows; sessionThreads reads it
  // the same way).
  const sends = new Map<string, Map<string, number>>();
  for (const [roleId, convId] of standingConvOfRole) {
    const rows: any[] = await ctx.db.query("pending_messages").withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", convId)).order("desc").take(HEALTH_CAPS.sends_per_session);
    for (const row of rows) {
      if (row.created_at < cut7 || !row.from_conversation_id) continue;
      const from = await roleOfConv(String(row.from_conversation_id));
      if (!from || from === roleId) continue;
      const m = sends.get(from) ?? new Map();
      bump(m, roleId);
      sends.set(from, m);
    }
  }

  // ── Chat mentions of roles (team only) ──────────────────────────────────
  const mentions = new Map<string, number>();
  if (teamId) {
    const channels: any[] = await ctx.db.query("chat_channels").withIndex("by_team_name", (q: any) => q.eq("team_id", teamId)).take(HEALTH_CAPS.channels);
    for (const ch of channels) {
      if (ch.archived_at) continue;
      const msgs: any[] = await ctx.db.query("chat_messages").withIndex("by_channel_created", (q: any) => q.eq("channel_id", ch._id).gte("created_at", cut7)).order("desc").take(HEALTH_CAPS.messages_per_channel);
      for (const m of msgs) for (const ref of m.mentions ?? []) if (ref && typeof ref === "object" && ref.kind === "role") bump(mentions, String(ref.role_id));
    }
  }

  // ── Decisions on the ladder over the week ───────────────────────────────
  // Read member by member (the asker's account), never the deployment's
  // newest rows. A hop's latency is ask to recommendation; a hop that never
  // recommended counts the whole wait once it is past the hop deadline (the
  // role that never answers is the bottleneck the threshold describes).
  const latency = new Map<string, number[]>();
  const decisionsOf = new Map<string, number>();
  const escalations = new Map<string, number>();
  let decisionsTruncated = false;
  const deadlineMin = capacity("decision_latency_min");
  for (const status of ["pending", "answered"]) {
    for (const memberId of scan.memberIds) {
      const rows: any[] = await ctx.db.query("session_decisions").withIndex("by_user_status_created", (q: any) => q.eq("user_id", memberId).eq("status", status).gte("created_at", cut7)).order("desc").take(HEALTH_CAPS.decisions);
      if (rows.length >= HEALTH_CAPS.decisions) decisionsTruncated = true;
      for (const d of rows) {
        for (const hop of d.hops ?? []) {
          const rid = String(hop.role_id);
          if (!roleById.has(rid)) continue;
          const note = typeof hop.note === "string" ? hop.note : "";
          if (note.startsWith("skipped")) continue; // a paused or retired seat: never woken
          bump(decisionsOf, rid);
          if (note.startsWith("escalated")) { bump(escalations, rid); continue; }
          let sampleMin: number | null = null;
          if (hop.recommendation !== undefined) sampleMin = (hop.at - d.created_at) / 60_000;
          else if (d.status === "answered") sampleMin = ((d.resolved_at ?? now) - d.created_at) / 60_000;
          else { const waited = (now - d.created_at) / 60_000; if (waited > deadlineMin) sampleMin = waited; }
          if (sampleMin !== null) latency.set(rid, [...(latency.get(rid) ?? []), sampleMin]);
        }
      }
    }
  }

  // ── Per role ────────────────────────────────────────────────────────────
  const reportsOf = new Map<string, number>();
  const directRolesOf = new Map<string, number>();
  for (const r of roles) {
    if (r.reports_to?.kind === "role") bump(reportsOf, String(r.reports_to.role_id));
    else if (r.reports_to?.kind === "user") bump(directRolesOf, String(r.reports_to.user_id));
  }
  const latestAnywhere = latestEventAnywhere(tasks, plans, scan);

  const roleRows = [];
  for (const role of roles) {
    const rid = String(role._id);
    const items = itemsOf(role);
    const stallMs = capacity("review_stall_hours") * 3_600_000;
    const load = {
      open_tasks: items.tasks.filter(isOpen).length,
      in_flight: items.tasks.filter((t) => t.status === "in_progress" || t.status === "in_review").length,
      active_plans: items.plans.filter((p) => p.status === "active").length,
      live_hands: (scan.byParent.get(`role:${rid}`) ?? []).filter((s) => s.state === "working" || s.state === "needs_input" || s.state === "dormant").length,
      direct_reports: reportsOf.get(rid) ?? 0,
    };
    const handoffs = { done: 0, blocked: 0, needs_context: 0 };
    let done7 = 0, stalls = 0;
    for (const t of items.tasks) {
      if (t.status === "in_review" && now - (t.updated_at ?? 0) > stallMs) stalls++;
      if ((t.updated_at ?? 0) < cut7) continue;
      if (t.status === "done") done7++;
      if (t.execution_status === "done" || t.execution_status === "done_with_concerns") handoffs.done++;
      else if (t.execution_status === "blocked") handoffs.blocked++;
      else if (t.execution_status === "needs_context") handoffs.needs_context++;
    }
    const activity = await roleActivity(ctx, userId, role, now, { wholeWorkspaceLatest: latestAnywhere });
    const caps = capsFor(role);
    const counters = countersFor(role, now);
    const spend = {
      wakes_today: counters.wakes,
      wakes_7d_avg: activity.wakes_7d.total / 7,
      wakes_cap: caps.wakes_per_day,
      tokens_today: counters.tokens,
      // Tokens are counted per day on the role's counters only; the ledger
      // keeps no daily history, so the week's average is not known.
      tokens_7d_avg: null as number | null,
      tokens_cap: caps.tokens_per_day,
      cap_hits_7d: activity.wakes_7d.cap_hit_days,
    };
    const toRows = Array.from(sends.get(rid)?.entries() ?? []).map(([to, n]) => ({ role_id: to, handle: roleById.get(to)?.handle ?? "?", n }));
    const fromRows = Array.from(sends.entries()).filter(([, m]) => m.has(rid)).map(([from, m]) => ({ role_id: from, handle: roleById.get(from)?.handle ?? "?", n: m.get(rid)! }));
    const flow = {
      decisions_7d: decisionsOf.get(rid) ?? 0,
      median_recommend_min: median(latency.get(rid) ?? []),
      escalations_7d: escalations.get(rid) ?? 0,
      frames_dropped_7d: activity.wakes_7d.dropped,
      done_7d: done7,
      handoffs_7d: handoffs,
      review_stalls: stalls,
      sends_7d: { to: toRows, from: fromRows },
      mentions_7d: mentions.get(rid) ?? 0,
    };
    const history: any[] = await ctx.db.query("org_role_history").withIndex("by_role", (q: any) => q.eq("role_id", role._id)).order("desc").take(HEALTH_CAPS.history_per_role);
    const lastMoveAt: number | null = history[0]?.created_at ?? null;
    const flags: HealthFlag[] = capacityFlags({
      kind: "role",
      handle: role.handle,
      load,
      spend,
      flow: { decisions_7d: flow.decisions_7d, median_recommend_min: flow.median_recommend_min, review_stalls: stalls, done_7d: done7, sends_7d: { to: toRows.map((r) => ({ handle: r.handle, n: r.n })), from: fromRows.map((r) => ({ handle: r.handle, n: r.n })) } },
      idle_days: activity.idle_days,
      age_days: activity.age_days,
      has_charter: !!(role.charter_doc_id || (role.charter ?? "").trim()),
      breaches: role.overload_streak ?? 0,
    });
    roleRows.push({
      role_id: role._id,
      short_id: role.short_id,
      handle: role.handle,
      name: role.name,
      status: role.status,
      reports_to: role.reports_to,
      load,
      /** Earlier consecutive reviews that flagged the role; the next review
       *  reads it against STABILITY.split_after_breaches. */
      breaches: role.overload_streak ?? 0,
      overloaded_now: isOverloaded(load),
      spend,
      flow,
      last_move_at: lastMoveAt,
      idle_days: activity.idle_days,
      flags,
    });
  }

  // ── People ──────────────────────────────────────────────────────────────
  const people = [];
  for (const uid of scan.memberIds) {
    const user = await ctx.db.get(uid);
    const inbox: any[] = await ctx.db.query("decision_inbox").withIndex("by_user_status", (q: any) => q.eq("user_id", uid).eq("status", "pending")).take(HEALTH_CAPS.inbox_per_person);
    let oldest: number | null = null;
    for (const row of inbox) {
      const d = await ctx.db.get(row.decision_id);
      if (d?.status === "pending") oldest = oldest === null ? d.created_at : Math.min(oldest, d.created_at);
    }
    const name = user?.name ?? user?.email ?? "";
    const direct_roles = directRolesOf.get(String(uid)) ?? 0;
    people.push({
      user_id: uid,
      name,
      direct_roles,
      decisions_waiting: { n: inbox.length, oldest_min: oldest === null ? null : Math.floor((now - oldest) / 60_000) },
      flags: capacityFlags({ kind: "person", name, direct_roles }),
    });
  }

  // ── Company ─────────────────────────────────────────────────────────────
  // A project is owned when a role names it as owner, or when a role's scope
  // names it directly or through one of its plans (coveredProjects above).
  const liveProjects = projects.filter((p) => p.status !== "done");
  const unowned_projects = liveProjects.filter((p) => !p.owner_role_id && !coveredProjects.has(String(p._id))).map((p) => ({ id: String(p._id), title: p.title }));
  const openByPlan = new Map<string, number>();
  for (const t of tasks) if (isOpen(t) && t.plan_id) bump(openByPlan, String(t.plan_id));
  // The company's budget as it stands: the caps of every active role summed,
  // so a proposal states the total it asks a person to allow, not a sum by hand.
  const caps_total = { hands_per_day: 0, wakes_per_day: 0, tokens_per_day: 0 };
  for (const r of roles) {
    if (r.status !== "active") continue;
    const c = capsFor(r);
    caps_total.hands_per_day += c.hands_per_day; caps_total.wakes_per_day += c.wakes_per_day; caps_total.tokens_per_day += c.tokens_per_day;
  }
  const company = {
    caps_total,
    unowned_projects,
    unfiled_tasks: tasks.filter((t) => isOpen(t) && !t.project_id && !t.plan_id).length,
    unfiled_plans: plans.filter((p) => !p.project_id && p.status !== "done" && p.status !== "dropped" && (openByPlan.get(String(p._id)) ?? 0) > 0)
      .map((p) => ({ id: String(p._id), title: p.title, short_id: p.short_id ?? undefined, open_tasks: openByPlan.get(String(p._id))! })),
    plans_without_goal: plans.filter((p) => p.status === "active" && !(p.goal ?? "").trim()).map((p) => ({ id: String(p._id), title: p.title })),
    projects_without_charter: liveProjects.filter((p) => !(p.goal ?? "").trim()).map((p) => ({ id: String(p._id), title: p.title })),
  };

  return {
    workspace: teamId ? { kind: "team" as const, id: String(teamId) } : { kind: "user" as const, id: String(userId) },
    roles: roleRows,
    people,
    company: { ...company, flags: capacityFlags({ kind: "company", ...company }) },
    truncated: { sessions: scan.truncated, tasks: tasks.length >= HEALTH_CAPS.tasks, plans: plans.length >= HEALTH_CAPS.plans, projects: projects.length >= HEALTH_CAPS.projects, decisions: decisionsTruncated },
    generated_at: now,
  };
}

export const health = query({
  args: { api_token: v.optional(v.string()), team_id: v.optional(v.id("teams")) },
  handler: async (ctx, args) => {
    const userId = await requireWorkspaceCaller(ctx, args.api_token, args.team_id);
    if (!userId) return null;
    return computeOrgHealth(ctx, userId, args.team_id, Date.now());
  },
});
