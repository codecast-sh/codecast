// Fix attribution and regret rates (docs/architecture/regret.md).
//
// `record` is the one writer of landed_changes: the nightly trace (`cast line
// fixloop --record`, run by the daemon on the machine that publishes a team's
// line profile) sends what landed on main and which earlier changes each fix
// repaired. `summary` reads the rows back as each role's and flow's
// regret-free merge rate and each check station's miss rate.

import { v } from "convex/values";
import { internalMutation, mutation, query } from "./functions";
import type { Doc, Id } from "./_generated/dataModel";
import { verifyApiToken } from "./apiTokens";
import { requireUserOrToken } from "./lib/auth";
import { requireTeamMembership, workspaceGrantsAccess } from "./lib/access";
import { normalizeRepository } from "./lib/gitRefs";
import { newResolveCaches, resolveCommitSessions } from "./blame";
import { enqueueConfigCommand } from "./users";
import { regretSummaryFor } from "./lib/regretRead";
export { liveAtFor, regretChanges, regretSummaryFor, roleMergeAllowance } from "./lib/regretRead";

const DAY = 86_400_000;

const changeV = v.object({
  sha: v.string(),
  subject: v.string(),
  // Commit time on main (ms); the commits table's main_at wins when it has the sha.
  committed_at: v.number(),
  // The Codecast-Session trailer's conversation id, read from the message by the CLI.
  session: v.optional(v.string()),
  fix_reason: v.optional(v.string()),
});

/** The nightly trace's batch: what landed, and for each fix the changes whose lines it changed. */
export const record = mutation({
  args: {
    api_token: v.string(),
    team_id: v.id("teams"),
    repository: v.string(),
    changes: v.array(changeV),
    fixes: v.array(v.object({ sha: v.string(), at: v.number(), introduced: v.array(v.object({ sha: v.string(), lines: v.number() })) })),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");
    await requireTeamMembership(ctx, auth.userId, args.team_id);
    return await recordCore(ctx, auth.userId, args);
  },
});

export async function recordCore(ctx: any, userId: Id<"users">, args: { team_id: Id<"teams">; repository: string; changes: Array<{ sha: string; subject: string; committed_at: number; session?: string; fix_reason?: string }>; fixes: Array<{ sha: string; at: number; introduced: Array<{ sha: string; lines: number }> }> }, now = Date.now()) {
  const repository = normalizeRepository(args.repository);
  const workspace = `team:${args.team_id}`;
  const rowOf = (sha: string): Promise<Doc<"landed_changes"> | null> =>
    ctx.db.query("landed_changes").withIndex("by_repository_sha", (q: any) => q.eq("repository", repository).eq("sha", sha.toLowerCase())).filter((q: any) => q.eq(q.field("workspace"), workspace)).first();

  // Who wrote each new change: the blame resolver's tiers (trailer, commits row, stored hash, subject and time).
  const fresh: typeof args.changes = [];
  for (const c of args.changes) if (!(await rowOf(c.sha))) fresh.push(c);
  const resolved = fresh.length
    ? await resolveCommitSessions(ctx, userId, fresh.map((c) => ({ sha: c.sha.toLowerCase(), summary: c.subject, author_time: c.committed_at, ...(c.session ? { session: c.session } : {}) })), newResolveCaches())
    : {};
  let inserted = 0, linked = 0;
  for (const c of fresh) {
    const sha = c.sha.toLowerCase();
    const s: any = resolved[sha];
    const commit = await ctx.db.query("commits").withIndex("by_sha", (q: any) => q.eq("sha", sha)).filter((q: any) => q.eq(q.field("repository"), repository)).first();
    await ctx.db.insert("landed_changes", {
      workspace, team_id: args.team_id, repository, sha, subject: c.subject.slice(0, 300),
      landed_at: commit?.main_at ?? c.committed_at,
      ...(s?.conversation_id ? { conversation_id: s.conversation_id } : {}),
      ...(s?.run_id ? { run_id: s.run_id } : {}),
      ...(s?.role_id ? { role_id: s.role_id } : {}),
      ...(s?.via ? { via: s.via } : {}),
      ...(c.fix_reason ? { fix_reason: c.fix_reason } : {}),
      fixed_by: [],
      recorded_at: now,
    });
    inserted++;
  }
  for (const f of args.fixes) {
    // The fix's own place on main when it has a row (it is a change too), else the time the trace read.
    const at = (await rowOf(f.sha))?.landed_at ?? f.at;
    const fix = f.sha.toLowerCase();
    const top = Math.max(0, ...f.introduced.map((i) => i.lines));
    for (const i of f.introduced) {
      const row = await rowOf(i.sha);
      // A change older than anything recorded has no row: nothing reads it, since rates count only recorded changes.
      if (!row) continue;
      const had = row.fixed_by.find((x) => x.sha === fix);
      if (had && had.top === top) continue;
      // A link recorded before `top` existed gains it when the trace is sent again.
      const fixed_by = had ? row.fixed_by.map((x) => (x.sha === fix ? { ...x, top } : x)) : [...row.fixed_by, { sha: fix, at, lines: i.lines, top }];
      await ctx.db.patch(row._id, { fixed_by });
      if (!had) linked++;
    }
  }
  return { inserted, linked };
}

