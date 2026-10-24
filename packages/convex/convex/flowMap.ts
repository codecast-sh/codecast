// The flow map (the Flows page's Signals and Flows stages): every source of a
// workspace's problems, the lanes of its live flow, and where the problems
// stand (shared/contracts/flowMap.ts names the shape and its readings).
//
// Two halves. What changes by the second (the live flow's switch, its runs at
// each step, decisions waiting, causes under watch, the sources and watches
// themselves) is read live in forTeam. What would mean reading every finding
// and problem (counts per day, outcomes, escapes, open groups no problem took)
// comes from flow_map_rollups, which the hourly `rollup` pass writes per
// workspace with a live flow: it recounts yesterday and today and keeps the
// older days of its last row, so a pass reads two days of findings, not
// fourteen.
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internalAction, internalMutation, internalQuery, query } from "./functions";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  DAY_MS, FLOW_MAP_DAYS, FLOW_MAP_ESCAPE_DAYS, FLOW_MAP_OUTCOME_DAYS, STALLED_MS, emptyOutcomes, normalDay, problemOutcome, sourceState, utcDayKey, windowDays,
  type FlowMap, type FlowMapLane, type FlowMapOutcomes, type FlowMapSource, type FlowMapStep,
} from "@codecast/shared/contracts/flowMap";
import { JUDGE_CASE_SOURCE } from "@codecast/shared/contracts/judgeReview";
import { flowFamily, flowRouteFor, type FlowRouteRow } from "./lib/flowRoute";
import { eventSourceWords, sourceWords } from "./lib/flowMapLabels";
import { flowHands, flowHold } from "./liveFlows";
import { flowMapOutcomesValidator } from "./flowMapSchema";
import { runsWaitingOnAPerson } from "./lib/linePlacement";

type Ctx = { db: any };

/** The transition that files a group of each kind. */
const GROUP_TRANSITION: Record<string, string> = { error: "new", log: "new", replay_issue: "new", job: "job_failed", check: "check_failed", metric: "metric_alert" };
/** The transitions that say something broke: the ones a source could file as problems. */
const PROBLEM_TRANSITIONS = new Set(["new", "regressed", "check_failed", "job_failed", "metric_alert"]);
/** An ingest event's kind is its trigger name (transitionTriggerEvent): "error_new" was transition "new". */
export const eventTransition = (kind: string) => kind.replace(/^error_/, "");
const OPEN_STATUSES = new Set(["open", "in_progress", "in_review"]);
const PROBLEM_STATUSES = ["open", "in_progress", "in_review", "done", "dropped"] as const;
const LIVE_RUN_STATUSES = ["pending", "running", "paused"] as const;
const dayStart = (at: number) => Date.parse(`${utcDayKey(at)}T00:00:00Z`);

// ── reading a workspace ────────────────────────────────────────────────────

/** Whether the viewer reads this workspace: a member of its team, or its owner. */
async function canRead(ctx: Ctx, userId: string, workspace: string): Promise<boolean> {
  if (workspace === `user:${userId}`) return true;
  if (!workspace.startsWith("team:")) return false;
  const team = ctx.db.normalizeId ? ctx.db.normalizeId("teams", workspace.slice(5)) : workspace.slice(5);
  if (!team) return false;
  return !!(await ctx.db.query("team_memberships").withIndex("by_user_team", (q: any) => q.eq("user_id", userId).eq("team_id", team)).first());
}

/** The workspace's live flow, its spine, its flows, and the spine's family. */
async function flowSetup(ctx: Ctx, workspace: string) {
  const flow = await ctx.db.query("live_flows").withIndex("by_workspace", (q: any) => q.eq("workspace", workspace)).first();
  const spine = flow ? await ctx.db.get(flow.workflow_id) : null;
  const rows: any[] = await ctx.db.query("workflows").withIndex("by_workspace", (q: any) => q.eq("workspace", workspace)).collect();
  const family: any[] = spine ? flowFamily<any>(spine, rows) : [];
  return { flow, spine, rows, family };
}

