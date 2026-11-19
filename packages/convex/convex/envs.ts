// Environment attempts and links (envSchema.ts, shared/contracts/envs.ts).
// `cast env run` files a runner's result here; `cast env link` records a
// measured link; a goal's levels read the latest of each for the envs the
// goal names (initiatives.envs, written through initiatives.update).
//
// The result is parsed again here, from the runner's own JSON, so a CLI that
// skipped the check (or an older one) cannot file a held result that carries
// case content: held ids must arrive hashed (contracts/envs heldCaseId).
// Label, sha and repo are the client's word: the registry records them and
// trusts them, it does not prove them. An env key belongs to one repo inside a workspace: a second
// repo declaring the same key is refused rather than mixed into its history.
import { v } from "convex/values";
import { mutation, query } from "./functions";
import type { Doc, Id } from "./_generated/dataModel";
import { invalidScope, notFound, requireUserOrToken } from "./lib/auth";
import { nextShortId } from "./counters";
import { scopeArgs, scopeOf } from "./lib/ingestScope";
import { workspaceGrantsAccess } from "./lib/accessKeys";
import { findInitiative, requireInitiative } from "./lib/initiativeRef";
import { envLevelValidator } from "./envSchema";
import { caseSetStandingOf } from "./envCases";
import {
  ENV_ATTEMPT_PREFIX,
  casePageHash,
  compactCasePages,
  expandCases,
  isEnvKey,
  parseEnvResult,
  readEnvLink,
  type EnvLink,
  type EnvStanding,
  type GoalEnv,
} from "@codecast/shared/contracts/envs";

/** The most the stored cases may weigh; a Convex document holds 1 MB. */
const CASES_MAX_CHARS = 700_000;
const LIST_MAX = 100;

const teamOf = (workspace: string): Id<"teams"> | undefined => (workspace.startsWith("team:") ? (workspace.slice(5) as Id<"teams">) : undefined);

/** Where a write lands: the goal's workspace when it names one, else the caller's scope. */
async function writeScope(ctx: any, args: any): Promise<{ userId: Id<"users">; workspace: string; goal: Doc<"initiatives"> | null }> {
  const userId = await requireUserOrToken(ctx, args.api_token);
  if (args.goal) {
    const goal = await requireInitiative(ctx, userId, args.goal);
    return { userId, workspace: goal.workspace, goal };
  }
  const { workspaceKey } = await scopeOf(ctx, { ...args, user_id: userId });
  return { userId, workspace: workspaceKey, goal: null };
}

/** Where a read looks: the goal's workspace when it names one, else the caller's scope. */
async function readWorkspace(ctx: any, args: any): Promise<string> {
  if (!args.goal) return (await scopeOf(ctx, args)).workspaceKey;
  const userId = await requireUserOrToken(ctx, args.api_token);
  return (await requireInitiative(ctx, userId, args.goal)).workspace;
}

async function latestAttempts(ctx: any, workspace: string, env: string, take = 25): Promise<Doc<"env_attempts">[]> {
  return await ctx.db.query("env_attempts").withIndex("by_workspace_env", (q: any) => q.eq("workspace", workspace).eq("env", env)).order("desc").take(take);
}

async function latestLink(ctx: any, workspace: string, env: string): Promise<Doc<"env_links"> | null> {
  return await ctx.db.query("env_links").withIndex("by_workspace_env", (q: any) => q.eq("workspace", workspace).eq("env", env)).order("desc").first();
}

const attemptView = (row: Doc<"env_attempts">) => row;
/** A repo by its name alone, so a fork and its upstream are one repo. */
const repoName = (repo: string): string => repo.replace(/\/+$/, "").split("/").pop()!.toLowerCase();
const linkView = (l: Doc<"env_links">): EnvLink => ({ to: l.to, measure: l.measure, value: l.value, n: l.n, measured_at: l.measured_at, ...(l.evidence ? { evidence: l.evidence } : {}) });

/** An env's standing: its latest base attempt (else its latest of any candidate) and its latest link. */
async function standingOf(ctx: any, workspace: string, e: GoalEnv): Promise<EnvStanding> {
  const [recent, link, dev, held] = await Promise.all([latestAttempts(ctx, workspace, e.env), latestLink(ctx, workspace, e.env), caseSetStandingOf(ctx, workspace, e.env, "dev"), caseSetStandingOf(ctx, workspace, e.env, "held")]);
  const a = recent.find((r) => r.candidate.label === "base") ?? recent[0];
  return {
    env: e.env,
    level: e.level,
    ...(e.note ? { note: e.note } : {}),
    // Any recent attempt's declared title: one run recorded without it (another checkout, --allow-undeclared) does not drop it.
    ...(recent.find((r) => r.title)?.title ? { title: recent.find((r) => r.title)!.title } : {}),
    ...(a ? { attempt: { short_id: a.short_id, candidate: a.candidate, split: a.split, n: a.n, mean: a.mean, ...(a.ci95 ? { ci95: a.ci95 as [number, number] } : {}), ...(a.noise ? { noise: a.noise } : {}), ...(a.cost_usd !== undefined ? { cost_usd: a.cost_usd } : {}), finished_at: a.finished_at } } : {}),
    ...(link ? { link: linkView(link) } : {}),
    ...(dev ? { dev } : {}),
    ...(held ? { held } : {}),
  };
}

