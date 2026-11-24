// `cast task stranded`: finished handoffs that never landed
// (shared/contracts/strandedHandoff.ts holds the rule). Read-only. It reads a
// workspace's tasks in review, each one's newest handoff and runs, the pull
// requests that handoff names, and the pull requests that name the task.
//
// A pull request's state comes from its events (light rows) when they say it
// merged, which nothing undoes. A pull_requests row carries its patches, commits
// and checks (tens of kilobytes on a large team), so one is read only for a pull
// request no event shows merged (a merge synced from GitHub writes no event), once per
// query per repository and number.
import { v } from "convex/values";
import { query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { verifyApiToken } from "./apiTokens";
import { createDataContext, explicitWorkspace } from "./data";
import { canAccessConversation } from "./lib/access";
import { workspaceGrantsAccess } from "./lib/accessKeys";
import { isHandoffComment } from "./lib/runAgentSessions";
import { prUrlFromComments } from "./taskEvidence";
import { normalizeRepository } from "./lib/gitRefs";
import {
  handoffPrRefs,
  strandedHandoff,
  STRANDED_AFTER_DAYS,
  type HandoffPrRef,
  type PrState,
  type StrandedFacts,
  type StrandedList,
  type StrandedRow,
} from "@codecast/shared/contracts/strandedHandoff";

// A large team holds hundreds of tasks in review, most of them the line's
// problems. Past this the least recently touched are read (by_workspace_status ends in
// updated_at): a stranded task is one nobody has touched since its handoff,
// while one touched since may have moved on. The answer says when it capped.
const IN_REVIEW_CAP = 1000;
// A thread is read newest first until its newest handoff.
const COMMENTS_PER_TASK = 500;
// A task's newest events, and a pull request's (external_events, light rows).
// A pull request's merge or close is among its own newest events.
const EVENTS_PER_TASK = 100;
const EVENTS_PER_PR = 100;
const RUNS_PER_TASK = 20;
// A "PR #N" names no repository: it is looked up in the team's repositories
// most recently active, at most this many, found in its newest events.
const TEAM_REPOS_CAP = 10;
const TEAM_EVENTS_SCANNED = 500;

type Scope = { viewerId: Id<"users">; workspaceKey: string; teamId: Id<"teams"> | null };

async function recentTeamRepositories(ctx: { db: any }, viewerId: Id<"users">, teamId: Id<"teams">): Promise<string[]> {
  const repos = new Set<string>();
  const readable = new Map<string, boolean>();
  let scanned = 0;
  for await (const e of ctx.db.query("external_events").withIndex("by_team_created", (q: any) => q.eq("team_id", teamId)).order("desc")) {
    // Only events the viewer may read name a repository to look in.
    const key = e.workspace ?? `team:${teamId}`;
    if (!readable.has(key)) readable.set(key, await workspaceGrantsAccess(ctx, viewerId, key));
    if (e.repository && readable.get(key)) repos.add(normalizeRepository(e.repository));
    if (repos.size >= TEAM_REPOS_CAP || ++scanned >= TEAM_EVENTS_SCANNED) break;
  }
  return [...repos];
}

async function newestHandoff(ctx: { db: any }, taskId: Id<"tasks">) {
  let read = 0;
  for await (const c of ctx.db.query("task_comments").withIndex("by_task_created", (q: any) => q.eq("task_id", taskId)).order("desc")) {
    if (isHandoffComment(c)) return c;
    if (++read >= COMMENTS_PER_TASK) break;
  }
  return null;
}

// The events that set a pull request's state. A review, check or push after a
// merge or close leaves it merged or closed; only a reopen opens it again.
const PR_STATE_KINDS: Record<string, PrState> = { pr_opened: "open", pr_reopened: "open", pr_closed: "closed", pr_merged: "merged" };

type LinkedPr = { repository: string; number: number; state: PrState; merged_at?: number };
type RowState = { state: PrState; merged_at?: number };
type PrRowById = (id: string) => Promise<RowState | null>;

/** The pull requests the task's events name. A merge their newest
 *  state-setting event records stands; otherwise the pull_requests row says
 *  (a close is not final: a pull request reopened and merged through a sync
 *  from GitHub has no event for either).
 *  Only the first task a pull request names carries its events
 *  (external_events.task_id), so a second task it names sees it only through
 *  its handoff's PR line. */
async function linkedPullRequests(ctx: { db: any }, taskId: Id<"tasks">, readable: (teamId: unknown) => Promise<boolean>, prRowById: PrRowById) {
  const events = await ctx.db.query("external_events").withIndex("by_task_created", (q: any) => q.eq("task_id", taskId)).order("desc").take(EVENTS_PER_TASK);
  const prs = new Map<string, { repository: string; number: number; settled?: { state: PrState; at: number } }>();
  const repos = new Set<string>();
  // Newest first: the first state-setting event a pull request shows is its state.
  const settle = (e: any) => {
    const pr = prs.get(String(e.pr_id));
    const state = PR_STATE_KINDS[e.kind];
    if (pr && state && !pr.settled) pr.settled = { state, at: e.created_at };
  };
  for (const e of events) {
    if (!(await readable(e.team_id))) continue;
    if (e.repository) repos.add(e.repository);
    if (!e.pr_id || e.pr_number == null || !e.repository || !e.kind.startsWith("pr_")) continue;
    if (!prs.has(String(e.pr_id))) prs.set(String(e.pr_id), { repository: e.repository, number: e.pr_number });
    settle(e);
  }
  // A busy task's window can hold a pull request's review but not its merge.
  for (const [prId, pr] of prs) {
    if (pr.settled) continue;
    const own = await ctx.db.query("external_events").withIndex("by_pr_created", (q: any) => q.eq("pr_id", prId)).order("desc").take(EVENTS_PER_PR);
    for (const e of own) if (await readable(e.team_id)) settle(e);
  }
  const linked: LinkedPr[] = [];
  for (const [prId, p] of prs) {
    const s = p.settled;
    if (s?.state === "merged") {
      linked.push({ repository: p.repository, number: p.number, state: "merged", merged_at: s.at });
      continue;
    }
    // Open or closed by its events, or no event says: the row holds what GitHub last said.
    const row = await prRowById(prId);
    if (row) linked.push({ repository: p.repository, number: p.number, ...row });
    else if (s) linked.push({ repository: p.repository, number: p.number, state: s.state });
  }
  return { prs: linked, repos };
}

export async function strandedRows(ctx: { db: any }, scope: Scope, now: number, days: number): Promise<StrandedList> {
  const read = await ctx.db
    .query("tasks")
    .withIndex("by_workspace_status", (q: any) => q.eq("workspace", scope.workspaceKey).eq("status", "in_review"))
    .order("asc")
    .take(IN_REVIEW_CAP + 1);
  const tasks = read.slice(0, IN_REVIEW_CAP);
  const teamId = scope.teamId;

  // Pull requests belong to teams. A team workspace reads its own team's; a
  // personal one reads those of every team the viewer belongs to.
  const teamsRead = new Map<string, Promise<boolean>>();
  const readable = (id: unknown): Promise<boolean> => {
    if (!id) return Promise.resolve(false);
    if (teamId) return Promise.resolve(String(id) === String(teamId));
    const key = String(id);
    const held = teamsRead.get(key);
    if (held) return held;
    const member = workspaceGrantsAccess(ctx, scope.viewerId, `team:${key}`);
    teamsRead.set(key, member);
    return member;
  };
  // Each row once per query, and only its state is kept.
  const rowStates = new Map<string, Promise<RowState | null>>();
  const memo = (key: string, load: () => Promise<any>): Promise<RowState | null> => {
    const held = rowStates.get(key);
    if (held) return held;
    const state = load().then((row: any) => (row ? { state: row.state as PrState, ...(row.merged_at != null ? { merged_at: row.merged_at } : {}) } : null));
    rowStates.set(key, state);
    return state;
  };
  const readableRow = async (row: any) => (row && (await readable(row.team_id)) ? row : null);
  // An event names its pull request's row exactly.
  const prRowById: PrRowById = (id) => memo(id, async () => readableRow(await ctx.db.get(id)));
  // A handoff names a repository and number, which a repository connected in
  // two teams holds twice: the row the viewer may read is the one meant.
  const prRow = (repository: string, number: number) =>
    memo(`${repository}#${number}`, async () => {
      for await (const row of ctx.db.query("pull_requests").withIndex("by_repository_number", (q: any) => q.eq("repository", repository).eq("number", number))) {
        if (await readableRow(row)) return row;
      }
      return null;
    });
  const found = async (repos: Iterable<string>, number: number) =>
    (await Promise.all([...repos].map((r) => prRow(r, number)))).filter((s): s is RowState => s != null).map((s) => s.state);
  // Read once, however many bare "PR #N" refs ask at the same time.
  let teamRepos: Promise<string[]> | null = null;
  // A "PR #N" counts only when one repository can be meant: the one the task's
  // own events name that holds that number, or else the only team repository
  // that does (a personal workspace has no team repositories to look in).
  const prState = async (ref: HandoffPrRef, linked: { prs: LinkedPr[]; repos: Set<string> }): Promise<PrState | undefined> => {
    const known = linked.prs.filter((p) => p.number === ref.number && (!ref.repository || normalizeRepository(p.repository) === ref.repository));
    if (known.length === 1) return known[0].state;
    if (ref.repository) return (await prRow(ref.repository, ref.number))?.state;
    const own = await found(linked.repos, ref.number);
    if (own.length) return own.length === 1 ? own[0] : undefined;
    if (!teamId) return undefined;
    teamRepos ??= recentTeamRepositories(ctx, scope.viewerId, teamId);
    const rest = await found((await teamRepos).filter((r) => !linked.repos.has(r)), ref.number);
    return rest.length === 1 ? rest[0] : undefined;
  };

  const out: StrandedRow[] = [];
  for (const task of tasks) {
    // A problem the line is fixing waits at the line's own review station, which shows it.
    if (task.cause || task.source === "signal") continue;
    if (task.execution_status !== "done" && task.execution_status !== "done_with_concerns") continue;
    const handoff = await newestHandoff(ctx, task._id);
    if (!handoff || now - handoff.created_at < days * 86_400_000) continue;
    const runs = await ctx.db.query("workflow_runs").withIndex("by_task", (q: any) => q.eq("task_id", task._id)).order("desc").take(RUNS_PER_TASK);
    const landings = [task.landed, ...runs.map((r: any) => r.merge)].filter(Boolean).map((l: any) => ({ at: l.at, sha: l.sha }));
    const linked = await linkedPullRequests(ctx, task._id, readable, prRowById);
    if (task.landed?.repository) linked.repos.add(task.landed.repository);
    const refs = handoffPrRefs(handoff.text, prUrlFromComments([handoff]));
    const prs = await Promise.all(refs.map(async (r) => ({ ...r, state: await prState(r, linked) })));
    const facts: StrandedFacts = {
      status: task.status,
      execution_status: task.execution_status,
      handoff: { at: handoff.created_at, text: handoff.text, conversation_id: String(handoff.conversation_id) },
      guide_at: task.change_guide?.written_at ?? null,
      files_changed: task.files_changed?.length ?? 0,
      landings,
      prs,
      linked_prs: linked.prs,
    };
    const stranded = strandedHandoff(facts, now, days);
    if (!stranded) continue;
    const by = await ctx.db.get(handoff.conversation_id);
    out.push({
      short_id: task.short_id,
      title: task.title,
      assignee: task.assignee ?? null,
      handed_off_at: stranded.handed_off_at,
      handed_off_by: by && (await canAccessConversation(ctx, scope.viewerId, by)) ? by.short_id ?? null : null,
      branches: stranded.branches,
      prs: stranded.prs.map((p) => ({ ...p, state: p.state ?? null })),
    });
  }
  return { rows: out.sort((a, b) => a.handed_off_at - b.handed_off_at), capped_at: read.length > IN_REVIEW_CAP ? IN_REVIEW_CAP : null };
}

export const list = query({
  args: {
    api_token: v.string(),
    project_path: v.optional(v.string()),
    workspace: v.optional(v.union(v.literal("personal"), v.literal("team"))),
    team_id: v.optional(v.id("teams")),
    days: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<StrandedList> => {
    const auth = await verifyApiToken(ctx, args.api_token, false);
    if (!auth) throw new Error("Unauthorized");
    const db = await createDataContext(ctx, { userId: auth.userId, project_path: args.project_path, ...explicitWorkspace(args, {}) });
    const scope = { viewerId: auth.userId, workspaceKey: db.workspaceKey, teamId: db.workspace.type === "team" ? db.workspace.teamId : null };
    return await strandedRows(ctx, scope, Date.now(), args.days ?? STRANDED_AFTER_DAYS);
  },
});