/** The lane a source's problems take: a family member's slug, "off" when they run outside the live flow. */
export function routeOf(setup: { flow: any; spine: any; rows: any[] }, source: string): string {
  const { flow, spine, rows } = setup;
  if (flow?.sources?.length && !flow.sources.includes(source)) return "off";
  const route = flowRouteFor<FlowRouteRow>({ flow, spine, rows, source, judge: source === JUDGE_CASE_SOURCE });
  return route?.workflow?.slug ?? "off";
}

/** A problem's source: its first finding's, as the route reads it. */
async function problemSource(ctx: Ctx, taskId: string): Promise<string | null> {
  const first = await ctx.db.query("signals").withIndex("by_task", (q: any) => q.eq("task_id", taskId)).order("asc").first();
  return first?.source?.trim().toLowerCase() ?? null;
}

// ── the rollup's pages (each one bounded read) ─────────────────────────────

/** The workspaces the pass rolls up: every one with a live flow. */
export const rollupTargets = internalQuery({
  args: {},
  handler: async (ctx): Promise<string[]> => [...new Set(((await ctx.db.query("live_flows").collect()) as any[]).map((f) => f.workspace))],
});

export const rollupRow = internalQuery({
  args: { workspace: v.string() },
  handler: async (ctx, { workspace }) => ctx.db.query("flow_map_rollups").withIndex("by_workspace", (q: any) => q.eq("workspace", workspace)).first(),
});

/** One page of a workspace's findings since `since`, folded: per source and day, the newest, and the problems a finding reopened. */
export const findingsPage = internalQuery({
  args: { workspace: v.string(), since: v.number(), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, args) => {
    const page = await ctx.db.query("signals").withIndex("by_workspace_created", (q: any) => q.eq("workspace", args.workspace).gte("created_at", args.since)).paginate({ cursor: args.cursor, numItems: 1000 });
    return { ...foldFindings(page.page), cursor: page.isDone ? null : page.continueCursor };
  },
});

export function foldFindings(rows: ReadonlyArray<{ source: string; created_at: number; reopened?: boolean; task_id?: string }>) {
  const counts = new Map<string, { source: string; day: string; n: number; last_at: number }>();
  const reopened = new Map<string, number>();
  for (const s of rows) {
    const source = s.source.trim().toLowerCase();
    const day = utcDayKey(s.created_at);
    const c = counts.get(`${source}\u0000${day}`) ?? { source, day, n: 0, last_at: 0 };
    c.n++;
    c.last_at = Math.max(c.last_at, s.created_at);
    counts.set(`${source}\u0000${day}`, c);
    if (s.reopened && s.task_id) reopened.set(String(s.task_id), Math.max(reopened.get(String(s.task_id)) ?? 0, s.created_at));
  }
  return { counts: [...counts.values()], reopened: [...reopened].map(([task_id, at]) => ({ task_id, at })) };
}

/** One page of a workspace's problems of one status: the open counts, and the outcome of each opened since `since`, by its source. */
export const problemsPage = internalQuery({
  args: { workspace: v.string(), status: v.string(), since: v.number(), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, args) => {
    const page = await ctx.db.query("tasks").withIndex("by_workspace_source_status", (q: any) => q.eq("workspace", args.workspace).eq("source", "signal").eq("status", args.status)).paginate({ cursor: args.cursor, numItems: 150 });
    let open = 0, scored = 0, queued = 0;
    const outcomes: Array<{ source: string; outcome: string }> = [];
    for (const t of page.page as any[]) {
      if (t.ephemeral || t.cause?.merged_into) continue;
      if (OPEN_STATUSES.has(t.status)) {
        open++;
        if (t.cause?.scored) scored++;
        if (t.status === "open" && !t.workflow_run_id && t.readiness === "ready") queued++;
      }
      if (t.created_at < args.since) continue;
      const run: any = t.workflow_run_id ? await ctx.db.get(t.workflow_run_id) : null;
      const outcome = problemOutcome(t, run);
      // A problem with no finding left on it has no source to count under.
      const source = outcome ? await problemSource(ctx, t._id) : null;
      if (outcome && source) outcomes.push({ source, outcome });
    }
    return { open, scored, queued, outcomes, cursor: page.isDone ? null : page.continueCursor };
  },
});

