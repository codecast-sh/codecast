// The priorities sweep (crons.ts, every SWEEP_EVERY_MS): which (person,
// workspace) pairs get a pass (priorityPassRun.ts runPass). The cron reads the
// teams in pages and fans out one sweep per team with the feature on, so no
// one read covers every team; each team's sweep probes its members' pairs
// within its own caps.

import { v } from "convex/values";
import { internalAction, internalQuery } from "./functions";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { sessionVisibility, type SessionVisibility } from "./lib/prioritySessionVisibility";
import { teamHasFeature } from "./lib/teamFeatureGuard";
import { PRIORITY_PASS_CAPS } from "./lib/priorityPass";
import { LATE_MARGIN_MS, RESERVATION_TTL_MS, activitySince, cursorFor, cursorState, inWorkspace, livePriorities } from "./priorityPassInputs";

/** (person, workspace) pairs one team's sweep runs; the rest wait for the next sweep. */
export const SWEEP_MAX_PAIRS = 40;
/** The sweep runs on the hour every three hours UTC (crons.ts), so when the next one runs is known. */
export const SWEEP_EVERY_MS = 3 * 60 * 60_000;
export const nextSweepAt = (now: number) => Math.floor(now / SWEEP_EVERY_MS) * SWEEP_EVERY_MS + SWEEP_EVERY_MS;
/**
 * A team's sweep looks for strays among a pair's newest SWEEP_STRAY_PER_PAIR
 * priorities, a few sessions each (the pass reads as many), and among
 * SWEEP_STRAY_BUDGET priorities in all, so pairs with many quiet priorities
 * cannot use up the probe before the others are looked at.
 */
export const SWEEP_STRAY_PER_PAIR = 25;
export const SWEEP_STRAY_BUDGET = 200;
/** Teams one page of the cron's read holds, and members one team's sweep reads. */
export const SWEEP_TEAMS_PAGE = 200;
const SWEEP_MEMBERS_READ = 500;
/** A member's teams read to pick which team's sweep runs their personal pair. */
const MEMBER_TEAMS_READ = 50;
const SWEEP_STAGGER_MS = 5_000;
/** Typed messages and pins a sweep reads per pair to see whether anything moved there. */
const SWEEP_ACTIVITY_READ = 300;
// Codegen catches up on the next push.
const self = (internal as any).priorityPassSweep;
const run = (internal as any).priorityPassRun;

type Pair = { user_id: Id<"users">; workspace: string };

/**
 * When a person's pass in a workspace runs, for the list: how far its cursor
 * lags now (null before any run settled), and the next pass (now while one is
 * running, else the next sweep).
 */
export async function passTiming(ctx: { db: any }, userId: Id<"users">, workspace: string, now: number): Promise<{ behind_by_ms: number | null; next_pass_at: number }> {
  const state = await cursorState(ctx, userId, workspace);
  const latest: Doc<"priority_pass_runs"> | null = await ctx.db
    .query("priority_pass_runs")
    .withIndex("by_user_workspace_started", (q: any) => q.eq("user_id", userId).eq("workspace", workspace))
    .order("desc")
    .first();
  const running = latest?.status === "running" && latest.started_at > now - RESERVATION_TTL_MS;
  return { behind_by_ms: state ? Math.max(0, now - state.cursor_at) : null, next_pass_at: running ? now : nextSweepAt(now) };
}

const flagged = async (ctx: { db: any }, team: Doc<"teams"> | null): Promise<boolean> =>
  !!team?.features?.priorities && (await teamHasFeature(ctx, team._id, "priorities"));

/** One page of the teams, and which of them have the feature on. */
export const flaggedTeams = internalQuery({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, args): Promise<{ teams: Id<"teams">[]; cursor: string; done: boolean }> => {
    const page = await ctx.db.query("teams").paginate({ cursor: args.cursor, numItems: SWEEP_TEAMS_PAGE });
    const teams: Id<"teams">[] = [];
    for (const team of page.page) if (await flagged(ctx, team)) teams.push(team._id);
    return { teams, cursor: page.continueCursor, done: page.isDone };
  },
});

/**
 * The pairs one team's sweep runs: each member in the team and, when this is
 * the first of their flagged teams by id (so a person in two is swept once),
 * in their personal workspace; those with a typed message or a pin there since
 * the cursor, or more activity since then than the probe reads (the pass moves
 * the cursor past what is not its own), or with a priority that holds a
 * session since gone from the workspace or needs a rewrite, or a correction
 * no pass has read. At most SWEEP_MAX_PAIRS.
 */
