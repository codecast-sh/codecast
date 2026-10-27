// A team's live flow (doc s975wwqd8hdn81affbf2jvygpn8gvvt4): a flow from the
// library switched on, fed by its sources, with one queue of the team's open
// problems in the line's start order (byStartOrder: score, then findings, then
// age). The sweep admits from it onto the machines (orgLine.planSweep), and a
// team with a live flow admits nothing per lead. Each run still starts as the
// lead of its problem's area (lineOwnerOf): that role's seat, spawner and
// placement, so the card goes to the person over that area. Leads become
// watchers; the flow's own watcher, when it has one, answers its asks.
import { ConvexError, v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internalMutation, mutation, query } from "./functions";
import type { Id } from "./_generated/dataModel";
import { verifyApiToken } from "./apiTokens";
import { requireTeamAdmin, resolveSessionConversation } from "./lib/access";
import { SESSION_SHORT_ID_RE } from "@codecast/shared/chat";
import { atCap } from "@codecast/shared/contracts/orgCapacity";
import { lineStartsOn } from "@codecast/shared/contracts/roleAutonomy";
import { utcDay } from "./lib/orgCaps";
import { WORKING_RUN_STATUSES } from "./lib/linePlacement";
import { barWords, byStartOrder, clearsBar, startValue, type FlowBar } from "./lib/linePriority";
import { problemSourceOf } from "./workflows";
import { isJudgeProblem } from "@codecast/shared/contracts/judgeReview";
import { flowRouteFor } from "./lib/flowRoute";
import { agentAssignee, claimSlot, freeSlots, isReadyCause, lineLoadFor, lineOwnerOf, takeAdmissible, type LineLoad, type LineLoads } from "./orgLine";

type Ctx = { db: any };

/** How many of the head a queue read takes from each order (scored, unscored) before it filters. */
export const LIVE_FLOW_WINDOW = 200;
/** How many of the queue a view shows. */
export const LIVE_FLOW_SHOWN = 50;

export type LiveCandidate = { task: any; role: any };

export const flowHands = (flow: any, now: number): number => (flow.counters?.day === utcDay(now) ? flow.counters.hands : 0);
export const flowAtHandsCap = (flow: any, now: number): boolean => atCap(flowHands(flow, now), flow.caps?.hands_per_day);
/** The flow's hold while it stands, else null. */
export const flowHold = (flow: any, now: number): { why: string; until: number; by: string; at: number } | null => (flow.hold && flow.hold.until > now ? flow.hold : null);
/** Whether a live flow may start a run now: on, not held, hands left today. */
export const flowAdmits = (flow: any, now: number): boolean => !!flow?.on && !flowHold(flow, now) && !flowAtHandsCap(flow, now);
const holdWords = (hold: { why: string; until: number }) => `held until ${new Date(hold.until).toISOString().slice(0, 16).replace("T", " ")} UTC: ${hold.why}`;

/** The team's roles a live flow runs as: each problem goes to the one whose area holds it. */
export const flowRoles = (flow: { team_id?: any }, roles: any[]): any[] => roles.filter((r) => String(r.team_id ?? "") === String(flow.team_id ?? "") && r.team_id);

/** Whether a live flow, on or off, holds the team's line: its leads then admit nothing on their own. */
export async function liveFlowFor(ctx: Ctx, teamId: string | null | undefined): Promise<any | null> {
  if (!teamId) return null;
  return ctx.db.query("live_flows").withIndex("by_team", (q: any) => q.eq("team_id", teamId)).first();
}

/**
 * The live flow's queue in start order, as far as `limit`: the open, ready
 * problems of its workspace (the scored head, highest first, and the
 * unscored, which rank as 50) and the open tasks handed to its roles, each
 * with the role whose area holds it. Left out: a problem with a run, one
 * under the flow's bar (clearsBar; a task handed to a role is someone's
 * choice and runs whatever it scored), one no active role owns, one handed
 * to a person or to a role that does not own it, one from a source the flow
 * does not take, a trial problem, and one with a blocker open.
 */
