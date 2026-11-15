// A project's outputs (ct-94262): every pull request, published page, doc and
// image its work produced, each named with the session that made it and the
// task it was for. The project's sessions are derived (session-projects.md
// SP1): the sessions filed under it, the sessions its tasks and plans list,
// and their workers, each kept only when the shared rule puts it in this
// project, so a worker bound to a task in another project brings nothing
// here but the pull requests that name one of this project's tasks.
//
// Two parts (shared/contracts/projectOutputs.ts). `members` reads the
// sessions, tasks and images and re-runs as those sessions change. `items`
// reads pull requests, pages and docs by the member ids it is handed, so a
// session's heartbeat or new message never re-runs it, and it reads pull
// request and doc rows (patches, bodies) under a byte budget well inside the
// 16 MiB read cap.
//
// Access: every output passes its own check (a pull request its team, a page
// the gallery rule, a doc its workspace key, an image its session), and a
// session or task is named only when the viewer may open it.
import { v } from "convex/values";
import { query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { getAuthenticatedUserId } from "./pendingMessages";
import { accessJudgeFor, canAccessConversation, canAccessProject, isTeamMember } from "./lib/access";
import { viewerSeesPage } from "./artifacts";
import { effectiveSessionProjectId, sessionProjectCache } from "./sessionProjects";
import { sessionImages } from "./lib/sessionMedia";
import { codecastPrPath, foldShepherdState } from "@codecast/shared/contracts";
import {
  joinProjectOutputs,
  outputItemArgs,
  prGroupOf,
  type MemberSession,
  type OutputImage,
  type OutputTask,
  type ProjectOutputItems,
  type ProjectOutputMembers,
  type ProjectOutputs,
} from "@codecast/shared/contracts/projectOutputs";

export type { OutputDoc, OutputImage, OutputPage, OutputPr, OutputSession, OutputTask, PrGroup, ProjectOutputs } from "@codecast/shared/contracts/projectOutputs";
export { prGroupOf };

type Ctx = { db: any; storage?: any };

/** Sessions filed under the project, newest first. */
const ROOT_SESSIONS = 100;
/** Every session the query considers, roots, task sessions and workers. */
const SESSIONS_MAX = 250;
/** Workers read per session, newest first, on each parent link. */
const CHILDREN_PER_SESSION = 30;
/** Tasks read per triage state, and per plan, newest first. */
const TASKS_PER_STATE = 200;
const TASKS_PER_PLAN = 100;
/** The newest tasks whose attached pages are read one index range each. */
const TASK_PAGE_READS = 100;
/** Docs read per session (a session writes a few), for the newest sessions. */
const DOCS_PER_SESSION = 5;
const DOC_SESSIONS = 40;
/** Pull request rows carry files and patches (up to 1 MB), doc rows their
 *  bodies: each kind stops reading at its byte budget, together well under
 *  the 16 MiB read cap with room for the one row that crosses it. */
const PR_BYTES = 5 * 1024 * 1024;
const DOC_BYTES = 4 * 1024 * 1024;
const PRS_MAX = 40;
const PR_READS_MAX = 60;
const PAGES_MAX = 80;
const DOCS_MAX = 80;
const IMAGES_MAX = 24;
/** The newest sessions whose images are read. */
const IMAGE_SESSIONS = 20;
/** Ids the items part accepts per list: what members can return, with room. */
const ITEM_ARG_MAX = 600;

/** A project by Convex id or pj- short id. */
export async function findProjectByRef(ctx: Ctx, ref: string): Promise<Doc<"projects"> | null> {
  const id = ctx.db.normalizeId("projects", ref);
  if (id) return await ctx.db.get(id);
  return (await ctx.db.query("projects").withIndex("by_short_id", (q: any) => q.eq("short_id", ref)).first()) ?? null;
}

export async function computeProjectMembers(ctx: Ctx, viewerId: Id<"users">, project: Doc<"projects">): Promise<ProjectOutputMembers> {
  const projectKey = String(project._id);
  const mayRead = await accessJudgeFor(ctx as any, viewerId);
  let truncated = false;

  // Tasks: the project's, by triage state so filed suggestions are never read
  // (org.resolveScope's rule), plus its plans' tasks that name no project
  // (SP1: a task with no project of its own is in its plan's).
  const plans: Doc<"plans">[] = await ctx.db.query("plans").withIndex("by_project_id", (q: any) => q.eq("project_id", project._id)).collect();
  const tasks = new Map<string, Doc<"tasks">>();
  const admitTasks = (rows: Doc<"tasks">[]) => {
    for (const t of rows) if (!t.project_id || String(t.project_id) === projectKey) tasks.set(String(t._id), t);
  };
  for (const triage of ["active", undefined]) {
    const rows = await ctx.db.query("tasks").withIndex("by_project_triage", (q: any) => q.eq("project_id", project._id).eq("triage_status", triage)).order("desc").take(TASKS_PER_STATE);
    if (rows.length === TASKS_PER_STATE) truncated = true;
    admitTasks(rows);
  }
  for (const plan of plans) {
    const rows = await ctx.db.query("tasks").withIndex("by_plan_id", (q: any) => q.eq("plan_id", plan._id)).order("desc").take(TASKS_PER_PLAN);
    admitTasks(rows.filter((t: any) => t.triage_status === undefined || t.triage_status === "active"));
  }
  const taskRef = new Map<string, OutputTask>();
  for (const t of tasks.values()) {
    if (await mayRead("tasks", t)) taskRef.set(String(t._id), { id: String(t._id), short_id: t.short_id ?? String(t._id), title: t.title });
  }

  // Sessions: filed under the project, listed by its tasks and plans, then
  // their workers breadth first. Each row read once.
  const cache = sessionProjectCache();
  for (const p of plans) cache.planProjects.set(String(p._id), projectKey);
  for (const t of tasks.values()) {
    cache.taskProjects.set(String(t._id), t.project_id ? String(t.project_id) : null);
    cache.taskPlans.set(String(t._id), t.plan_id ? String(t.plan_id) : null);
  }
  const candidates = new Map<string, Doc<"conversations">>();
  const queue: Doc<"conversations">[] = [];
  const consider = (c: Doc<"conversations"> | null) => {
    if (!c || candidates.has(String(c._id))) return;
    if (candidates.size >= SESSIONS_MAX) { truncated = true; return; }
    candidates.set(String(c._id), c);
    cache.sessions.set(String(c._id), c);
    queue.push(c);
  };
  const roots = await ctx.db.query("conversations").withIndex("by_project_id", (q: any) => q.eq("project_id", project._id)).order("desc").take(ROOT_SESSIONS);
  if (roots.length === ROOT_SESSIONS) truncated = true;
  roots.forEach(consider);
  const tasksNewest = [...tasks.values()].sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0));
  for (const ids of [...tasksNewest.map((t) => t.conversation_ids ?? []), ...plans.map((p: any) => p.session_ids ?? [])]) {
    for (const id of ids) {
      if (candidates.size >= SESSIONS_MAX) break;
      if (!candidates.has(String(id))) consider(await ctx.db.get(id));
    }
  }
  // A session working in another project is not walked: its workers inherit
  // that project, and one of them bound to a task here is listed by the task.
  for (let i = 0; i < queue.length && candidates.size < SESSIONS_MAX; i++) {
    const parent = queue[i];
    const pid = await effectiveSessionProjectId(ctx, parent, cache);
    if (pid && String(pid) !== projectKey) continue;
    for (const index of ["by_parent_conversation_id", "by_spawned_by"] as const) {
      const field = index === "by_parent_conversation_id" ? "parent_conversation_id" : "spawned_by_conversation_id";
      const kids = await ctx.db.query("conversations").withIndex(index, (q: any) => q.eq(field, parent._id)).order("desc").take(CHILDREN_PER_SESSION);
      if (kids.length === CHILDREN_PER_SESSION) truncated = true;
      kids.forEach(consider);
    }
  }

  // In the project by SP1, or reached but working elsewhere (a worker bound to
  // another project's task, a session a task lists that has moved on).
  const inProject: Doc<"conversations">[] = [];
  const elsewhere: Doc<"conversations">[] = [];
  for (const c of candidates.values()) {
    if (!(await canAccessConversation(ctx as any, viewerId, c as any))) continue;
    const pid = await effectiveSessionProjectId(ctx, c, cache);
    (pid && String(pid) === projectKey ? inProject : elsewhere).push(c);
  }
  // Newest created first: the order the items part's caps keep, and one that
  // never moves, so its arguments change only with membership.
  const created = (a: { _creationTime: number }, b: { _creationTime: number }) => b._creationTime - a._creationTime;
  inProject.sort(created);
  elsewhere.sort(created);
  const member = (c: Doc<"conversations">, in_project: boolean): MemberSession => ({
    id: String(c._id),
    short_id: c.short_id ?? null,
    title: c.title || "(untitled)",
    task_id: c.active_task_id && taskRef.has(String(c.active_task_id)) ? String(c.active_task_id) : null,
    in_project,
  });
  const sessions = [...inProject.map((c) => member(c, true)), ...elsewhere.map((c) => member(c, false))];

  // Images: what the newest sessions in the project posted.
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const recentlyActive = [...inProject].sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0));
  const found = (await Promise.all(recentlyActive.slice(0, IMAGE_SESSIONS).map((c) => sessionImages(ctx, c._id, { since: 0, max: IMAGES_MAX })))).flat();
  found.sort((a, b) => b.timestamp - a.timestamp || b.seq - a.seq);
  const images: OutputImage[] = found.slice(0, IMAGES_MAX).map((img) => {
    const s = byId.get(String(img.conversation_id))!;
    return {
      kind: "image",
      id: `${img.message_id}:${img.seq}`,
      title: s.title,
      href: `/conversation/${s.id}#msg-${img.message_id}`,
      updated_at: img.timestamp,
      session: { id: s.id, short_id: s.short_id, title: s.title },
      task: s.task_id ? taskRef.get(s.task_id) ?? null : null,
      url: img.url,
      message_id: String(img.message_id),
    };
  });

  return {
    project: { id: projectKey, short_id: project.short_id ?? null, title: project.title },
    sessions,
    tasks: [...tasks.values()].sort(created).flatMap((t) => taskRef.get(String(t._id)) ?? []),
    plan_ids: [...plans].sort(created).map((p) => String(p._id)),
    images,
    truncated,
  };
}

