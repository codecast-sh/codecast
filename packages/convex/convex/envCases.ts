// Env case sets (envSchema.ts env_heldout*, contracts/envCases.ts): an env's
// dev and held cases, kept here so a run works on any machine.
//
// In: `put`, called by `cast env cases put` in chunks; a set goes live when
// its last case lands, the upload is an access-log row, and a live set is
// replaced only on purpose (`replace`). Out: `open` then `page`; `open`
// writes the fetch's access-log row and `page` serves cases only to that
// row's caller until it expires. Nothing else here returns a case: the
// standing and the log carry counts, versions, who and when.
//
// Dev is readable by design: any member opens it, for a run or a download
// (`cast env cases get`). Held is sealed, and `open` refuses two callers: a
// session that uploaded the held set (it has had the content in hand) while
// any goal in the workspace names the env, and its upload from a session on
// a task climbing the env. Every held fetch is counted on the env's standing
// with the fetches no attempt answered, so a read outside a run shows. The
// session and task on a row are the caller's word: the log shows who asked,
// it does not prove which session it was.
import { v } from "convex/values";
import { mutation, query } from "./functions";
import type { Doc, Id } from "./_generated/dataModel";
import { invalidScope, notFound, requireUserOrToken } from "./lib/auth";
import { scopeArgs, scopeOf } from "./lib/ingestScope";
import { workspaceGrantsAccess } from "./lib/accessKeys";
import { findInitiative, requireInitiative } from "./lib/initiativeRef";
import { caseSetSplitValidator } from "./envSchema";
import { isEnvKey } from "@codecast/shared/contracts/envs";
import { CASE_SET_LIMITS, CASES_READ_TTL_MAX_S, type CaseSetRead, type CaseSetSplit, type EnvCaseSetStanding } from "@codecast/shared/contracts/envCases";

const READS_COUNT_MAX = 1000;
const PAGE_ROWS_MAX = 500;
const teamOf = (workspace: string): Id<"teams"> | undefined => (workspace.startsWith("team:") ? (workspace.slice(5) as Id<"teams">) : undefined);
/** A split as asked for, or as a row keeps it: a row with none is a held set, from before dev sets. */
const splitOf = (x: CaseSetSplit | undefined): CaseSetSplit => x ?? "held";

/** The caller and the workspace a call addresses: the goal's when it names one, else the caller's scope. */
async function callScope(ctx: any, args: any): Promise<{ userId: Id<"users">; workspace: string }> {
  const userId = await requireUserOrToken(ctx, args.api_token);
  if (args.goal) return { userId, workspace: (await requireInitiative(ctx, userId, args.goal)).workspace };
  return { userId, workspace: (await scopeOf(ctx, { ...args, user_id: userId })).workspaceKey };
}

/** The goal in this workspace that names the env, if any: such an env is climbed, so who has seen its held cases matters. */
async function goalNaming(ctx: any, workspace: string, env: string): Promise<Doc<"initiatives"> | null> {
  const goals: Doc<"initiatives">[] = await ctx.db.query("initiatives").withIndex("by_workspace", (q: any) => q.eq("workspace", workspace)).collect();
  return goals.find((g: any) => (g.envs ?? []).some((e: { env: string }) => e.env === env)) ?? null;
}

/** The live set for a split: the newest whose every case has landed. */
export async function liveCaseSet(ctx: any, workspace: string, env: string, split: CaseSetSplit): Promise<Doc<"env_heldout"> | null> {
  // The split is matched in the query, so no number of the other split's uploads can hide this one's live set.
  return await ctx.db
    .query("env_heldout")
    .withIndex("by_workspace_env", (q: any) => q.eq("workspace", workspace).eq("env", env))
    .order("desc")
    .filter((q: any) => q.and(split === "dev" ? q.eq(q.field("split"), "dev") : q.neq(q.field("split"), "dev"), q.neq(q.field("committed_at"), undefined)))
    .first();
}

/** A split's standing: size, version, fetches of the live set, and the split's latest attempt. Never a case. */
export async function caseSetStandingOf(ctx: any, workspace: string, env: string, split: CaseSetSplit): Promise<EnvCaseSetStanding | null> {
  const set = await liveCaseSet(ctx, workspace, env, split);
  if (!set) return null;
  // Counted per set, so another split's fetches never crowd this one's out.
  const reads: Doc<"env_heldout_reads">[] = (await ctx.db.query("env_heldout_reads").withIndex("by_set", (q: any) => q.eq("set_id", set._id)).order("desc").take(READS_COUNT_MAX))
    .filter((r: Doc<"env_heldout_reads">) => r.kind === "run");
  const last: Doc<"env_attempts"> | null = await ctx.db.query("env_attempts").withIndex("by_workspace_env", (q: any) => q.eq("workspace", workspace).eq("env", env)).order("desc").filter((q: any) => q.eq(q.field("split"), split)).first();
  // A dev fetch may end in no attempt (a download, a --no-record run); only a held one that does is a read that was not a run.
  const unfiled = split === "held" ? reads.filter((r) => !r.attempt_id && (r.expires_at ?? 0) < Date.now()).length : 0;
  return {
    version: set.version,
    size: set.size,
    ...(set.label ? { label: set.label } : {}),
    uploaded_at: set.committed_at!,
    reads: reads.length,
    unfiled,
    ...(reads[0] ? { last_read_at: reads[0].at } : {}),
    ...(last ? { last_attempt: { short_id: last.short_id, candidate: last.candidate.label, n: last.n, mean: last.mean, finished_at: last.finished_at } } : {}),
  };
}