export async function liveFlowCandidates(ctx: Ctx, flow: any, roles: any[], limit: number): Promise<LiveCandidate[]> {
  if (limit <= 0) return [];
  const team = flowRoles(flow, roles);
  const window = Math.min(LIVE_FLOW_WINDOW, limit + 64);
  const head = (q: any) => q.eq("workspace", flow.workspace).eq("source", "signal").eq("status", "open").eq("readiness", "ready");
  const rows: any[] = [
    ...await ctx.db.query("tasks").withIndex("by_workspace_source_status_readiness_score", head).order("desc").take(window),
    ...await ctx.db.query("tasks").withIndex("by_workspace_source_status_readiness_score", (q: any) => head(q).eq("cause.scored.score", undefined)).take(window),
  ];
  for (const r of team) {
    for (const a of [agentAssignee(r), String(r._id)]) {
      rows.push(...await ctx.db.query("tasks").withIndex("by_assignee_status", (q: any) => q.eq("assignee", a).eq("status", "open")).collect());
    }
  }
  const seen = new Set<string>();
  const ranked: LiveCandidate[] = [];
  for (const task of rows) {
    if (seen.has(String(task._id))) continue;
    seen.add(String(task._id));
    if (task.status !== "open" || task.workflow_run_id || task.ephemeral || task.workspace !== flow.workspace) continue;
    if (!task.assignee && (!isReadyCause(task) || !clearsBar(task, flow.bar))) continue;
    ranked.push({ task, role: null });
  }
  ranked.sort((a, b) => byStartOrder(a.task, b.task));
  return takeAdmissible(ctx, ranked, limit, async (c) => {
    const owner = await lineOwnerOf(ctx, c.task, team);
    if (!owner || owner.status !== "active" || owner.handing_over?.retire) return false;
    if (c.task.assignee && c.task.assignee !== agentAssignee(owner) && c.task.assignee !== String(owner._id)) return false;
    if (flow.sources?.length && c.task.source === "signal" && !flow.sources.includes((await problemSourceOf(ctx, c.task)) ?? "")) return false;
    c.role = owner;
    return true;
  });
}

/** The route a judge problem takes under this flow: its family's judge member, or the words it waits on. */
async function judgeRouteOf(ctx: Ctx, flow: any) {
  const rows: any[] = await ctx.db.query("workflows").withIndex("by_workspace", (q: any) => q.eq("workspace", flow.workspace)).collect();
  return flowRouteFor({ flow: { ...flow, on: true }, spine: await ctx.db.get(flow.workflow_id), rows, source: null, judge: true });
}

export type LivePlanned = { role_id: string; task_id: string; place?: { device: string; project_path: string }; live_flow_id: string };

/**
 * What one sweep pass starts from a live flow: its queue in order while
 * hands are left today and `room` allows, each on its area lead's machines
 * (lineLoadFor, shared through `loads` with the rest of the pass). A problem
 * whose lead's machines are full waits and the next one is tried, so a full
 * laptop never holds back problems the pool can take. `waiting` says why the
 * head did not start.
 */