/** Problem runs started since `since` on a flow outside the live flow's family, by source. */
export const escapesInputs = internalQuery({
  args: { workspace: v.string(), since: v.number() },
  handler: async (ctx, { workspace, since }) => {
    const { family } = await flowSetup(ctx, workspace);
    const members = new Set(family.map((w) => String(w._id)));
    const runs: any[] = await ctx.db.query("workflow_runs").withIndex("by_workspace_updated", (q: any) => q.eq("workspace", workspace).gte("updated_at", since)).collect();
    const out: Record<string, number> = {};
    for (const r of runs) {
      if (!r.task_id || r.created_at < since || (r.workflow_id && members.has(String(r.workflow_id)))) continue;
      const source = await problemSource(ctx, r.task_id);
      if (source) out[source] = (out[source] ?? 0) + 1;
    }
    return out;
  },
});

/** Each event source's events per transition and day since `since`, and its open groups no problem took, by the transition that would file them. */
export const eventsInputs = internalQuery({
  args: { workspace: v.string(), since: v.number() },
  handler: async (ctx, { workspace, since }) => {
    const sources: any[] = await ctx.db.query("event_sources").withIndex("by_workspace_name", (q: any) => q.eq("workspace", workspace)).collect();
    const out: Array<{ source_id: Id<"event_sources">; transition: string; days: Array<{ day: string; n: number }>; last_at?: number; unfiled: number }> = [];
    for (const src of sources) {
      const rows = new Map<string, { days: Map<string, number>; last_at?: number; unfiled: number }>();
      const row = (t: string) => rows.get(t) ?? rows.set(t, { days: new Map(), unfiled: 0 }).get(t)!;
      const events: any[] = await ctx.db.query("external_events").withIndex("by_source_created", (q: any) => q.eq("source_id", src._id).gte("created_at", since)).collect();
      for (const e of events) {
        const t = eventTransition(String(e.kind));
        if (!PROBLEM_TRANSITIONS.has(t)) continue;
        const r = row(t);
        const day = utcDayKey(e.created_at);
        r.days.set(day, (r.days.get(day) ?? 0) + 1);
        r.last_at = Math.max(r.last_at ?? 0, e.created_at);
      }
      const groups: any[] = await ctx.db.query("event_groups").withIndex("by_source_status_last_seen", (q: any) => q.eq("source_id", src._id).eq("status", "open")).collect();
      for (const g of groups) if (!g.signal_task_id && GROUP_TRANSITION[g.kind]) row(GROUP_TRANSITION[g.kind]).unfiled++;
      for (const [transition, r] of rows) out.push({ source_id: src._id, transition, days: [...r.days].map(([day, n]) => ({ day, n })), ...(r.last_at ? { last_at: r.last_at } : {}), unfiled: r.unfiled });
    }
    return out;
  },
});

const rollupArgs = {
  workspace: v.string(),
  rolled_at: v.number(),
  sources: v.array(v.object({ key: v.string(), days: v.array(v.object({ day: v.string(), n: v.number() })), last_at: v.optional(v.number()), outcomes: flowMapOutcomesValidator, escapes: v.number() })),
  events: v.array(v.object({ source_id: v.id("event_sources"), transition: v.string(), days: v.array(v.object({ day: v.string(), n: v.number() })), last_at: v.optional(v.number()), unfiled: v.number() })),
  problems_open: v.number(),
  problems_scored: v.number(),
  queued: v.number(),
  reopened: v.array(v.object({ task_id: v.string(), at: v.number() })),
};