async function insertLink(ctx: any, userId: Id<"users">, workspace: string, env: string, link: EnvLink): Promise<void> {
  await ctx.db.insert("env_links", { workspace, team_id: teamOf(workspace), env, ...link, by_user: userId, created_at: Date.now() });
}

// ── writes ──

/** File one runner result. `result` is the runner's JSON as it printed it. */
export const record = mutation({
  args: {
    ...scopeArgs,
    result: v.string(),
    /** What the declaration says: the run is refused when the result disagrees. */
    env: v.string(),
    level: envLevelValidator,
    title: v.optional(v.string()),
    repo: v.optional(v.string()),
    session_id: v.optional(v.string()),
    task_id: v.optional(v.string()),
    goal: v.optional(v.string()),
    /** The run's case-set fetch (envCases.open): the attempt takes its set version from it. A held attempt without one is refused. */
    cases_read: v.optional(v.id("env_heldout_reads")),
    /** cases_read as CLIs sent it before dev sets. */
    held_read: v.optional(v.id("env_heldout_reads")),
    /** The client's key for this filing: a retried record answers with the attempt it made rather than filing a second. */
    client_key: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (args.client_key) {
      const made = await ctx.db.query("env_attempts").withIndex("by_client_key", (q: any) => q.eq("client_key", args.client_key)).first();
      if (made) {
        const userId = await requireUserOrToken(ctx, args.api_token);
        if (String(made.by_user) !== String(userId)) invalidScope("That client key belongs to another filing");
        return { id: made._id, short_id: made.short_id, workspace: made.workspace, warnings: [], case_pages: made.case_pages?.length ?? 1, case_pages_written: made.case_pages_written ?? 1 };
      }
    }
    if (!isEnvKey(args.env)) invalidScope(`"${args.env}" is not an env key (<product>/<name>)`);
    const parsed = parseEnvResult(args.result, { env: args.env, level: args.level, heldIdsHashed: true });
    if (!parsed.ok) invalidScope(`The result for ${args.env} breaks the contract: ${parsed.error}`);
    const result = (parsed as Extract<typeof parsed, { ok: true }>).result;
    const { userId, workspace, goal } = await writeScope(ctx, args);
    // An attempt is filed against the fetch that fed it, once, and only for its own split. Held must have one; dev may run on local cases.
    const readId = args.cases_read ?? args.held_read;
    const fetched: Doc<"env_heldout_reads"> | null = readId ? await ctx.db.get(readId) : null;
    const fits = !!fetched && fetched.kind === "run" && fetched.by_user === userId && fetched.env === result.env && fetched.workspace === workspace && (fetched.split ?? "held") === result.split && !fetched.attempt_id && (result.split !== "held" || (fetched.expires_at ?? 0) >= Date.now());
    if (result.split === "held" && !fits) invalidScope(`A held attempt is filed by the run that fetched the held set: run cast env run ${result.env} --split held`);
    if (readId && !fits) invalidScope(`That case-set fetch does not belong to this ${result.split} run: file it from the run that fetched it`);
    // One key, one repo: every recent attempt that names its repo must name this one.
    // The client names its repo, so this guards against a mistake, not an adversary.
    const repo = args.repo?.trim() || undefined;
    const other = repo ? (await latestAttempts(ctx, workspace, result.env, 200)).find((a) => a.repo && repoName(a.repo) !== repoName(repo)) : undefined;
    if (other) {
      invalidScope(`${result.env} is already recorded from ${other.repo}; this run is from ${repo}. Two repos cannot share an env key: rename one (<product>/<name>).`);
    }
    // The cases go in pages, this mutation writing only the first, so filing a
    // large attempt never writes more than a page at once (Convex refuses a
    // burst of writes); envs.recordCases writes the rest, each against its fingerprint.
    const pages = compactCasePages(result.cases);
    const weight = pages.reduce((a, p) => a + p.length, 0);
    if (weight > CASES_MAX_CHARS) invalidScope(`The cases weigh ${weight} characters, over ${CASES_MAX_CHARS}: shorten case ids or split the set`);
    const s = result.summary;
    const short_id = await nextShortId(ctx.db as any, ENV_ATTEMPT_PREFIX);
    const id = await ctx.db.insert("env_attempts", {
      workspace,
      team_id: teamOf(workspace),
      short_id,
      env: result.env,
      env_version: result.env_version,
      level: result.level,
      ...(args.title?.trim() ? { title: args.title.trim().slice(0, 120) } : {}),
      ...(repo ? { repo } : {}),
      candidate: result.candidate,
      split: result.split,
      n: s.n,
      mean: s.mean,
      ...(s.ci95 ? { ci95: s.ci95 } : {}),
      ...(s.unscored !== undefined ? { unscored: s.unscored } : {}),
      ...(s.baseline ? { baseline: s.baseline } : {}),
      ...(s.paired_delta !== undefined ? { paired_delta: s.paired_delta } : {}),
      ...(s.paired_ci95 ? { paired_ci95: s.paired_ci95 } : {}),
      ...(result.noise ? { noise: result.noise } : {}),
      ...(result.cost_usd !== undefined ? { cost_usd: result.cost_usd } : {}),
      started_at: result.started_at,
      finished_at: result.finished_at,
      by_user: userId,
      ...(args.session_id ? { session_id: args.session_id } : {}),
      ...(args.task_id ? { task_id: args.task_id } : {}),
      ...(goal ? { goal_id: goal._id } : {}),
      ...(fetched ? { cases_version: fetched.version } : {}),
      ...(args.client_key ? { client_key: args.client_key } : {}),
      case_pages: pages.map(casePageHash),
      // A CLI from before pages sends no client key and no later pages: its filing writes them all here, as it always did.
      case_pages_written: args.client_key ? 1 : pages.length,
      created_at: Date.now(),
    });
    for (const [seq, page] of (args.client_key ? pages.slice(0, 1) : pages).entries()) await ctx.db.insert("env_attempt_cases", { attempt_id: id, workspace, seq, cases: page });
    if (fetched) await ctx.db.patch(fetched._id, { attempt_id: id });
    // A result that carries a measured link files it as the env's link, with the attempt as evidence.
    if (result.link) await insertLink(ctx, userId, workspace, result.env, { ...result.link, evidence: result.link.evidence ?? short_id });
    return { id, short_id, workspace, warnings: parsed.warnings, case_pages: pages.length, case_pages_written: args.client_key ? 1 : pages.length };
  },
});