export async function planLiveFlow(ctx: Ctx, flow: any, roles: any[], now: number, room: number, loads: LineLoads): Promise<{ starts: LivePlanned[]; waiting: string | null; queue: Array<LiveCandidate & { waiting: string | null }> }> {
  const handsCap = flow.caps?.hands_per_day;
  const handsLeft = handsCap == null ? Infinity : handsCap - flowHands(flow, now);
  const take = Math.min(room, handsLeft);
  const hold = flowHold(flow, now);
  const offWords = !flow.on ? "the flow is off" : hold ? holdWords(hold) : handsLeft <= 0 ? "hands cap reached" : null;
  const candidates = await liveFlowCandidates(ctx, flow, roles, Math.max(take, 0) + 16);
  // A judge problem waits while the flow's family has no judge route (lib/flowRoute); every other problem has a graph.
  const judgeRoute = candidates.some((c) => isJudgeProblem(c.task.cause)) ? await judgeRouteOf(ctx, flow) : null;
  const starts: LivePlanned[] = [];
  const queue: Array<LiveCandidate & { waiting: string | null }> = [];
  for (const c of candidates) {
    let waiting = offWords;
    if (!waiting && isJudgeProblem(c.task.cause)) waiting = judgeRoute?.waiting ?? null;
    if (!waiting && starts.length >= take) waiting = "waits for the next pass";
    let load: LineLoad | null = null;
    if (!waiting) {
      load = await lineLoadFor(ctx, c.role, now, loads, roles);
      if (freeSlots(load) <= 0) waiting = `${load.working} run${load.working === 1 ? " is" : "s are"} working on @${c.role.handle}'s machine${load.pool ? "s" : ""}`;
    }
    if (!waiting && load) {
      const place = claimSlot(load);
      starts.push({ role_id: String(c.role._id), task_id: String(c.task._id), live_flow_id: String(flow._id), ...(place ? { place } : {}) });
    }
    queue.push({ ...c, waiting });
  }
  return { starts, waiting: offWords ?? queue.find((q) => q.waiting)?.waiting ?? null, queue };
}

export type LiveFlowRow = {
  _id: string;
  workspace: string;
  team_id: string | null;
  flow: { id: string; slug: string | null; label: string };
  sources: string[] | null;
  on: boolean;
  caps: { hands_per_day: number | null };
  hands_today: number;
  hold: { why: string; until: number; by: string; at: number } | null;
  /** The bar a problem clears to start (clearsBar), and who set it; null takes every problem. */
  bar: (FlowBar & { by: string; at: number }) | null;
  load: { working: number; cap: number };
  waiting: string | null;
  watcher: { role_id: string; handle: string } | null;
  changed_by: string;
  changed_at: number;
  /** The web's optimistic row this one supersedes, for a flow started there. */
  client_key: string | null;
  running: string[];
  queue: Array<{ task_id: string; waiting: string | null }>;
};

/** One live flow as the web and the CLI read it: its row, its machines' load, its runs and the head of its queue. */
export async function liveFlowView(ctx: Ctx, flow: any, now = Date.now()): Promise<LiveFlowRow & { entries: Array<LiveCandidate & { waiting: string | null }> }> {
  const roles: any[] = await ctx.db.query("org_roles").collect();
  const team = flowRoles(flow, roles);
  const loads: LineLoads = new Map();
  // Every machine the flow's leads run on, counted once.
  for (const r of team) if (r.status === "active") await lineLoadFor(ctx, r, now, loads, roles);
  // Leads seated in different folders of one checkout share its pool: count each pool, and each runner's own machine, once.
  const distinct = new Map([...loads.values()].map((l) => [l.pool ? l.pool.slots.map((sl) => sl.device).sort().join(",") : `runner:${l.runner}`, l]));
  const totals = [...distinct.values()].reduce((t, l) => ({ working: t.working + l.working, cap: t.cap + l.cap }), { working: 0, cap: 0 });
  const plan = await planLiveFlow(ctx, flow, roles, now, LIVE_FLOW_SHOWN, loads);
  const running: string[] = [];
  for (const r of team) {
    for (const status of WORKING_RUN_STATUSES) {
      const runs: any[] = await ctx.db.query("workflow_runs").withIndex("by_org_role_status", (q: any) => q.eq("org_role_id", r._id).eq("status", status)).collect();
      running.push(...runs.map((run) => String(run._id)));
    }
  }
  const workflow = await ctx.db.get(flow.workflow_id);
  const watcher = flow.watcher_role_id ? await ctx.db.get(flow.watcher_role_id) : null;
  const entries = plan.queue.slice(0, LIVE_FLOW_SHOWN);
  return {
    _id: String(flow._id),
    workspace: flow.workspace,
    team_id: flow.team_id ? String(flow.team_id) : null,
    flow: { id: String(flow.workflow_id), slug: workflow?.slug ?? null, label: workflow?.label ?? workflow?.name ?? "" },
    sources: flow.sources?.length ? flow.sources : null,
    on: flow.on,
    caps: { hands_per_day: flow.caps?.hands_per_day ?? null },
    hands_today: flowHands(flow, now),
    hold: flowHold(flow, now),
    bar: flow.bar ?? null,
    load: totals,
    waiting: plan.waiting,
    watcher: watcher ? { role_id: String(watcher._id), handle: watcher.handle } : null,
    changed_by: String(flow.changed_by),
    changed_at: flow.changed_at,
    client_key: flow.client_key ?? null,
    running,
    queue: entries.map((e) => ({ task_id: String(e.task._id), waiting: e.waiting })),
    entries,
  };
}

