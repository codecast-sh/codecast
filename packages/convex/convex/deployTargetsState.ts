// Deploy targets: the commits waiting on main and each target's state, as the
// targets view reads them (docs/architecture/deploys.md DP12), and main's commits
// upserted in order from GitHub or a reporting checkout (DP14).

import type { Doc, Id } from "./_generated/dataModel";
import { conversationFromSessionTrailer, normalizeRepository, resolveTaskLinksFromText } from "./lib/gitRefs";
import { afterFor, deployStepsOf } from "./deploysView";
import { ciOf } from "./deployTargetsCi";
import { canRedeploySha, commitTouchesTarget, groupQueueBySession, type QueueCommit } from "@codecast/shared/contracts/deployTargets";

const DAY = 86_400_000;
/** Commits on main read for one target's queue. */
const QUEUE_SCAN = 1500;
/** Waiting commits a target's view carries whole, newest first; the rest are counted. */
const QUEUE_SHOWN = 50;
/** Deploys read per target for its history. */
const HISTORY = 12;

// ── the waiting queue and each target's state ────────────────────────────────

export async function commitBySha(ctx: any, repository: string, sha: string): Promise<Doc<"commits"> | null> {
  const s = sha.toLowerCase();
  if (s.length === 40) {
    const rows: Doc<"commits">[] = await ctx.db.query("commits").withIndex("by_sha", (q: any) => q.eq("sha", s)).take(10);
    return rows.find((c) => c.repository === repository) ?? null;
  }
  // A short sha (a source's marker names a release by its first 9 characters): the commit it is a prefix of.
  if (!/^[0-9a-f]{7,39}$/.test(s)) return null;
  const rows: Doc<"commits">[] = await ctx.db.query("commits").withIndex("by_sha", (q: any) => q.gte("sha", s).lt("sha", `${s}~`)).take(20);
  const mine = rows.filter((c) => c.repository === repository && c.sha.startsWith(s));
  return mine.find((c) => c.main_at != null) ?? mine[0] ?? null;
}

/** A commit's place in main's order (commits.main_at), in its repository when named, else in whichever repository put it on main. */
export async function mainAtOf(ctx: any, repository: string | null | undefined, sha: string): Promise<number | null> {
  if (repository) return (await commitBySha(ctx, repository, sha))?.main_at ?? null;
  const s = sha.toLowerCase();
  if (s.length < 7) return null;
  const rows: Doc<"commits">[] = s.length === 40
    ? await ctx.db.query("commits").withIndex("by_sha", (q: any) => q.eq("sha", s)).take(10)
    : await ctx.db.query("commits").withIndex("by_sha", (q: any) => q.gte("sha", s).lt("sha", `${s}~`)).take(20);
  const ordered = rows.filter((c) => c.sha.startsWith(s) && c.main_at != null).map((c) => c.main_at!);
  // Two repositories holding the same sha prefix is no answer.
  return new Set(ordered).size === 1 ? ordered[0] : null;
}

/**
 * The session behind a commit: its Codecast-Session trailer, else the newest session that worked the task it names.
 * A line run's commits and a plain `(ct-N)` subject carry no trailer, but name their task.
 */
export async function commitSession(ctx: any, c: Doc<"commits">, taskCache: Map<string, any>): Promise<{ conversation_id: Id<"conversations">; via: "trailer" | "task" } | null> {
  if (c.conversation_id) return { conversation_id: c.conversation_id, via: "trailer" };
  for (const id of c.task_ids ?? []) {
    const key = String(id);
    if (!taskCache.has(key)) taskCache.set(key, await ctx.db.get(id));
    const t = taskCache.get(key);
    const conv = t?.conversation_ids?.[t.conversation_ids.length - 1] ?? t?.created_from_conversation;
    if (conv) return { conversation_id: conv, via: "task" };
  }
  return null;
}

/** The commits on main after `fromSha` (exclusive), up to `toSha` when named, oldest first; past QUEUE_SCAN the oldest drop (truncated). */
export async function mainCommitsAfter(ctx: any, repository: string, fromSha: string | null, toSha?: string | null): Promise<{ commits: Doc<"commits">[]; known: boolean; truncated: boolean }> {
  const from = fromSha ? await commitBySha(ctx, repository, fromSha) : null;
  if (fromSha && from?.main_at == null) return { commits: [], known: false, truncated: false };
  const to = toSha ? await commitBySha(ctx, repository, toSha) : null;
  if (toSha && to?.main_at == null) return { commits: [], known: false, truncated: false };
  const lo = from?.main_at ?? Date.now() - 14 * DAY;
  const rows: Doc<"commits">[] = await ctx.db
    .query("commits")
    .withIndex("by_repository_main", (q: any) => {
      const r = q.eq("repository", repository).gt("main_at", lo);
      return to?.main_at != null ? r.lte("main_at", to.main_at) : r;
    })
    .order("desc")
    .take(QUEUE_SCAN + 1);
  return { commits: rows.slice(0, QUEUE_SCAN).reverse(), known: true, truncated: rows.length > QUEUE_SCAN };
}