type ItemArgs = { session_ids: string[]; elsewhere_ids: string[]; task_ids: string[]; plan_ids: string[] };

/** A pull request row's weight, near enough to budget reads by. */
const prBytes = (pr: any) => (pr.body?.length ?? 0) + (pr.files ?? []).reduce((n: number, f: any) => n + (f.patch?.length ?? 0) + (f.filename?.length ?? 0) + 64, 0) + 4096;
const docBytes = (d: any) => (d.content?.length ?? 0) + 2048;

/** The pull requests, pages and docs of the sessions, tasks and plans named,
 *  each passing its own access check. Sessions and tasks come back by id. */
export async function computeProjectItems(ctx: Ctx, viewerId: Id<"users">, project: Doc<"projects">, args: ItemArgs): Promise<ProjectOutputItems> {
  const mayRead = await accessJudgeFor(ctx as any, viewerId);
  let truncated = false;
  const norm = <T extends "conversations" | "tasks" | "plans">(table: T, ids: string[]): Id<T>[] =>
    ids.slice(0, ITEM_ARG_MAX).map((id) => ctx.db.normalizeId(table, id)).filter(Boolean) as Id<T>[];
  const sessionIds = norm("conversations", args.session_ids);
  const elsewhereIds = norm("conversations", args.elsewhere_ids);
  const taskIds = norm("tasks", args.task_ids);
  const planIds = norm("plans", args.plan_ids);
  const inProject = new Set(sessionIds.map(String));
  const reached = new Set([...inProject, ...elsewhereIds.map(String)]);
  const taskSet = new Set(taskIds.map(String));

  // Pull requests: every link row of the sessions, in-project sessions first.
  // A link row carries the team, so a pull request the viewer may not see is
  // never loaded, and one only an elsewhere session links is loaded only to
  // learn whether it names a project task.
  const links = new Map<string, { sessions: Array<{ id: string; committed: boolean }>; team: string | null }>();
  const linkRows = await Promise.all([...sessionIds, ...elsewhereIds].map((id) => ctx.db.query("pull_request_sessions").withIndex("by_conversation", (q: any) => q.eq("conversation_id", id)).collect()));
  for (const rows of linkRows) {
    for (const row of rows) {
      const key = String(row.pull_request_id);
      const entry = links.get(key) ?? { sessions: [], team: row.team_id ? String(row.team_id) : null };
      entry.sessions.push({ id: String(row.conversation_id), committed: row.tier === "committed" });
      links.set(key, entry);
    }
  }
  const teamMember = new Map<string, boolean>();
  const mayTeam = async (team: string) => {
    if (!teamMember.has(team)) teamMember.set(team, await isTeamMember(ctx as any, viewerId, team as Id<"teams">));
    return teamMember.get(team)!;
  };
  const ordered = [...links].sort(([, a], [, b]) => Number(b.sessions.some((s) => inProject.has(s.id))) - Number(a.sessions.some((s) => inProject.has(s.id))));
  let prBudget = PR_BYTES;
  let prReads = 0;
  const prs: ProjectOutputItems["prs"] = [];
  for (const [prId, link] of ordered) {
    if (prs.length >= PRS_MAX || prReads >= PR_READS_MAX || prBudget <= 0) { truncated = true; break; }
    if (link.team && !(await mayTeam(link.team))) continue;
    prReads++;
    const pr: Doc<"pull_requests"> | null = await ctx.db.get(prId as Id<"pull_requests">);
    if (!pr) continue;
    prBudget -= prBytes(pr);
    if (!(await mayTeam(String(pr.team_id)))) continue;
    const namedTask = (pr.task_ids ?? []).map(String).find((id) => taskSet.has(id)) ?? null;
    const ours = link.sessions.filter((s) => inProject.has(s.id));
    if (!ours.length && !namedTask) continue;
    const maker = ours.find((s) => s.committed) ?? (pr.shepherd_conversation_id && inProject.has(String(pr.shepherd_conversation_id)) ? { id: String(pr.shepherd_conversation_id) } : null) ?? ours[0] ?? link.sessions[0];
    const status = foldShepherdState(pr);
    prs.push({
      kind: "pr",
      id: prId,
      title: pr.title,
      href: codecastPrPath(pr.repository, pr.number),
      github_url: `https://github.com/${pr.repository}/pull/${pr.number}`,
      updated_at: pr.updated_at,
      session_id: maker?.id ?? null,
      task_id: namedTask,
      repository: pr.repository,
      number: pr.number,
      state: pr.state,
      draft: !!pr.draft,
      status,
      group: prGroupOf(status),
      review_decision: pr.review_decision ?? null,
      checks_state: pr.checks_state ?? null,
      behind_by: pr.behind_by ?? null,
      unresolved_review_count: pr.unresolved_review_count ?? null,
    });
  }
  prs.sort((a, b) => b.updated_at - a.updated_at);

  // Pages: published by a session in the project, or attached to its tasks or plans.
  const pageRows = new Map<string, Doc<"artifacts">>();
  const addPages = (rows: Doc<"artifacts">[]) => { for (const a of rows) pageRows.set(String(a._id), a); };
  for (const rows of await Promise.all(sessionIds.map((id) => ctx.db.query("artifacts").withIndex("by_session_conversation", (q: any) => q.eq("session_conversation_id", id)).collect()))) addPages(rows);
  for (const rows of await Promise.all(taskIds.slice(0, TASK_PAGE_READS).map((id) => ctx.db.query("artifacts").withIndex("by_task", (q: any) => q.eq("task_id", id)).collect()))) addPages(rows);
  for (const rows of await Promise.all(planIds.map((id) => ctx.db.query("artifacts").withIndex("by_plan", (q: any) => q.eq("plan_id", id)).collect()))) addPages(rows);
  const pagesSorted = [...pageRows.values()].sort((a, b) => b.updated_at - a.updated_at);
  if (pagesSorted.length > PAGES_MAX) truncated = true;
  const pages: ProjectOutputItems["pages"] = [];
  for (const a of pagesSorted.slice(0, PAGES_MAX)) {
    if (a.expires_at && a.expires_at < Date.now() && a.user_id !== viewerId) continue;
    if (!(await viewerSeesPage(ctx as any, viewerId, a))) continue;
    const sid = a.session_conversation_id ? String(a.session_conversation_id) : null;
    pages.push({
      kind: "page",
      id: String(a._id),
      title: a.title,
      href: `/a/${a.slug}`,
      updated_at: a.updated_at,
      session_id: sid && reached.has(sid) ? sid : null,
      task_id: a.task_id && taskSet.has(String(a.task_id)) ? String(a.task_id) : null,
      slug: a.slug,
      version: a.version,
      page_kind: a.kind ?? "html",
    });
  }

  // Docs: filed under the project or its plans, or written by its newest
  // sessions, read newest first until the byte budget runs out.
  const docRows = new Map<string, Doc<"docs">>();
  let docBudget = DOC_BYTES;
  const addDocs = async (q: AsyncIterable<Doc<"docs">>, max: number) => {
    let n = 0;
    for await (const d of q) {
      if (docBudget <= 0) { truncated = true; return; }
      if (n++ >= max) return;
      docBudget -= docBytes(d);
      docRows.set(String(d._id), d);
    }
  };
  // Twice the shown count: archived docs are read and then left out.
  await addDocs(ctx.db.query("docs").withIndex("by_project_id", (q: any) => q.eq("project_id", project._id)).order("desc"), DOCS_MAX * 2);
  for (const id of planIds) await addDocs(ctx.db.query("docs").withIndex("by_plan_id", (q: any) => q.eq("plan_id", id)).order("desc"), DOCS_MAX);
  for (const id of sessionIds.slice(0, DOC_SESSIONS)) await addDocs(ctx.db.query("docs").withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", id)).order("desc"), DOCS_PER_SESSION);
  const docsSorted = [...docRows.values()].filter((d) => !d.archived_at).sort((a, b) => b.updated_at - a.updated_at);
  if (docsSorted.length > DOCS_MAX) truncated = true;
  const docs: ProjectOutputItems["docs"] = [];
  for (const d of docsSorted.slice(0, DOCS_MAX)) {
    if (!(await mayRead("docs", d))) continue;
    const sid = d.conversation_id ? String(d.conversation_id) : null;
    docs.push({
      kind: "doc",
      id: String(d._id),
      title: (d as any).display_title ?? d.title,
      href: `/docs/${d._id}`,
      updated_at: d.updated_at,
      session_id: sid && reached.has(sid) ? sid : null,
      task_id: (d.task_ids ?? []).map(String).find((id) => taskSet.has(id)) ?? null,
      doc_type: d.doc_type,
    });
  }

  return { project_id: String(project._id), prs, pages, docs, truncated };
}

/** Both parts in one read, for the CLI. */
export async function computeProjectOutputs(ctx: Ctx, viewerId: Id<"users">, project: Doc<"projects">): Promise<ProjectOutputs> {
  const members = await computeProjectMembers(ctx, viewerId, project);
  return joinProjectOutputs(members, await computeProjectItems(ctx, viewerId, project, outputItemArgs(members)));
}

async function readableProject(ctx: any, apiToken: string | undefined, ref: string) {
  const userId = await getAuthenticatedUserId(ctx, apiToken);
  if (!userId) return null;
  const project = await findProjectByRef(ctx, ref);
  return project && (await canAccessProject(ctx, userId, project)) ? { userId, project } : null;
}

// `cast project outputs`. A caller who cannot read the project gets null,
// never a hint that it exists.
export const get = query({
  args: { api_token: v.optional(v.string()), project_id: v.string() },
  handler: async (ctx, args): Promise<ProjectOutputs | null> => {
    const r = await readableProject(ctx, args.api_token, args.project_id);
    return r ? computeProjectOutputs(ctx, r.userId, r.project) : null;
  },
});

// The project page's Outputs view, part one: sessions, tasks and images.
export const members = query({
  args: { api_token: v.optional(v.string()), project_id: v.string() },
  handler: async (ctx, args): Promise<ProjectOutputMembers | null> => {
    const r = await readableProject(ctx, args.api_token, args.project_id);
    return r ? computeProjectMembers(ctx, r.userId, r.project) : null;
  },
});

// Part two: pull requests, pages and docs, by the ids part one returned.
export const items = query({
  args: {
    api_token: v.optional(v.string()),
    project_id: v.string(),
    session_ids: v.array(v.string()),
    elsewhere_ids: v.array(v.string()),
    task_ids: v.array(v.string()),
    plan_ids: v.array(v.string()),
  },
  handler: async (ctx, args): Promise<ProjectOutputItems | null> => {
    const r = await readableProject(ctx, args.api_token, args.project_id);
    return r ? computeProjectItems(ctx, r.userId, r.project, args) : null;
  },
});