const plainRow = ({ entries: _e, ...row }: Awaited<ReturnType<typeof liveFlowView>>): LiveFlowRow => row;

async function isMember(ctx: Ctx, userId: Id<"users">, teamId: string | null | undefined): Promise<boolean> {
  if (!teamId) return false;
  return !!(await ctx.db.query("team_memberships").withIndex("by_user_team", (q: any) => q.eq("user_id", userId).eq("team_id", teamId)).first());
}

/** The live flows a member of `team_id` reads (the web's liveFlows collection); [] for anyone else. */
export const forTeam = query({
  args: { team_id: v.id("teams") },
  handler: async (ctx, { team_id }): Promise<LiveFlowRow[]> => {
    const userId = await getAuthUserId(ctx as any);
    if (!userId || !(await isMember(ctx, userId, team_id))) return [];
    // Read by the workspace key, never team_id: team_id routes and grants nothing.
    const flows: any[] = await ctx.db.query("live_flows").withIndex("by_workspace", (q: any) => q.eq("workspace", `team:${team_id}`)).collect();
    const now = Date.now();
    return Promise.all(flows.map(async (f) => plainRow(await liveFlowView(ctx, f, now))));
  },
});

/** Switches a live flow on or off: a team admin's act, since it starts or stops the team's runs. */
export async function setOnCore(ctx: Ctx, userId: Id<"users">, flow: any, on: boolean, now = Date.now()): Promise<void> {
  if (!flow || !(await isMember(ctx, userId, flow.team_id))) throw new ConvexError("no such live flow");
  await requireTeamAdmin(ctx as any, userId, flow.team_id);
  if (flow.on !== on) await ctx.db.patch(flow._id, { on, changed_by: userId, changed_at: now });
}

/** The web's switch: a person signed in, never an API token (the web turns it on through the confirm flow). */
export const setOn = mutation({
  args: { id: v.id("live_flows"), on: v.boolean() },
  handler: async (ctx, { id, on }) => {
    const userId = await getAuthUserId(ctx as any);
    if (!userId) throw new ConvexError("Sign in to switch a live flow");
    await setOnCore(ctx, userId, await ctx.db.get(id), on);
  },
});

// A team's live flows for the CLI, the team named by id (the CLI resolves
// --team); null for no team, which is the personal workspace and has none.
async function teamFlows(ctx: Ctx, userId: Id<"users">, teamId?: string): Promise<any[] | null> {
  const team = teamId ? ctx.db.normalizeId("teams", teamId) : null;
  if (!team || !(await isMember(ctx, userId, team))) return null;
  return ctx.db.query("live_flows").withIndex("by_team", (q: any) => q.eq("team_id", team)).collect();
}

// One of them by the flow's slug, its label, its workflow id or the live
// flow's own id; omitted, the team's one live flow.
async function pickFlow(ctx: Ctx, flows: any[], ref?: string): Promise<any> {
  const want = ref?.trim();
  if (!want) {
    if (flows.length === 1) return flows[0];
    throw new ConvexError(flows.length ? `The team has ${flows.length} live flows: name one by its slug` : "The team has no live flow");
  }
  for (const f of flows) {
    const wf = await ctx.db.get(f.workflow_id);
    if ([String(f._id), String(f.workflow_id), wf?.slug, wf?.label, wf?.name].includes(want)) return f;
  }
  throw new ConvexError(`No live flow of the team runs "${want}" (looked for a flow slug, label or id, or a live flow id)`);
}