export const writeRollup = internalMutation({
  args: rollupArgs,
  handler: async (ctx, row) => {
    const prev = await ctx.db.query("flow_map_rollups").withIndex("by_workspace", (q: any) => q.eq("workspace", row.workspace)).first();
    if (prev) await ctx.db.replace(prev._id, row);
    else await ctx.db.insert("flow_map_rollups", row);
  },
});

type RollupRow = { [K in keyof typeof rollupArgs]: any };

/**
 * The days a pass keeps from the last row and the ones it recounts: a new
 * row counts the whole window; after that, yesterday (a late finding still
 * lands in it) and today.
 */
export function recountFrom(prev: { rolled_at: number } | null | undefined, now: number): number {
  const windowStart = dayStart(now - (FLOW_MAP_DAYS - 1) * DAY_MS);
  return prev && now - prev.rolled_at < 2 * DAY_MS ? dayStart(now - DAY_MS) : windowStart;
}

/**
 * Folds one pass's pages into the row: findings counted since `from`, the
 * older days of `prev` kept, every day outside the window dropped; outcomes
 * and escapes are this pass's alone.
 */
export function foldRollup(o: {
  workspace: string; now: number; from: number; prev?: { sources: RollupRow["sources"]; reopened?: RollupRow["reopened"] } | null;
  counts: Array<{ source: string; day: string; n: number; last_at: number }>;
  reopened: Array<{ task_id: string; at: number }>;
  outcomes: Array<{ source: string; outcome: string }>;
  escapes: Record<string, number>;
}): Pick<RollupRow, "sources" | "reopened"> {
  const window = new Set(windowDays(o.now));
  const fromDay = utcDayKey(o.from);
  const by = new Map<string, { days: Map<string, number>; last_at?: number; outcomes: FlowMapOutcomes; escapes: number }>();
  const row = (k: string) => by.get(k) ?? by.set(k, { days: new Map(), outcomes: emptyOutcomes(), escapes: 0 }).get(k)!;
  for (const p of o.prev?.sources ?? []) {
    const kept = (p.days as Array<{ day: string; n: number }>).filter((d) => d.day < fromDay && window.has(d.day));
    if (!kept.length && p.last_at == null) continue;
    const r = row(p.key);
    for (const d of kept) r.days.set(d.day, d.n);
    if (p.last_at != null) r.last_at = p.last_at;
  }
  for (const c of o.counts) {
    if (!window.has(c.day)) continue;
    const r = row(c.source);
    r.days.set(c.day, (r.days.get(c.day) ?? 0) + c.n);
    r.last_at = Math.max(r.last_at ?? 0, c.last_at);
  }
  for (const x of o.outcomes) {
    const r = row(x.source);
    (r.outcomes as any)[x.outcome]++;
    r.outcomes.total++;
  }
  for (const [k, n] of Object.entries(o.escapes)) row(k).escapes = n;
  const windowStart = dayStart(o.now - (FLOW_MAP_DAYS - 1) * DAY_MS);
  const reopened = new Map<string, number>();
  for (const x of [...(o.prev?.reopened ?? []).filter((x: any) => x.at < o.from), ...o.reopened]) if (x.at >= windowStart) reopened.set(x.task_id, Math.max(reopened.get(x.task_id) ?? 0, x.at));
  return {
    reopened: [...reopened].map(([task_id, at]) => ({ task_id, at })),
    sources: [...by].map(([key, r]) => ({ key, days: [...r.days].sort(([a], [b]) => a.localeCompare(b)).map(([day, n]) => ({ day, n })), ...(r.last_at ? { last_at: r.last_at } : {}), outcomes: r.outcomes, escapes: r.escapes })),
  };
}