/**
 * One later page of an attempt's cases (`seq` from 1), from the caller who
 * filed it, checked against the fingerprint record promised. A page already
 * written answers as written, so a retry never doubles one.
 */
export const recordCases = mutation({
  args: { api_token: v.optional(v.string()), attempt: v.string(), seq: v.number(), cases: v.string() },
  handler: async (ctx, args) => {
    const userId = await requireUserOrToken(ctx, args.api_token);
    const row = await ctx.db.query("env_attempts").withIndex("by_short_id", (q: any) => q.eq("short_id", args.attempt.trim().toLowerCase())).first();
    if (!row || String(row.by_user) !== String(userId)) return notFound("Attempt not found");
    const promised = row.case_pages ?? [];
    if (!Number.isInteger(args.seq) || args.seq < 1 || args.seq >= promised.length) invalidScope(`${row.short_id} has pages 1..${promised.length - 1} to write, not ${args.seq}`);
    if (casePageHash(args.cases) !== promised[args.seq]) invalidScope(`page ${args.seq} of ${row.short_id} is not the page its record promised`);
    const pages = await ctx.db.query("env_attempt_cases").withIndex("by_attempt", (q: any) => q.eq("attempt_id", row._id)).collect();
    if (!pages.some((p: any) => p.seq === args.seq)) {
      await ctx.db.insert("env_attempt_cases", { attempt_id: row._id, workspace: row.workspace, seq: args.seq, cases: args.cases });
      await ctx.db.patch(row._id, { case_pages_written: pages.length + 1 });
    }
    const written = pages.some((p: any) => p.seq === args.seq) ? pages.length : pages.length + 1;
    return { short_id: row.short_id, case_pages: promised.length, case_pages_written: written };
  },
});