async function cliRow(ctx: Ctx, flow: any) {
  const view = await liveFlowView(ctx, flow);
  return {
    ...plainRow(view),
    queue: view.entries.map((e) => ({
      task_id: String(e.task._id),
      short_id: e.task.short_id ?? null,
      title: e.task.cause?.named?.name ?? e.task.title,
      score: startValue(e.task),
      scored: !!e.task.cause?.scored,
      findings: e.task.cause?.signal_count ?? 0,
      family: e.task.cause?.scored?.cluster_name ?? null,
      area: e.role ? { role_id: String(e.role._id), handle: e.role.handle } : null,
      waiting: e.waiting,
    })),
  };
}

/** `cast flow show` on live flows: the team's, or null when it has none (and for the personal workspace). */
export const showFromCli = query({
  args: { api_token: v.string(), team_id: v.optional(v.string()), flow: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token, false);
    if (!auth) throw new ConvexError("Unauthorized");
    const flows = await teamFlows(ctx, auth.userId, args.team_id);
    if (!flows?.length) return null;
    return Promise.all((args.flow ? [await pickFlow(ctx, flows, args.flow)] : flows).map((f) => cliRow(ctx, f)));
  },
});

/**
 * `cast flow on|off`: a person's act, and a token cannot tell a person from an
 * agent, so every CLI call is refused with where a person switches it. The
 * flow is resolved first, so a wrong name gets its own error.
 */
export const setOnFromCli = mutation({
  args: { api_token: v.string(), from_session: v.optional(v.string()), on: v.boolean(), team_id: v.optional(v.string()), flow: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token, false);
    if (!auth) throw new ConvexError("Unauthorized");
    const flows = await teamFlows(ctx, auth.userId, args.team_id);
    if (!flows) throw new ConvexError("Your personal workspace has no live flow: name a team");
    await pickFlow(ctx, flows, args.flow);
    throw new ConvexError(`A person switches a live flow ${args.on ? "on" : "off"}, from the Flows page in the browser; no CLI call or agent session may.`);
  },
});

/** The longest a hold may stand: it waits out a reset, never a person's call. */
export const MAX_HOLD_MS = 48 * 3_600_000;

/**
 * Holds a live flow until `until` for `why`: its admission starts nothing
 * meanwhile, and the flow says why. A second hold keeps the later end and
 * the newest reason.
 */
export async function holdCore(ctx: Ctx, flow: any, o: { why: string; until: number; by: string }, now = Date.now()) {
  const why = o.why.trim().replace(/\s+/g, " ");
  if (!why) throw new ConvexError("Say why the live flow holds");
  if (why.length > 300) throw new ConvexError("Keep the hold's reason under 300 characters");
  if (!(o.until > now)) throw new ConvexError("A hold ends in the future");
  if (o.until - now > MAX_HOLD_MS) throw new ConvexError("A hold lasts at most 48 hours; a longer stop is a person's, with the switch");
  const standing = flowHold(flow, now);
  const hold = { why, until: Math.max(o.until, standing?.until ?? 0), by: o.by, at: now };
  await ctx.db.patch(flow._id, { hold });
  return hold;
}

/** Clears a live flow's hold: a team admin's, as the switch is. */
export async function clearHoldCore(ctx: Ctx, userId: Id<"users">, flow: any): Promise<void> {
  if (!flow || !(await isMember(ctx, userId, flow.team_id))) throw new ConvexError("no such live flow");
  await requireTeamAdmin(ctx as any, userId, flow.team_id);
  if (flow.hold) await ctx.db.patch(flow._id, { hold: undefined });
}