async function rollupWorkspace(ctx: any, workspace: string, now: number): Promise<void> {
  const prev = await ctx.runQuery((internal as any).flowMap.rollupRow, { workspace });
  const from = recountFrom(prev, now);
  const counts: Array<{ source: string; day: string; n: number; last_at: number }> = [];
  const reopened: Array<{ task_id: string; at: number }> = [];
  let cursor: string | null = null;
  do {
    const page: any = await ctx.runQuery((internal as any).flowMap.findingsPage, { workspace, since: from, cursor });
    counts.push(...page.counts);
    reopened.push(...page.reopened);
    cursor = page.cursor;
  } while (cursor);
  const outcomes: Array<{ source: string; outcome: string }> = [];
  let open = 0, scored = 0, queued = 0;
  const since = now - FLOW_MAP_OUTCOME_DAYS * DAY_MS;
  for (const status of PROBLEM_STATUSES) {
    cursor = null;
    do {
      const page: any = await ctx.runQuery((internal as any).flowMap.problemsPage, { workspace, status, since, cursor });
      open += page.open;
      scored += page.scored;
      queued += page.queued;
      outcomes.push(...page.outcomes);
      cursor = page.cursor;
    } while (cursor);
  }
  const escapes = await ctx.runQuery((internal as any).flowMap.escapesInputs, { workspace, since: now - FLOW_MAP_ESCAPE_DAYS * DAY_MS });
  const events = await ctx.runQuery((internal as any).flowMap.eventsInputs, { workspace, since: dayStart(now - (FLOW_MAP_DAYS - 1) * DAY_MS) });
  const folded = foldRollup({ workspace, now, from, prev, counts, reopened, outcomes, escapes });
  await ctx.runMutation((internal as any).flowMap.writeRollup, { workspace, rolled_at: now, ...folded, events, problems_open: open, problems_scored: scored, queued });
}

/** The hourly pass (crons.ts), or one workspace by hand: `run.sh flowMap:rollup '{"workspace":"team:..."}'`. */
export const rollup = internalAction({
  args: { workspace: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ workspaces: number }> => {
    const targets: string[] = args.workspace ? [args.workspace] : await ctx.runQuery((internal as any).flowMap.rollupTargets, {});
    for (const ws of targets) await rollupWorkspace(ctx, ws, Date.now());
    return { workspaces: targets.length };
  },
});

// ── the view ───────────────────────────────────────────────────────────────

const daysArray = (days: ReadonlyArray<{ day: string; n: number }>, keys: string[]) => {
  const m = new Map(days.map((d) => [d.day, d.n]));
  return keys.map((k) => m.get(k) ?? 0);
};

/** A graph's stations a lane shows: the ones agents and people work at, in graph order. */
const isWorkStation = (n: { type?: string }) => n.type === "agent" || n.type === "human" || n.type === "prompt";

type StepCount = { running: number; stalled: number; waiting: number };
const zeroStep = (): StepCount => ({ running: 0, stalled: 0, waiting: 0 });
/** A live run waits on a person when it is paused at a card, a blocking decision of its runner names it, or its task
 *  holds a wait (task-graph.md TG2): those are never stalled, however long they sit. */
function countRun(c: StepCount, r: any, now: number, waiting: boolean) {
  if (waiting) c.waiting++;
  else {
    c.running++;
    if (now - (r.updated_at ?? r.created_at ?? 0) > STALLED_MS) c.stalled++;
  }
}

function stepsOf(nodes: ReadonlyArray<{ id: string; label?: string; type?: string }>, live: Map<string, StepCount>): FlowMapStep[] {
  const steps = nodes.filter((n) => isWorkStation(n) || live.has(n.id)).map((n) => ({ id: n.id, label: n.label || n.id, ...(live.get(n.id) ?? zeroStep()) }));
  // A run standing at a station its graph no longer has still shows.
  for (const [id, c] of live) if (!steps.some((s) => s.id === id)) steps.push({ id, label: id, ...c });
  return steps;
}


