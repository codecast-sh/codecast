// `cast route` and `POST /cli/route` (docs/architecture/org-staffing.md S35):
// one request in, the owner out, with the line of the rule that placed it.
// The rule is contracts/orgRoute routeWork; the semantic router
// (lib/orgRouter) reads what the rule cannot place. A landing is a task in
// the owner's area, assigned to the owner, and a role is woken with one line
// naming it, so the role starts it or recommends it by its switch (S23.1).

import { v } from "convex/values";
import { action, internalQuery } from "./functions";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { requireWorkspaceCaller } from "./org";
import { liveRoleByHandle, resolveRoleRef, rolesInBoundary } from "./lib/orgAccess";
import { resolveScopeRef } from "./orgRoles";
import { findTaskByRef } from "./taskEvidence";
import { taskWork } from "./lib/orgOwnership";
import { callModel } from "./lib/anthropic";
import { parseRouterReply, routerDecision, routerRequest, type RouterRoster } from "./lib/orgRouter";
import { routeWork, type RouteLanding } from "@codecast/shared/contracts/orgRoute";
import { isWholeWorkspaceRole, type OwnedWork } from "@codecast/shared/contracts/orgLead";
import { parseStandingSection } from "@codecast/shared/contracts/briefStanding";

type Boundary = { team_id?: Id<"teams">; scope_user_id?: Id<"users"> };

const HOLDING_MAX = 6;
const TITLE_MAX = 120;

/** The roster the router reads: every live role that can own work, as lib/orgRouter wants it. */
export async function routerRoster(ctx: { db: any }, boundary: Boundary, roles: any[]): Promise<RouterRoster> {
  const team = boundary.team_id ? await ctx.db.get(boundary.team_id) : null;
  const out: RouterRoster = { workspace: team?.name ?? "personal workspace", roles: [], unled: [] };
  // The areas no live role names (S26: the whole workspace role's), so the
  // router sees an unled area as such instead of matching a charter to it.
  const namedProjects = new Set(roles.flatMap((r) => (r.scope?.project_ids ?? []).map(String)));
  const namedPlans = new Set(roles.flatMap((r) => (r.scope?.plan_ids ?? []).map(String)));
  const projects: any[] = boundary.team_id
    ? await ctx.db.query("projects").withIndex("by_team_id", (q: any) => q.eq("team_id", boundary.team_id)).collect()
    : (await ctx.db.query("projects").withIndex("by_user_id", (q: any) => q.eq("user_id", boundary.scope_user_id)).collect()).filter((p: any) => !p.team_id);
  for (const p of projects) {
    if (p.status === "done" || p.status === "archived") continue;
    if (!namedProjects.has(String(p._id))) out.unled!.push({ kind: "project", title: p.title, goal: p.goal ?? undefined });
    const plans: any[] = await ctx.db.query("plans").withIndex("by_project_id", (q: any) => q.eq("project_id", p._id)).collect();
    for (const pl of plans) {
      if (pl.status !== "active" || namedPlans.has(String(pl._id)) || namedProjects.has(String(p._id))) continue;
      out.unled!.push({ kind: "plan", title: pl.title, goal: pl.goal ?? undefined });
    }
  }
  for (const role of roles) {
    if (role.assistant) continue;
    const areas: RouterRoster["roles"][number]["areas"] = [];
    for (const id of role.scope?.project_ids ?? []) { const p = await ctx.db.get(id); if (p) areas.push({ kind: "project", title: p.title, goal: p.goal ?? undefined }); }
    for (const id of role.scope?.plan_ids ?? []) { const p = await ctx.db.get(id); if (p) areas.push({ kind: "plan", title: p.title, goal: p.goal ?? undefined }); }
    const charterDoc = role.charter_doc_id ? await ctx.db.get(role.charter_doc_id) : null;
    const briefDoc = role.brief_doc_id ? await ctx.db.get(role.brief_doc_id) : null;
    const standing = parseStandingSection(briefDoc?.content).sort((a, b) => (b.written_at ?? 0) - (a.written_at ?? 0)).map((l) => `${l.project}: ${l.text}${l.written_on ? ` (${l.written_on})` : ""}`);
    const held: any[] = await ctx.db.query("conversations").withIndex("by_org_role", (q: any) => q.eq("org_role_id", role._id)).order("desc").take(HOLDING_MAX * 3);
    const openTasks: any[] = await ctx.db.query("tasks").withIndex("by_assignee_updated", (q: any) => q.eq("assignee", String(role._id))).order("desc").take(HOLDING_MAX * 3);
    const holding = [
      ...held.filter((c) => !c.standing_role_id && c.status !== "done" && !c.inbox_killed_at).slice(0, HOLDING_MAX).map((c) => `session: ${(c.title ?? "").trim() || c.short_id}`),
      ...openTasks.filter((t) => t.status !== "done" && t.status !== "dropped").slice(0, HOLDING_MAX).map((t) => `task: ${t.title}`),
    ];
    out.roles.push({
      handle: role.handle,
      name: role.name,
      given_name: role.given_name ?? undefined,
      charter: (charterDoc?.content ?? role.charter ?? "").trim() || undefined,
      areas,
      standing,
      holding,
      whole_workspace: isWholeWorkspaceRole(role) || undefined,
    });
  }
  return out;
}