export const clearHold = mutation({
  args: { id: v.id("live_flows") },
  handler: async (ctx, { id }) => {
    const userId = await getAuthUserId(ctx as any);
    if (!userId) throw new ConvexError("Sign in to clear a live flow's hold");
    await clearHoldCore(ctx, userId, await ctx.db.get(id));
  },
});

/**
 * Sets a live flow's bar, or takes it off (`bar` null): a team admin's act,
 * since it decides which problems the team's machines spend runs on. A lower
 * bar admits more at the next sweep; a higher one starts fewer and closes
 * nothing by itself.
 */
export async function setBarCore(ctx: Ctx, userId: Id<"users">, flow: any, bar: FlowBar | null, by: string, now = Date.now()) {
  if (!flow || !(await isMember(ctx, userId, flow.team_id))) throw new ConvexError("no such live flow");
  await requireTeamAdmin(ctx as any, userId, flow.team_id);
  if (!bar) {
    if (flow.bar) await ctx.db.patch(flow._id, { bar: undefined });
    return null;
  }
  const whole = (n: number, lo: number, hi: number, what: string) => {
    if (!Number.isInteger(n) || n < lo || n > hi) throw new ConvexError(`${what} is a whole number from ${lo} to ${hi}`);
  };
  whole(bar.score, 0, 100, "The bar's score");
  whole(bar.findings, 1, 1000, "The bar's findings");
  whole(bar.quiet_days, 1, 365, "The days a waiting problem stays open");
  const next = { score: bar.score, findings: bar.findings, quiet_days: bar.quiet_days, by, at: now };
  await ctx.db.patch(flow._id, { bar: next });
  return next;
}

const barArgs = { score: v.number(), findings: v.number(), quiet_days: v.number() };

/** The web's bar control: a signed-in team admin. */
export const setBar = mutation({
  args: { id: v.id("live_flows"), bar: v.union(v.object(barArgs), v.null()) },
  handler: async (ctx, { id, bar }) => {
    const userId = await getAuthUserId(ctx as any);
    if (!userId) throw new ConvexError("Sign in to set a live flow's bar");
    return setBarCore(ctx, userId, await ctx.db.get(id), bar, `user:${userId}`);
  },
});

/** `cast flow bar`: a team admin sets the bar, or takes it off with `off`. */
export const barFromCli = mutation({
  args: { api_token: v.string(), from_session: v.optional(v.string()), team_id: v.optional(v.string()), flow: v.optional(v.string()), off: v.optional(v.boolean()), ...barArgs },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token, false);
    if (!auth) throw new ConvexError("Unauthorized");
    const flows = await teamFlows(ctx, auth.userId, args.team_id);
    if (!flows) throw new ConvexError("Your personal workspace has no live flow: name a team");
    const flow = await pickFlow(ctx, flows, args.flow);
    const from = args.from_session;
    const conv: any = from && !SESSION_SHORT_ID_RE.test(from) ? await resolveSessionConversation(ctx as any, auth.userId, from) : null;
    const by = from && SESSION_SHORT_ID_RE.test(from) ? from : conv?.short_id ?? `user:${auth.userId}`;
    const bar = await setBarCore(ctx, auth.userId, flow, args.off ? null : { score: args.score, findings: args.findings, quiet_days: args.quiet_days }, by);
    return { _id: String(flow._id), bar, words: bar ? barWords(bar) : null };
  },
});

/**
 * `cast flow hold <until> "<why>"`: a hand that meets a wait no person has to
 * answer (a spent budget until it rolls over), or the flow's watcher, holds
 * the flow so it stops starting runs that would park on the same wait.
 */