/** The flow map of one workspace, as the viewer reads it. */
export async function flowMapView(ctx: Ctx, workspace: string, viewer: string, now = Date.now()): Promise<FlowMap> {
  const setup = await flowSetup(ctx, workspace);
  const { flow, spine, family } = setup;
  const members = new Map(family.map((w) => [String(w._id), w]));

  // Live runs, at the station each stands at: a family member's, or off the flow.
  const lanesLive = new Map<string, Map<string, StepCount>>();
  const offLive = new Map<string, StepCount & { label: string }>();
  const flowTotal = zeroStep(), offTotal = zeroStep();
  const live: any[] = [];
  for (const status of LIVE_RUN_STATUSES) {
    for (const r of (await ctx.db.query("workflow_runs").withIndex("by_status", (q: any) => q.eq("status", status)).collect()) as any[]) if (r.workspace === workspace) live.push(r);
  }
  const askedOf = new Set<string>();
  for (const runner of new Set(live.map((r) => String(r.user_id)))) for (const id of await runsWaitingOnAPerson(ctx, runner)) askedOf.add(id);
  const waitsOnAPerson = async (r: any) => r.status === "paused" || askedOf.has(String(r._id)) || (r.task_id ? !!((await ctx.db.get(r.task_id)) as any)?.waiting_since : false);
  for (const r of live) {
    const node = r.current_node_id ?? "start";
    const waiting = await waitsOnAPerson(r);
    const member = r.workflow_id ? members.get(String(r.workflow_id)) : null;
    if (member) {
      const m = lanesLive.get(String(member._id)) ?? lanesLive.set(String(member._id), new Map()).get(String(member._id))!;
      const c = m.get(node) ?? m.set(node, zeroStep()).get(node)!;
      countRun(c, r, now, waiting);
      countRun(flowTotal, r, now, waiting);
    } else if (r.task_id) {
      const c = offLive.get(node) ?? offLive.set(node, { ...zeroStep(), label: (r.graph_nodes ?? []).find((n: any) => n.id === node)?.label ?? node }).get(node)!;
      countRun(c, r, now, waiting);
      countRun(offTotal, r, now, waiting);
    }
  }

  const lanes: FlowMapLane[] = family.map((w) => ({
    key: w.slug,
    label: w.label ?? w.name,
    workflowId: String(w._id),
    kind: String(w._id) === String(spine?._id) ? "spine" : (w.serves ?? []).includes(JUDGE_CASE_SOURCE) ? "judge" : "variant",
    sources: w.serves ?? [],
    steps: stepsOf(w.nodes ?? [], lanesLive.get(String(w._id)) ?? new Map()),
  }));

  // Finished today: the family's runs that ended since midnight UTC.
  const today = dayStart(now);
  const ended: any[] = await ctx.db.query("workflow_runs").withIndex("by_workspace_updated", (q: any) => q.eq("workspace", workspace).gte("updated_at", today)).collect();
  const finishedToday = ended.filter((r) => (r.status === "completed" || r.status === "failed") && r.workflow_id && members.has(String(r.workflow_id))).length;

  const rolled = await ctx.db.query("flow_map_rollups").withIndex("by_workspace", (q: any) => q.eq("workspace", workspace)).first();
  const keys = windowDays(now);

  // What each source is called: the line profile's finder declarations, else the fallbacks.
  const projects: any[] = await ctx.db.query("projects").withIndex("by_workspace", (q: any) => q.eq("workspace", workspace)).collect();
  const finders = new Map<string, any>();
  for (const p of projects) for (const f of p.line_profile?.finders ?? []) if (f?.source && !finders.has(f.source)) finders.set(String(f.source).toLowerCase(), f);
  const eventSources: any[] = await ctx.db.query("event_sources").withIndex("by_workspace_name", (q: any) => q.eq("workspace", workspace)).collect();
  // The judges by name, and the sources they read moments from (which are no problem source of their own).
  const judges = new Map<string, string[]>();
  const momentSources = new Set<string>();
  for (const src of eventSources) {
    for (const j of (await ctx.db.query("judges").withIndex("by_source_name", (q: any) => q.eq("source_id", src._id)).collect()) as any[]) {
      judges.set(j.name, [...(judges.get(j.name) ?? []), String(j._id)]);
      momentSources.add(String(src._id));
    }
  }
  const watches: any[] = await ctx.db.query("metric_watches").withIndex("by_workspace", (q: any) => q.eq("workspace", workspace)).collect();

  const sources: FlowMapSource[] = [];
  const row = (key: string, o: { words: { label: string; what: string; group: any }; days: number[]; lastAt: number | null; stateAt?: number | null; stateDays?: number[]; route: string; outcomes?: FlowMapOutcomes; escapes?: number; unfiled?: number; broken?: boolean; opens: FlowMapSource["opens"] }) => {
    sources.push({
      key, ...o.words, state: sourceState({ lastAt: o.stateAt ?? o.lastAt, days: o.stateDays ?? o.days, now, broken: o.broken }), lastAt: o.lastAt,
      today: 0, normal: normalDay(o.days.slice(0, -1)), days: o.days, route: o.route, escapes: o.escapes ?? 0,
      outcomes: o.outcomes ?? emptyOutcomes(), unfiled: o.unfiled ?? 0, opens: o.opens,
    });
  };

  // The event sources: the kinds they promote file under one finding source; each kind they leave out is a row of its own.
  const bySignalKey = new Map(eventSources.map((s) => [`${s.provider}:${s.name}`.toLowerCase(), s]));
  const events: any[] = rolled?.events ?? [];
  const rolledSources = new Map<string, any>((rolled?.sources ?? []).map((s: any) => [s.key, s]));
  // A source that promotes but has filed nothing yet still has its row.
  for (const [key, src] of bySignalKey) if ((src.promote ?? []).length && !rolledSources.has(key) && !momentSources.has(String(src._id))) rolledSources.set(key, { key, days: [], outcomes: emptyOutcomes(), escapes: 0 });

  for (const s of rolledSources.values()) {
    const src = bySignalKey.get(s.key);
    const judgeName = s.key.startsWith("judge:") ? s.key.slice(6) : null;
    const finder = finders.get(s.key);
    const promoted = new Set<string>(src?.promote ?? []);
    const promotedEvents = src ? events.filter((e) => String(e.source_id) === String(src._id) && promoted.has(e.transition)) : [];
    // A source that has filed nothing yet: its state is its events' (it is flowing, its findings are not).
    const quietSince = s.last_at ?? (promotedEvents.length ? Math.max(0, ...promotedEvents.map((e) => e.last_at ?? 0)) || null : null);
    row(s.key, {
      words: sourceWords(s.key, finder, src),
      days: daysArray(s.days, keys), lastAt: s.last_at ?? null, stateAt: quietSince,
      stateDays: s.last_at == null && promotedEvents.length ? keys.map((k) => promotedEvents.reduce((n, e) => n + (e.days.find((d: any) => d.day === k)?.n ?? 0), 0)) : undefined, route: routeOf(setup, s.key), outcomes: s.outcomes, escapes: s.escapes,
      unfiled: promotedEvents.reduce((n, e) => n + e.unfiled, 0),
      broken: src ? src.status !== "active" : false,
      opens: { ...(src ? { eventSourceId: String(src._id) } : {}), ...(judgeName && judges.has(judgeName) ? { judgeIds: judges.get(judgeName) } : {}), ...(finder?.id ? { finderId: String(finder.id) } : {}) },
    });
  }
  for (const src of eventSources) {
    const promoted = new Set<string>(src.promote ?? []);
    const own = events.filter((e) => String(e.source_id) === String(src._id) && !promoted.has(e.transition));
    const srcWatches = watches.filter((w) => String(w.source_id) === String(src._id));
    if (srcWatches.length && !promoted.has("metric_alert") && !own.some((e) => e.transition === "metric_alert")) own.push({ transition: "metric_alert", days: [], unfiled: 0 });
    for (const e of own) {
      const alerting = e.transition === "metric_alert" ? srcWatches.filter((w) => w.state === "alert").length : 0;
      row(`${src.provider}:${src.name}:${e.transition}`.toLowerCase(), {
        words: eventSourceWords(src, e.transition),
        days: daysArray(e.days, keys), lastAt: e.last_at ?? null, route: "unfiled", unfiled: Math.max(e.unfiled, alerting), broken: src.status !== "active",
        opens: { eventSourceId: String(src._id), ...(e.transition === "metric_alert" && srcWatches.length ? { metricWatchIds: srcWatches.map((w) => String(w._id)) } : {}) },
      });
    }
  }
  // Today is the last 24 hours: the share of yesterday the clock has not passed yet, plus today so far.
  const sinceMidnight = (now - today) / DAY_MS;
  for (const s of sources) s.today = Math.round(s.days[s.days.length - 1] + (s.days[s.days.length - 2] ?? 0) * (1 - sinceMidnight));

  // Header: decisions on the workspace's runs, and causes under watch.
  let decisionsForYou = 0, decisionsForTeam = 0;
  const members_: string[] = workspace.startsWith("team:")
    ? ((await ctx.db.query("team_memberships").withIndex("by_team_id", (q: any) => q.eq("team_id", workspace.slice(5))).collect()) as any[]).map((m) => String(m.user_id))
    : [workspace.slice(5)];
  for (const uid of members_) {
    const pending: any[] = await ctx.db.query("session_decisions").withIndex("by_user_status", (q: any) => q.eq("user_id", uid).eq("status", "pending")).collect();
    // A decision names no workspace of its own: its run's says where it belongs.
    let n = 0;
    for (const d of pending) if (d.blocking && d.workflow_run_id && ((await ctx.db.get(d.workflow_run_id)) as any)?.workspace === workspace) n++;
    if (uid === viewer) decisionsForYou += n;
    else decisionsForTeam += n;
  }
  const watched: any[] = await ctx.db.query("tasks").withIndex("by_watch_until", (q: any) => q.gt("watch_until", now)).collect();
  const watching = watched.filter((t) => t.workspace === workspace).length;

  const queued = rolled?.queued ?? 0;
  return {
    workspace,
    rolledAt: rolled?.rolled_at ?? null,
    liveFlow: flow
      ? {
          id: String(flow._id), workflowId: String(flow.workflow_id), label: spine?.label ?? spine?.name ?? "", on: flow.on, hold: flowHold(flow, now),
          cap: flow.caps?.hands_per_day ?? null, handsToday: flowHands(flow, now), running: flowTotal.running, stalled: flowTotal.stalled, queued, finishedToday,
        }
      : null,
    lanes,
    off: { running: offTotal.running, stalled: offTotal.stalled, steps: [...offLive].map(([id, { label, ...c }]) => ({ id, label, ...c })) },
    sources,
    header: { problemsOpen: rolled?.problems_open ?? 0, problemsScored: rolled?.problems_scored ?? 0, decisionsForYou, decisionsForTeam, watching, regressed: rolled?.reopened?.length ?? 0 },
  };
}

/** The Flows page's map of a workspace; null for a viewer who does not read it. */
export const forTeam = query({
  args: { workspace: v.string() },
  handler: async (ctx, { workspace }): Promise<FlowMap | null> => {
    const userId = await getAuthUserId(ctx as any);
    if (!userId || !(await canRead(ctx, String(userId), workspace))) return null;
    return flowMapView(ctx, workspace, String(userId));
  },
});