export async function queueCommitOf(ctx: any, c: Doc<"commits">, convCache: Map<string, any>, taskCache: Map<string, any>): Promise<QueueCommit> {
  let session: QueueCommit["session"] = null;
  const owner = await commitSession(ctx, c, taskCache);
  if (owner) {
    const key = String(owner.conversation_id);
    if (!convCache.has(key)) convCache.set(key, await ctx.db.get(owner.conversation_id));
    const conv = convCache.get(key);
    session = { conversation_id: key, short_id: key.slice(0, 7), title: conv?.title ?? null, ...(owner.via === "task" ? { via: "task" as const } : {}) };
  }
  const tasks = [];
  for (const id of c.task_ids ?? []) {
    const key = String(id);
    if (!taskCache.has(key)) taskCache.set(key, await ctx.db.get(id));
    const t = taskCache.get(key);
    tasks.push({ task_id: key, short_id: t?.short_id ?? null, title: t?.title ?? null });
  }
  const ci = await ciOf(ctx, c.repository!, c.sha);
  return {
    sha: c.sha,
    subject: c.message.split("\n")[0].slice(0, 200),
    at: c.main_at ?? c.timestamp,
    author: c.author_login ?? c.author_name ?? null,
    session,
    tasks,
    ci: ci.state,
    ci_url: ci.url,
  };
}

/** Commits on main as a deploy's record keeps them, each with the session behind it (commitSession) and the tasks it links. */
export async function deployCommitsOf(ctx: any, rows: Doc<"commits">[]) {
  const taskCache = new Map<string, any>();
  const out = [];
  for (const c of rows) {
    const owner = await commitSession(ctx, c, taskCache);
    out.push({
      sha: c.sha,
      subject: c.message.split("\n")[0].slice(0, 200),
      ...(c.author_login || c.author_name ? { author: c.author_login ?? c.author_name } : {}),
      ...(owner ? { conversation_id: owner.conversation_id } : {}),
      ...(c.task_ids?.length ? { task_ids: c.task_ids } : {}),
    });
  }
  return out;
}

type DeployAfterCounts = { new_errors: number; regressions: number; reopened: number; quiet: boolean; open: boolean };

/**
 * A deploy as the targets view lists it: the sessions and tasks behind the commits it carried (and the tasks a line
 * deploy carries), and what happened after it went live, in counts (deploysView.afterFor).
 */
export async function deployLine(ctx: any, d: Doc<"deploys">, caches: { conv: Map<string, any>; task: Map<string, any> }, after?: DeployAfterCounts | null) {
  const sessions = [];
  for (const id of new Set((d.commits ?? []).flatMap((c) => (c.conversation_id ? [String(c.conversation_id)] : [])))) {
    if (!caches.conv.has(id)) caches.conv.set(id, await ctx.db.get(id as Id<"conversations">));
    sessions.push({ conversation_id: id, short_id: id.slice(0, 7), title: caches.conv.get(id)?.title ?? null });
  }
  const tasks = [];
  for (const id of new Set([...(d.commits ?? []).flatMap((c) => (c.task_ids ?? []).map(String)), ...d.carries.map((c) => String(c.task_id))])) {
    if (!caches.task.has(id)) caches.task.set(id, await ctx.db.get(id as Id<"tasks">));
    const t = caches.task.get(id);
    if (t) tasks.push({ task_id: id, short_id: t.short_id ?? null, title: t.title ?? null });
  }
  return {
    _id: String(d._id),
    short_id: d.short_id,
    ...(d.client_key ? { client_key: d.client_key } : {}),
    target: d.target,
    repository: d.repository ?? null,
    status: d.status,
    trigger: d.trigger,
    action: d.action ?? "deploy",
    rollback_of: d.rollback_of ?? null,
    sha: d.sha ?? null,
    previous_sha: d.previous_sha ?? null,
    version: d.version ?? null,
    url: d.url ?? null,
    source: d.source,
    started_by: d.started_by?.name ?? null,
    note: d.note ?? null,
    dirty: d.dirty ?? null,
    commits: d.commits?.length ?? 0,
    sessions,
    tasks,
    after: after ?? null,
    run_id: d.run_id ? String(d.run_id) : null,
    created_at: d.created_at,
    live_at: d.live_at ?? null,
    finished_at: d.finished_at ?? null,
  };
}

export async function targetDeploys(ctx: any, workspace: string, target: string, take = 60): Promise<Doc<"deploys">[]> {
  return await ctx.db
    .query("deploys")
    .withIndex("by_workspace_target_created", (q: any) => q.eq("workspace", workspace).eq("target", target))
    .order("desc")
    .take(take);
}