export const sweepCandidates = internalQuery({
  args: { team_id: v.id("teams"), now: v.optional(v.number()) },
  handler: async (ctx, args): Promise<Pair[]> => {
    const now = args.now ?? Date.now();
    const vis = sessionVisibility(ctx);
    const isFlagged = new Map<string, Promise<boolean>>();
    const flaggedId = (id: Id<"teams">) => {
      if (!isFlagged.has(String(id))) isFlagged.set(String(id), ctx.db.get(id).then((t) => flagged(ctx, t)));
      return isFlagged.get(String(id))!;
    };
    if (!(await flaggedId(args.team_id))) return [];
    const personalHome = async (userId: Id<"users">): Promise<string | null> => {
      const teams: Id<"teams">[] = (await ctx.db.query("team_memberships").withIndex("by_user_id", (q: any) => q.eq("user_id", userId)).take(MEMBER_TEAMS_READ)).map((m) => m.team_id);
      for (const id of teams.sort((a, b) => String(a).localeCompare(String(b)))) if (await flaggedId(id)) return String(id);
      return null;
    };
    const pairs: Pair[] = [];
    for (const m of await ctx.db.query("team_memberships").withIndex("by_team_id", (q: any) => q.eq("team_id", args.team_id)).take(SWEEP_MEMBERS_READ)) {
      pairs.push({ user_id: m.user_id, workspace: `team:${args.team_id}` });
      if ((await personalHome(m.user_id)) === String(args.team_id)) pairs.push({ user_id: m.user_id, workspace: `user:${m.user_id}` });
    }
    // Longest waiting first, so a capped sweep never starves the same pairs.
    const waiting = await Promise.all(pairs.map(async (p) => ({ ...p, cursor: await cursorFor(ctx, p.user_id, p.workspace, now) })));
    waiting.sort((a, b) => a.cursor - b.cursor);
    const out: Pair[] = [];
    const quiet: Pair[] = [];
    for (const { cursor, ...pair } of waiting) {
      if (out.length >= SWEEP_MAX_PAIRS) break;
      const { sends, pins, more } = await activitySince(ctx, pair.user_id, cursor, Math.max(cursor, now - LATE_MARGIN_MS), SWEEP_ACTIVITY_READ);
      if (more) {
        out.push(pair);
        continue;
      }
      const seen = new Set<string>();
      let picked = false;
      for (const id of [...pins.map((p) => p.conversation_id), ...sends.map((s) => s.conversation_id)]) {
        if (seen.has(String(id))) continue;
        seen.add(String(id));
        const conv: Doc<"conversations"> | null = await ctx.db.get(id);
        if (conv && (await inWorkspace(vis, conv, pair.user_id, pair.workspace))) {
          picked = true;
          break;
        }
      }
      (picked ? out : quiet).push(pair);
    }
    // Pairs with nothing new are probed for strays from a different one each sweep, so the probe's budget reaches them all in turn.
    const strayBudget = { left: SWEEP_STRAY_BUDGET };
    const start = quiet.length ? Math.floor(now / SWEEP_EVERY_MS) % quiet.length : 0;
    for (const pair of [...quiet.slice(start), ...quiet.slice(0, start)]) {
      if (out.length >= SWEEP_MAX_PAIRS) break;
      if (await needsRewrite(ctx, pair) || (await correctionPending(ctx, pair)) || (strayBudget.left > 0 && (await holdsStray(ctx, vis, pair, now, strayBudget)))) out.push(pair);
    }
    return out;
  },
});

/** Whether one of the pair's priorities needs a rewrite (a session it held left or was deleted): one indexed read. */
async function needsRewrite(ctx: { db: any }, pair: Pair): Promise<boolean> {
  return !!(await ctx.db
    .query("priorities")
    .withIndex("by_user_workspace_rewrite", (q: any) => q.eq("user_id", pair.user_id).eq("workspace", pair.workspace).eq("needs_rewrite", true))
    .first());
}

/** Whether the person wrote a correction in the pair's workspace that no pass has read: one indexed read. */
async function correctionPending(ctx: { db: any }, pair: Pair): Promise<boolean> {
  return !!(await ctx.db
    .query("priority_corrections")
    .withIndex("by_user_workspace_status", (q: any) => q.eq("user_id", pair.user_id).eq("workspace", pair.workspace).eq("status", "pending"))
    .first());
}

/**
 * Whether one of the pair's newest priorities holds a session that has left
 * its workspace (passInputs' strays, read the same way), spending at most
 * `budget.left` priorities of the sweep's probe. A stray past the budget waits
 * for the pair's next pass.
 */
async function holdsStray(ctx: { db: any }, vis: SessionVisibility, pair: Pair, now: number, budget: { left: number }): Promise<boolean> {
  for (const p of (await livePriorities(ctx, pair.user_id, pair.workspace, now, Math.min(SWEEP_STRAY_PER_PAIR, budget.left))).slice(0, SWEEP_STRAY_PER_PAIR)) {
    if (budget.left-- <= 0) return false;
    const held: Doc<"conversations">[] = await ctx.db.query("conversations").withIndex("by_priority", (q: any) => q.eq("priority_id", p._id)).order("desc").take(PRIORITY_PASS_CAPS.sessions_per_priority);
    for (const c of held) if (!(await inWorkspace(vis, c, pair.user_id, pair.workspace))) return true;
  }
  return false;
}

/** Every SWEEP_EVERY_MS (crons.ts): reads the teams a page at a time and schedules a sweep for each one with the feature on, a few seconds apart. */
export const sweep = internalAction({
  args: {},
  handler: async (ctx): Promise<number> => {
    let cursor: string | null = null;
    let n = 0;
    for (;;) {
      const page: { teams: Id<"teams">[]; cursor: string; done: boolean } = await ctx.runQuery(self.flaggedTeams, { cursor });
      for (const team_id of page.teams) await ctx.scheduler.runAfter(n++ * SWEEP_STAGGER_MS, self.sweepTeam, { team_id });
      if (page.done) return n;
      cursor = page.cursor;
    }
  },
});

/** One team's sweep: a pass for each of its pairs with new work, a few seconds apart. Also the sweep a team gets the moment the feature turns on (teamFeatures afterFeatureChange). */
export const sweepTeam = internalAction({
  args: { team_id: v.id("teams") },
  handler: async (ctx, args): Promise<number> => {
    const pairs: Pair[] = await ctx.runQuery(self.sweepCandidates, { team_id: args.team_id });
    for (const [i, pair] of pairs.entries()) await ctx.scheduler.runAfter(i * SWEEP_STAGGER_MS, run.runPass, pair);
    return pairs.length;
  },
});