/** Whether the task's goal names the env. */
async function taskClimbs(ctx: any, userId: Id<"users">, taskId: string, env: string): Promise<boolean> {
  const task = await ctx.db.query("tasks").withIndex("by_short_id", (q: any) => q.eq("short_id", taskId.trim().toLowerCase())).first();
  const refs = [task?.goal_ref, task?.predicted?.goal_ref].map((r) => String(r ?? "").match(/^in-\d+/i)?.[0]).filter(Boolean) as string[];
  for (const ref of refs) {
    const goal = await findInitiative(ctx, userId, ref);
    if ((goal?.envs ?? []).some((e: { env: string }) => e.env === env)) return true;
  }
  return false;
}

/** Upload a case set, in chunks: the first call names the set, each later one passes its id back. */
export const put = mutation({
  args: {
    ...scopeArgs,
    goal: v.optional(v.string()),
    env: v.string(),
    split: v.optional(caseSetSplitValidator),
    set: v.optional(v.id("env_heldout")),
    /** Required unless keep_cases: the set's version (caseSetVersion) and its case count. */
    version: v.optional(v.string()),
    size: v.optional(v.number()),
    label: v.optional(v.string()),
    meta: v.optional(v.string()),
    cases: v.array(v.object({ id: v.string(), payload: v.string() })),
    session_id: v.optional(v.string()),
    task_id: v.optional(v.string()),
    /** Replace a live set on purpose; without it a second upload is refused. */
    replace: v.optional(v.boolean()),
    /** Replace only the live set's meta (a recalibration): its cases are copied server side, so the uploader needs no copy of them. */
    keep_cases: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const split = splitOf(args.split);
    if (args.keep_cases) return await remeta(ctx, args, split);
    if (!isEnvKey(args.env)) invalidScope(`"${args.env}" is not an env key (<product>/<name>)`);
    if (!/^[0-9a-f]{16}$/.test(args.version ?? "")) invalidScope("version must be 16 hex (caseSetVersion)");
    const size = args.size ?? 0;
    if (!Number.isInteger(size) || size < 1 || size > CASE_SET_LIMITS.cases_max) invalidScope(`size must be 1..${CASE_SET_LIMITS.cases_max}`);
    if ((args.label?.length ?? 0) > CASE_SET_LIMITS.label_chars) invalidScope(`label is over ${CASE_SET_LIMITS.label_chars} characters`);
    if ((args.meta?.length ?? 0) > CASE_SET_LIMITS.meta_chars) invalidScope(`meta is over ${CASE_SET_LIMITS.meta_chars} characters`);
    for (const c of args.cases) {
      if (!c.id || c.id.length > CASE_SET_LIMITS.case_id_chars) invalidScope(`a case id is empty or over ${CASE_SET_LIMITS.case_id_chars} characters`);
      if (c.payload.length > CASE_SET_LIMITS.payload_chars) invalidScope(`a case payload is over ${CASE_SET_LIMITS.payload_chars} characters`);
    }
    const { userId, workspace } = await callScope(ctx, args);
    const now = Date.now();
    let set: Doc<"env_heldout">;
    if (args.set) {
      const row = await ctx.db.get(args.set);
      if (!row || row.by_user !== userId || row.workspace !== workspace || row.env !== args.env || splitOf(row.split) !== split || row.version !== args.version || row.committed_at) invalidScope("that upload is not open: start it again");
      set = row!;
    } else {
      const live = await liveCaseSet(ctx, workspace, args.env, split);
      if (live && !args.replace) invalidScope(`${args.env} already has a live ${split} set (${live.version}, ${live.size} cases): pass --replace to supersede it`);
      if (split === "held" && args.task_id && (await taskClimbs(ctx, userId, args.task_id, args.env))) {
        invalidScope(`${args.task_id} climbs a goal ${args.env} predicts, so a held set from this session would be chosen by the climber. Upload it from the product's own runner, outside the climb.`);
      }
      const id = await ctx.db.insert("env_heldout", {
        workspace,
        team_id: teamOf(workspace),
        env: args.env,
        split,
        version: args.version!,
        ...(args.label ? { label: args.label } : {}),
        ...(args.meta ? { meta: args.meta } : {}),
        size,
        written: 0,
        by_user: userId,
        ...(args.session_id ? { session_id: args.session_id } : {}),
        created_at: now,
      });
      set = (await ctx.db.get(id))!;
    }
    if (set.written + args.cases.length > set.size) invalidScope(`this chunk would take the set past its ${set.size} cases`);
    for (const [i, c] of args.cases.entries()) {
      await ctx.db.insert("env_heldout_cases", { set_id: set._id, workspace, idx: set.written + i, case_id: c.id, payload: c.payload });
    }
    const written = set.written + args.cases.length;
    const done = written === set.size;
    await ctx.db.patch(set._id, { written, ...(done ? { committed_at: now } : {}) });
    if (done) {
      await ctx.db.insert("env_heldout_reads", { workspace, env: args.env, set_id: set._id, split, version: set.version, kind: "put", by_user: userId, ...(args.session_id ? { session_id: args.session_id } : {}), ...(args.task_id ? { task_id: args.task_id } : {}), at: now });
    }
    return { set: set._id, split, version: set.version, written, size: set.size, live: done, workspace };
  },
});