/** One target's state: live, going out, recent history, and what waits on main. */
export async function targetState(ctx: any, t: Doc<"deploy_targets">) {
  const deploys = await targetDeploys(ctx, t.workspace, t.name);
  const deploysHere = deploys.filter((d) => !d.repository || d.repository === t.repository);
  const live = deploysHere.find((d) => d.status === "live") ?? null;
  const open = deploysHere.find((d) => d.status === "requested" || d.status === "running") ?? null;
  const convCache = new Map<string, any>();
  const taskCache = new Map<string, any>();
  const caches = { conv: convCache, task: taskCache };
  const history = deploysHere.slice(0, HISTORY);
  const aftermath = await afterFor(ctx, t.workspace, live && !history.includes(live) ? [...history, live] : history, Date.now());
  const countsOf = (d: Doc<"deploys">): DeployAfterCounts | null => {
    const a = aftermath.get(String(d._id));
    return a ? { new_errors: a.new_errors, regressions: a.regressions, reopened: a.reopened, quiet: a.quiet, open: a.open } : null;
  };
  const after = await mainCommitsAfter(ctx, t.repository, live?.sha ?? null);
  const touching = after.commits.filter((c) => commitTouchesTarget(t.paths, (c.files ?? []).map((f) => f.filename)));
  const skipped = after.commits.length - touching.length;
  const head = after.commits[after.commits.length - 1] ?? null;
  const headCi = head ? await ciOf(ctx, t.repository, head.sha) : live?.sha ? await ciOf(ctx, t.repository, live.sha) : null;
  // The newest commits are shown whole, with their session, tasks and CI; the rest are counted.
  const shown: QueueCommit[] = [];
  for (const c of touching.slice(-QUEUE_SHOWN).reverse()) shown.push(await queueCommitOf(ctx, c, convCache, taskCache));
  return {
    name: t.name,
    repository: t.repository,
    runs: t.runs,
    policy: t.policy,
    live_reader: t.live,
    command: t.command ?? null,
    rollback: t.rollback ?? null,
    paths: t.paths,
    can_deploy: t.runs === "here" && !!t.command && !!t.device_id && !!t.root,
    can_redeploy_sha: t.runs === "here" && canRedeploySha(t),
    can_rollback: t.runs === "here" && !!t.rollback,
    device_id: t.device_id ?? null,
    publisher_user_id: String(t.publisher_user_id),
    live: live ? await deployLine(ctx, live, caches, countsOf(live)) : null,
    open: open ? { ...(await deployLine(ctx, open, caches)), steps: open.run_id ? await deployStepsOf(ctx, open.run_id) : [] } : null,
    history: await Promise.all(history.map((d) => deployLine(ctx, d, caches, countsOf(d)))),
    last_read: t.last_read ?? null,
    queue: {
      // False when the live sha is not on main as codecast knows it (no deploy yet, or main's order not backfilled).
      known: after.known,
      truncated: after.truncated,
      commits: touching.length,
      // Commits on main after the live sha that touch none of this target's paths: they ship nothing here.
      untouched: skipped,
      head_sha: head?.sha ?? live?.sha ?? null,
      // CI on main's newest commit: what a deploy now would send.
      head_ci: headCi?.state ?? "none",
      head_ci_url: headCi?.url ?? null,
      shown: shown.length,
      groups: groupQueueBySession(shown),
    },
  };
}



export async function upsertMainCommits(ctx: any, args: { repository: string; team_id: Id<"teams">; branch: string; commits: Array<{ sha: string; message: string; author_name: string; author_email: string; author_login?: string; at: number; files?: string[] }> }) {
  {
    const repository = normalizeRepository(args.repository);
    let inserted = 0;
    let ordered = 0;
    // Main's order from the commit history: each commit after the one before it, at its committer time or later.
    let at = 0;
    for (const c of args.commits) {
      at = Math.max(at + 1, c.at);
      const existing = (await ctx.db.query("commits").withIndex("by_sha", (q: any) => q.eq("sha", c.sha)).take(10)).find((r: Doc<"commits">) => r.repository === repository);
      const files = c.files?.map((filename) => ({ filename, status: "modified", additions: 0, deletions: 0, changes: 0 }));
      if (existing) {
        const patch: Partial<Doc<"commits">> = {};
        if (existing.main_at == null) { patch.main_at = at; ordered++; }
        if (!existing.files?.length && files?.length) patch.files = files;
        if (!existing.conversation_id) {
          const conv = await conversationFromSessionTrailer(ctx, c.message, { teamId: args.team_id, current: undefined });
          if (conv) patch.conversation_id = conv;
        }
        if (Object.keys(patch).length) await ctx.db.patch(existing._id, patch);
        continue;
      }
      const conv = await conversationFromSessionTrailer(ctx, c.message, { teamId: args.team_id, current: undefined });
      const links = await resolveTaskLinksFromText(ctx, c.message, args.branch);
      await ctx.db.insert("commits", {
        sha: c.sha,
        message: c.message,
        author_name: c.author_name,
        author_email: c.author_email,
        timestamp: c.at,
        files_changed: files?.length ?? 0,
        insertions: 0,
        deletions: 0,
        repository,
        team_id: args.team_id,
        branch: args.branch,
        ...(c.author_login ? { author_login: c.author_login } : {}),
        ...(conv ? { conversation_id: conv } : {}),
        ...(links.task_ids.length ? { task_ids: links.task_ids } : {}),
        ...(files?.length ? { files } : {}),
        main_at: at,
      });
      inserted++;
      ordered++;
    }
    return { inserted, ordered };
  }
}