export const holdFromCli = mutation({
  args: { api_token: v.string(), from_session: v.optional(v.string()), team_id: v.optional(v.string()), flow: v.optional(v.string()), why: v.string(), until: v.number() },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token, false);
    if (!auth) throw new ConvexError("Unauthorized");
    const flows = await teamFlows(ctx, auth.userId, args.team_id);
    if (!flows) throw new ConvexError("Your personal workspace has no live flow: name a team");
    const flow = await pickFlow(ctx, flows, args.flow);
    // The hold names its session by short id, the way every surface shows one; a session the caller cannot read names its user.
    const from = args.from_session;
    const conv: any = from && !SESSION_SHORT_ID_RE.test(from) ? await resolveSessionConversation(ctx as any, auth.userId, from) : null;
    const by = from && SESSION_SHORT_ID_RE.test(from) ? from : conv?.short_id ?? `user:${auth.userId}`;
    const hold = await holdCore(ctx, flow, { why: args.why, until: args.until, by });
    return { _id: String(flow._id), hold, waiting: holdWords(hold) };
  },
});

/**
 * A team's live flow on a library flow. Its switch is a person's, so it
 * starts in the state people left the leads' lines in: on when any active
 * lead's line was on, off otherwise, and the row names those lines. The row
 * is also what stops each lead admitting on its own (orgLine.planSweep), so
 * one commit moves admission over and nothing pauses between. Refused when
 * the team has one.
 */
export async function createLiveFlowCore(ctx: Ctx, args: { team_id: Id<"teams">; workflow_id: Id<"workflows">; by: Id<"users">; sources?: string[]; watcher_role_id?: Id<"org_roles">; client_key?: string }, now = Date.now()) {
  if (await liveFlowFor(ctx, args.team_id)) throw new ConvexError("the team already has a live flow");
  const roles: any[] = await ctx.db.query("org_roles").collect();
  const linesOn = flowRoles({ team_id: args.team_id }, roles).filter((r) => r.status === "active" && lineStartsOn(r)).map((r) => r.handle as string).sort();
  const id = await ctx.db.insert("live_flows", {
    workspace: `team:${args.team_id}`,
    team_id: args.team_id,
    workflow_id: args.workflow_id,
    ...(args.sources?.length ? { sources: args.sources } : {}),
    ...(args.watcher_role_id ? { watcher_role_id: args.watcher_role_id } : {}),
    ...(args.client_key ? { client_key: args.client_key } : {}),
    on: linesOn.length > 0,
    carried_lines_on: linesOn,
    changed_by: args.by,
    changed_at: now,
    created_at: now,
  });
  console.log(`live flow ${id} for team ${args.team_id}: ${linesOn.length ? `on, carried from the lines of ${linesOn.map((h) => "@" + h).join(", ")}` : "off, no lead's line was on"}; its leads admit nothing on their own from now`);
  return { id: String(id), on: linesOn.length > 0, carried_lines_on: linesOn };
}

/** The web's start (the Flows stage of a team with none): a team admin makes one of the team's library flows its live
 *  flow, on the same terms as createLiveFlowCore. Dispatch runs it as the signed-in person only. */
export async function startLiveFlowCore(ctx: Ctx, userId: Id<"users">, args: { team_id: string; workflow_id: string; client_key?: string }) {
  const team = ctx.db.normalizeId("teams", args.team_id);
  const workflow = ctx.db.normalizeId("workflows", args.workflow_id);
  if (!team || !(await isMember(ctx, userId, team))) throw new ConvexError("no such team");
  await requireTeamAdmin(ctx as any, userId, team);
  const wf: any = workflow ? await ctx.db.get(workflow) : null;
  if (!wf || (wf.team_id && String(wf.team_id) !== String(team))) throw new ConvexError("that flow is not in the team's library");
  return createLiveFlowCore(ctx, { team_id: team, workflow_id: wf._id, by: userId, ...(args.client_key ? { client_key: args.client_key } : {}) });
}

export const create = internalMutation({
  args: { team_id: v.id("teams"), workflow_id: v.id("workflows"), by: v.id("users"), sources: v.optional(v.array(v.string())), watcher_role_id: v.optional(v.id("org_roles")) },
  handler: async (ctx, args) => createLiveFlowCore(ctx, args),
});