/**
 * A new version of the live set with new meta and the same cases. Logged as
 * an upload, so a changed grading input on a held set shows in its access log
 * like any replacement.
 */
async function remeta(ctx: any, args: any, split: CaseSetSplit) {
  if (args.set || args.cases?.length) invalidScope("keep_cases replaces the meta only: send no cases");
  if (!args.replace) invalidScope("keep_cases supersedes the live set: pass --replace");
  if ((args.meta?.length ?? 0) > CASE_SET_LIMITS.meta_chars) invalidScope(`meta is over ${CASE_SET_LIMITS.meta_chars} characters`);
  const { userId, workspace } = await callScope(ctx, args);
  const live = await liveCaseSet(ctx, workspace, args.env, split);
  if (!live) invalidScope(`${args.env} has no live ${split} set to keep the cases of`);
  if (split === "held" && args.task_id && (await taskClimbs(ctx, userId, args.task_id, args.env))) {
    invalidScope(`${args.task_id} climbs a goal ${args.env} predicts, so it may not change what grades its held set`);
  }
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${live!.version}\u0000${args.meta ?? ""}`)));
  const version = [...bytes.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const now = Date.now();
  const id = await ctx.db.insert("env_heldout", {
    workspace,
    team_id: teamOf(workspace),
    env: args.env,
    split,
    version,
    ...(args.label ?? live!.label ? { label: args.label ?? live!.label } : {}),
    ...(args.meta ? { meta: args.meta } : {}),
    size: live!.size,
    written: live!.size,
    committed_at: now,
    by_user: userId,
    ...(args.session_id ? { session_id: args.session_id } : {}),
    created_at: now,
  });
  const rows: Doc<"env_heldout_cases">[] = await ctx.db.query("env_heldout_cases").withIndex("by_set", (q: any) => q.eq("set_id", live!._id)).collect();
  for (const c of rows) await ctx.db.insert("env_heldout_cases", { set_id: id, workspace, idx: c.idx, case_id: c.case_id, payload: c.payload });
  await ctx.db.insert("env_heldout_reads", { workspace, env: args.env, set_id: id, split, version, kind: "put", by_user: userId, ...(args.session_id ? { session_id: args.session_id } : {}), ...(args.task_id ? { task_id: args.task_id } : {}), at: now });
  return { set: id, split, version, written: live!.size, size: live!.size, live: true, workspace };
}

/** Why this session may not run this env's held set, or null: it uploaded the set, and a goal here (or its task's goal) climbs the env. */
async function heldRefusal(ctx: any, userId: Id<"users">, workspace: string, env: string, sessionId?: string, taskId?: string): Promise<string | null> {
  if (!sessionId) return null;
  const uploaded = await ctx.db.query("env_heldout_reads").withIndex("by_session_env", (q: any) => q.eq("session_id", sessionId).eq("env", env)).filter((q: any) => q.and(q.eq(q.field("kind"), "put"), q.neq(q.field("split"), "dev"))).first();
  if (!uploaded) return null;
  const goal = await goalNaming(ctx, workspace, env);
  if (!goal && !(taskId && (await taskClimbs(ctx, userId, taskId, env)))) return null;
  return `This session uploaded ${env}'s held set, so it has seen the cases, and ${goal ? goal.short_id : taskId} climbs what ${env} predicts. A held score from here would not be held. Ask a session that never held the content to run it (cast spawn --subagent -- "cast env run ${env} --split held ..."), or run --split dev.`;
}