/** Where the nightly trace resumes: the newest recorded change of the repository. */
export const cursor = query({
  args: { api_token: v.string(), team_id: v.id("teams"), repository: v.string() },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");
    await requireTeamMembership(ctx, auth.userId, args.team_id);
    // Two teams can trace the same repository; each resumes from its own rows.
    const newest = await ctx.db.query("landed_changes").withIndex("by_repository_landed", (q: any) => q.eq("repository", normalizeRepository(args.repository))).order("desc").filter((q: any) => q.eq(q.field("workspace"), `team:${args.team_id}`)).first();
    return { landed_at: newest?.landed_at ?? null, recorded_at: newest?.recorded_at ?? null };
  },
});

/** Each role's and flow's regret-free merge rate (person vs line) and each check station's miss rate. */
export const summary = query({
  args: { team_id: v.id("teams"), window_days: v.optional(v.number()), api_token: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await requireUserOrToken(ctx, args.api_token);
    const workspace = `team:${args.team_id}`;
    if (!(await workspaceGrantsAccess(ctx, userId, workspace))) return null;
    const windowDays = args.window_days === undefined ? undefined : Math.max(1, Math.min(60, Math.round(args.window_days)));
    return await regretSummaryFor(ctx, workspace, Date.now(), windowDays);
  },
});

/**
 * Every night, ask each machine that publishes a team's line profile to trace
 * its repository: one command per team and machine, naming every checkout its
 * profiles publish from. The CLI reads main from its own mirror of origin, so
 * the checkout only tells it which repository.
 */
export const nightly = internalMutation({
  args: {},
  handler: async (ctx) => {
    const projects: any[] = await ctx.db.query("projects").collect();
    const asks = new Map<string, { user: Id<"users">; device: string; team: Id<"teams">; roots: Set<string> }>();
    for (const p of projects) {
      const prof = p.line_profile;
      if (!p.team_id || !prof?.device_id || !prof.publisher_user_id || !prof.root) continue;
      const k = `${p.team_id}|${prof.device_id}`;
      const a = asks.get(k) ?? { user: prof.publisher_user_id, device: prof.device_id, team: p.team_id, roots: new Set<string>() };
      a.roots.add(prof.root);
      asks.set(k, a);
    }
    for (const a of asks.values()) {
      try {
        await enqueueConfigCommand(ctx, a.user, "line_fixloop", JSON.stringify({ team_id: a.team, roots: [...a.roots] }), a.device);
      } catch (err) {
        console.log(`[fixloop] ${a.team} on ${a.device}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { asked: asks.size };
  },
});