export type Prepared = {
  user_id: Id<"users">;
  boundary: Boundary;
  landing: RouteLanding<any>;
  /** Only when the rule reached line 4 or a tie: what the router reads. */
  roster?: RouterRoster;
  anchor: OwnedWork;
  roles: any[];
};

// Everything the action needs, read once: the caller, the boundary, the
// target and anchors resolved, the rule applied, and the roster when the
// router will be asked.
export const prepare = internalQuery({
  args: {
    api_token: v.string(),
    team_id: v.optional(v.id("teams")),
    to: v.optional(v.string()),
    task: v.optional(v.string()),
    plan: v.optional(v.string()),
    project: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<Prepared> => {
    const userId = await requireWorkspaceCaller(ctx, args.api_token, args.team_id);
    if (!userId) throw new Error("Unauthorized");
    const boundary: Boundary = args.team_id ? { team_id: args.team_id } : { scope_user_id: userId };
    const roles = await rolesInBoundary(ctx, boundary);

    let to: Prepared["landing"]["owner"] | null = null;
    if (args.to) {
      const ref = args.to.trim();
      if (ref.toLowerCase() === "me") to = { kind: "user", user_id: String(userId) };
      else {
        const role = (await liveRoleByHandle(ctx, boundary, ref.replace(/^@/, "").toLowerCase())) ?? (await resolveRoleRef(ctx, ref));
        if (!role || role.status === "retired" || !roles.some((r) => String(r._id) === String(role._id))) throw new Error(`"${ref}" is not a role in this workspace (try @handle or or-N) or "me"`);
        to = { kind: "role", role };
      }
    }

    const anchor: OwnedWork = {};
    if (args.task) {
      const task = await findTaskByRef(ctx, args.task);
      if (!task) throw new Error(`Task not found: ${args.task}`);
      Object.assign(anchor, await taskWork(ctx, task));
    }
    if (args.plan) {
      const r = await resolveScopeRef(ctx, boundary, `plan:${args.plan}`);
      if (r.kind !== "plan") throw new Error(`Plan not found: ${args.plan}`);
      anchor.plan_id = r.id;
      if (!anchor.project_id) anchor.project_id = (await ctx.db.get(r.id))?.project_id;
    }
    if (args.project) {
      const r = await resolveScopeRef(ctx, boundary, `project:${args.project}`);
      anchor.project_id = r.id;
    }

    // A request has a sender but no starter: a session stays with whoever
    // started it (line 3), a request with nothing to go on is read (line 4).
    const landing = routeWork({ to, anchor }, roles);
    const roster = landing.owner ? undefined : await routerRoster(ctx, boundary, roles);
    return { user_id: userId, boundary, landing, roster, anchor, roles };
  },
});

const ownerOut = (o: { kind: "role"; role: any } | { kind: "user"; user_id: string } | null) =>
  !o ? null : o.kind === "role" ? { kind: "role" as const, role_id: String(o.role._id), handle: o.role.handle, name: o.role.name } : { kind: "user" as const, user_id: o.user_id };

export type RouteResult = {
  owner: ReturnType<typeof ownerOut>;
  line: 1 | 2 | 3 | 4;
  why: string;
  /** Line 4: what the router said. */
  confidence?: number;
  /** Nothing filed: the caller picks one (`cast route --to`). */
  choices?: Array<{ handle: string; confidence?: number; reason: string }>;
  dry: boolean;
  task?: { id: string; short_id: string } | null;
  woke?: { short_id: string } | null;
  not_woken?: string;
  /** Dry: the roster the router read, for the evals' capture. */
  roster?: RouterRoster;
};

export const route = action({
  args: {
    api_token: v.string(),
    request: v.string(),
    team_id: v.optional(v.id("teams")),
    to: v.optional(v.string()),
    task: v.optional(v.string()),
    plan: v.optional(v.string()),
    project: v.optional(v.string()),
    dry: v.optional(v.boolean()),
    from_session: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<RouteResult> => {
    const request = args.request.trim();
    if (!request) throw new Error("A request to route: cast route \"<the request>\"");
    const p: Prepared = await ctx.runQuery(internal.orgRoute.prepare, { api_token: args.api_token, team_id: args.team_id, to: args.to, task: args.task, plan: args.plan, project: args.project });
    const dry = args.dry === true;
    let owner = p.landing.owner;
    let why = p.landing.why;
    let confidence: number | undefined;
    let choices: RouteResult["choices"];

    if (!owner && "choices" in p.landing) {
      choices = p.landing.choices.map((r: any) => ({ handle: r.handle, reason: `names its ${p.anchor.plan_id ? "plan" : "project"}` }));
    } else if (!owner) {
      const roster = p.roster!;
      const reply = await callModel({ ...routerRequest(roster, request), label: "Route request" });
      const decision = routerDecision(reply ? parseRouterReply(reply.text, roster) : null);
      confidence = decision.confidence;
      why = `${decision.reason || why}`;
      if (decision.kind === "file") {
        const role = p.roles.find((r: any) => r.handle === decision.handle);
        if (role) owner = { kind: "role", role };
      } else {
        choices = decision.choices;
      }
    }

    const base = { owner: ownerOut(owner), line: p.landing.line, why, confidence, choices, dry, ...(dry && p.roster ? { roster: p.roster } : {}) };
    if (!owner || dry) return { ...base, task: null, woke: null };

    const [firstLine, ...rest] = request.split("\n");
    const title = firstLine.trim().slice(0, TITLE_MAX) || request.slice(0, TITLE_MAX);
    const description = [rest.join("\n").trim(), `Routed by cast route (line ${p.landing.line}: ${why}).`].filter(Boolean).join("\n\n");
    const created: { id: string; short_id: string } = await ctx.runMutation(api.tasks.create, {
      api_token: args.api_token,
      title,
      description,
      source: "route",
      assignee: owner.kind === "role" ? String(owner.role._id) : "me",
      ...(p.anchor.project_id ? { project_id: String(p.anchor.project_id) } : {}),
      ...(p.anchor.plan_id ? { plan_id: String(p.anchor.plan_id) } : {}),
      ...(args.team_id ? { workspace: "team" as const, team_id: args.team_id } : { workspace: "personal" as const }),
      promoted: owner.kind === "user" ? true : undefined,
    });
    const task = { id: String(created.id), short_id: created.short_id };
    let woke: RouteResult["woke"] = null;
    let not_woken: string | undefined;
    if (owner.kind === "role") {
      try {
        const sent: any = await ctx.runMutation(api.orgRoles.wake, {
          api_token: args.api_token,
          role_id: String(owner.role._id),
          message: `A request was routed to you (line ${p.landing.line}: ${why}). It is ${task.short_id}: ${title}. Read it with \`cast task show ${task.short_id}\`, start it if you start work on your own, otherwise say in one line that it needs starting and recommend it.`,
          ...(args.from_session ? { from_session: args.from_session } : {}),
        });
        woke = sent?.short_id ? { short_id: sent.short_id } : null;
      } catch (e: any) {
        not_woken = String(e?.message ?? e);
      }
    }
    return { ...base, task, woke, ...(not_woken ? { not_woken } : {}) };
  },
});