/** Open a fetch of the env's live set for a split: writes the access-log row; its id unlocks `page` for this caller until it expires. */
export const open = mutation({
  args: {
    ...scopeArgs,
    goal: v.optional(v.string()),
    env: v.string(),
    split: v.optional(caseSetSplitValidator),
    session_id: v.optional(v.string()),
    task_id: v.optional(v.string()),
    ttl_s: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const split = splitOf(args.split);
    if (!isEnvKey(args.env)) invalidScope(`"${args.env}" is not an env key (<product>/<name>)`);
    const { userId, workspace } = await callScope(ctx, args);
    const set = await liveCaseSet(ctx, workspace, args.env, split);
    if (!set) invalidScope(`${args.env} has no ${split} set in this workspace: the product's runner uploads one with cast env cases put ${args.env} --split ${split} --file <json>`);
    if (split === "held") {
      const why = await heldRefusal(ctx, userId, workspace, args.env, args.session_id, args.task_id);
      if (why) invalidScope(why);
    }
    const now = Date.now();
    const ttl = Math.min(Math.max(60, Math.floor(args.ttl_s ?? 3600)), CASES_READ_TTL_MAX_S);
    const read = await ctx.db.insert("env_heldout_reads", {
      workspace,
      env: args.env,
      set_id: set!._id,
      split,
      version: set!.version,
      kind: "run",
      by_user: userId,
      ...(args.session_id ? { session_id: args.session_id } : {}),
      ...(args.task_id ? { task_id: args.task_id } : {}),
      at: now,
      expires_at: now + ttl * 1000,
    });
    return { read, split, version: set!.version, size: set!.size, ...(set!.label ? { label: set!.label } : {}), ...(set!.meta ? { meta: set!.meta } : {}) };
  },
});

/** One page of an open fetch's cases, from `from`, up to the chunk limit. Only the fetch's caller, only before it expires. */
export const page = query({
  args: { api_token: v.optional(v.string()), read: v.id("env_heldout_reads"), from: v.number() },
  handler: async (ctx, args) => {
    const userId = await requireUserOrToken(ctx, args.api_token);
    const read = await ctx.db.get(args.read);
    if (!read || read.kind !== "run" || read.by_user !== userId || !read.expires_at || read.expires_at < Date.now()) return notFound("No open case-set fetch: start the run again");
    const cases: { id: string; payload: string }[] = [];
    let size = 0, next: number | null = null;
    const rows: Doc<"env_heldout_cases">[] = await ctx.db.query("env_heldout_cases").withIndex("by_set", (q: any) => q.eq("set_id", read.set_id).gte("idx", Math.max(0, Math.floor(args.from)))).take(PAGE_ROWS_MAX);
    for (const c of rows) {
      if (cases.length && size + c.payload.length > CASE_SET_LIMITS.chunk_chars) { next = c.idx; break; }
      cases.push({ id: c.case_id, payload: c.payload });
      size += c.payload.length;
    }
    if (next === null && rows.length === PAGE_ROWS_MAX) next = rows[rows.length - 1].idx + 1;
    return { cases, next };
  },
});

/** The env's case-set standings and its access log, newest first: which split, who, session, task, when. Never a case. */
export const log = query({
  args: { ...scopeArgs, goal: v.optional(v.string()), env: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const { userId, workspace } = await callScope(ctx, args);
    if (!(await workspaceGrantsAccess(ctx, userId, workspace as any))) return notFound("Env not found");
    const rows: Doc<"env_heldout_reads">[] = await ctx.db.query("env_heldout_reads").withIndex("by_workspace_env", (q: any) => q.eq("workspace", workspace).eq("env", args.env)).order("desc").take(Math.min(Math.max(1, Math.floor(args.limit ?? 20)), 200));
    const names = new Map<string, string>();
    for (const r of rows) {
      if (names.has(r.by_user)) continue;
      const u: any = await ctx.db.get(r.by_user);
      names.set(r.by_user, u?.github_username ?? u?.name ?? "someone");
    }
    const attempts = new Map<string, string>();
    for (const r of rows) if (r.attempt_id) attempts.set(r.attempt_id, ((await ctx.db.get(r.attempt_id)) as any)?.short_id ?? "");
    const reads: CaseSetRead[] = rows.map((r) => ({
      kind: r.kind,
      split: splitOf(r.split),
      version: r.version,
      by: names.get(r.by_user)!,
      ...(r.session_id ? { session_id: r.session_id } : {}),
      ...(r.task_id ? { task_id: r.task_id } : {}),
      at: r.at,
      ...(r.attempt_id && attempts.get(r.attempt_id) ? { attempt: attempts.get(r.attempt_id) } : {}),
    }));
    const [dev, held] = await Promise.all([caseSetStandingOf(ctx, workspace, args.env, "dev"), caseSetStandingOf(ctx, workspace, args.env, "held")]);
    return { dev, held, reads };
  },
});