/** Record a measured link from an env to the level above (`cast env link`). */
export const link = mutation({
  args: {
    ...scopeArgs,
    env: v.string(),
    level: v.optional(envLevelValidator),
    to: v.string(),
    measure: v.string(),
    value: v.number(),
    n: v.number(),
    measured_at: v.optional(v.number()),
    evidence: v.optional(v.string()),
    goal: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (!isEnvKey(args.env)) invalidScope(`"${args.env}" is not an env key (<product>/<name>)`);
    const read = readEnvLink({ to: args.to, measure: args.measure, value: args.value, n: args.n, measured_at: args.measured_at, evidence: args.evidence }, args.level);
    if (!read.ok) invalidScope(read.error);
    const { userId, workspace } = await writeScope(ctx, args);
    const l = (read as Extract<typeof read, { ok: true }>).link;
    await insertLink(ctx, userId, workspace, args.env, l);
    return { workspace, link: l };
  },
});

// ── reads ──

/** Recent attempts in the caller's scope, newest first; one env's when named. */
export const list = query({
  args: { ...scopeArgs, goal: v.optional(v.string()), env: v.optional(v.string()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const workspaceKey = await readWorkspace(ctx, args);
    const take = Math.min(Math.max(1, Math.floor(args.limit ?? 20)), LIST_MAX);
    const rows = args.env
      ? await latestAttempts(ctx, workspaceKey, args.env, take)
      : await ctx.db.query("env_attempts").withIndex("by_workspace", (q: any) => q.eq("workspace", workspaceKey)).order("desc").take(take);
    return rows.map(attemptView);
  },
});

/** Each named env's standing in the caller's scope (`cast env ls`). */
export const standings = query({
  args: { ...scopeArgs, goal: v.optional(v.string()), envs: v.array(v.object({ env: v.string(), level: envLevelValidator })) },
  handler: async (ctx, args) => {
    const workspaceKey = await readWorkspace(ctx, args);
    return await Promise.all(args.envs.slice(0, LIST_MAX).map((e) => standingOf(ctx, workspaceKey, e)));
  },
});

/** One attempt by short id, with its cases. */
export const get = query({
  args: { api_token: v.optional(v.string()), id: v.string() },
  handler: async (ctx, args) => {
    const userId = await requireUserOrToken(ctx, args.api_token);
    const row = await ctx.db.query("env_attempts").withIndex("by_short_id", (q: any) => q.eq("short_id", args.id.trim().toLowerCase())).first();
    if (!row || !(await workspaceGrantsAccess(ctx, userId, row.workspace as any))) return notFound("Attempt not found");
    const link = await latestLink(ctx, row.workspace, row.env);
    const stored = (await ctx.db.query("env_attempt_cases").withIndex("by_attempt", (q: any) => q.eq("attempt_id", row._id)).collect()).sort((a: any, b: any) => (a.seq ?? 0) - (b.seq ?? 0));
    const cases = stored.flatMap((p: any) => expandCases(JSON.parse(p.cases)));
    // An attempt filed in pages is whole once every page it promised is in; one filed before pages always is.
    const cases_complete = !row.case_pages || stored.length >= row.case_pages.length;
    const { case_pages: _p, client_key: _k, ...view } = attemptView(row) as any;
    return { ...view, cases, cases_complete, link: link ? linkView(link) : null };
  },
});

/** A goal's levels: each env it names with its latest attempt and link (`cast goal show`, `cast goal envs`). */
export const goalLevels = query({
  args: { api_token: v.optional(v.string()), goal: v.string() },
  handler: async (ctx, args) => {
    const userId = await requireUserOrToken(ctx, args.api_token);
    const goal = await findInitiative(ctx, userId, args.goal);
    if (!goal) return null;
    const envs: GoalEnv[] = goal.envs ?? [];
    return { goal: { _id: goal._id, short_id: goal.short_id, title: goal.title, workspace: goal.workspace }, levels: await Promise.all(envs.map((e) => standingOf(ctx, goal.workspace, e))) };
  },
});

/**
 * The web's feed: one row per env any goal in the scope names, keyed by
 * workspace and env, holding its standing. The level and note stay on the
 * goal row (their one home); the goal page joins the two at render.
 */
export const workspaceStandings = query({
  args: scopeArgs,
  handler: async (ctx, args) => {
    const { workspaceKey } = await scopeOf(ctx, args);
    const goals = await ctx.db.query("initiatives").withIndex("by_workspace", (q: any) => q.eq("workspace", workspaceKey)).collect();
    const named = new Map<string, GoalEnv>();
    for (const g of goals) for (const e of (g as any).envs ?? []) if (!named.has(e.env)) named.set(e.env, e);
    const rows = await Promise.all([...named.values()].slice(0, LIST_MAX).map((e) => standingOf(ctx, workspaceKey, e)));
    return rows.map(({ level: _level, note: _note, ...s }) => ({ _id: `${workspaceKey}|${s.env}`, workspace: workspaceKey, ...s }));
  },
});
