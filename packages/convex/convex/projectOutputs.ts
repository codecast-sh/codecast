// A project's outputs (ct-94262): every pull request, published page, doc and
// image its work produced, each named with the session that made it and the
// task it was for. The project's sessions are derived (session-projects.md
// SP1): the sessions filed under it, the sessions its tasks and plans list,
// and their workers, each kept only when the shared rule puts it in this
// project, so a worker bound to a task in another project brings nothing
// here but the pull requests that name one of this project's tasks.
//
// Access: every output passes its own check (a pull request its team, a page
// the gallery rule, a doc its workspace key, an image its session), and a
// session or task is named only when the viewer may open it.
import { v } from "convex/values";
import { query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { getAuthenticatedUserId } from "./pendingMessages";
import { accessJudgeFor, canAccessConversation, canAccessProject, canAccessPullRequest } from "./lib/access";
import { viewerSeesPage } from "./artifacts";
import { effectiveSessionProjectId, sessionProjectCache } from "./sessionProjects";
import { sessionImages, storageUrl } from "./lib/sessionMedia";
import { codecastPrPath, foldShepherdState } from "@codecast/shared/contracts";

type Ctx = { db: any; storage?: any };

/** Sessions filed under the project, newest first. */
const ROOT_SESSIONS = 100;
/** Every session the query considers, roots, task sessions and workers. */
const SESSIONS_MAX = 250;
/** Workers read per session, newest first, on each parent link. */
const CHILDREN_PER_SESSION = 30;
/** Tasks read per triage state, newest first. */
const TASKS_PER_STATE = 300;
/** Pull request rows carry files and patches (up to 1 MB), so few are read. */
const PRS_MAX = 60;
const PAGES_MAX = 80;
const DOCS_MAX = 80;
const IMAGES_MAX = 24;
/** The newest sessions whose images are read. */
const IMAGE_SESSIONS = 20;

export type OutputSession = { id: string; short_id: string | null; title: string };
export type OutputTask = { id: string; short_id: string; title: string };
export type PrGroup = "attention" | "review" | "done";

type OutputBase = {
  id: string;
  title: string;
  href: string;
  updated_at: number;
  session: OutputSession | null;
  task: OutputTask | null;
};

export type OutputPr = OutputBase & {
  kind: "pr";
  repository: string;
  number: number;
  github_url: string;
  state: "open" | "closed" | "merged";
  draft: boolean;
  /** foldShepherdState: the one word the shepherd card shows. */
  status: string;
  group: PrGroup;
  review_decision: string | null;
  checks_state: string | null;
  behind_by: number | null;
  unresolved_review_count: number | null;
};
export type OutputPage = OutputBase & { kind: "page"; slug: string; version: number; page_kind: string; thumbnail_url: string | null };
export type OutputDoc = OutputBase & { kind: "doc"; doc_type: string };
export type OutputImage = OutputBase & { kind: "image"; url: string; message_id: string };

export type ProjectOutputs = {
  project: { id: string; short_id: string | null; title: string };
  prs: OutputPr[];
  pages: OutputPage[];
  docs: OutputDoc[];
  images: OutputImage[];
  /** A cap cut the read short: older outputs exist past what is shown. */
  truncated: boolean;
};

/** Which group a pull request sits in: what only the author can clear needs
 *  attention, waiting on CI or reviewers is in review, merged and closed are
 *  done. The same fold the shepherd card reads, so the two never disagree. */
export function prGroupOf(status: string): PrGroup {
  if (status === "merged" || status === "closed") return "done";
  if (status === "conflicts" || status === "behind" || status === "ci_red" || status === "changes_requested") return "attention";
  return "review";
}

/** A project by Convex id or pj- short id. */
export async function findProjectByRef(ctx: Ctx, ref: string): Promise<Doc<"projects"> | null> {
  const id = ctx.db.normalizeId("projects", ref);
  if (id) return await ctx.db.get(id);
  return (await ctx.db.query("projects").withIndex("by_short_id", (q: any) => q.eq("short_id", ref)).first()) ?? null;
}

export async function computeProjectOutputs(ctx: Ctx, viewerId: Id<"users">, project: Doc<"projects">): Promise<ProjectOutputs> {
  const projectKey = String(project._id);
  const mayRead = await accessJudgeFor(ctx as any, viewerId);
  let truncated = false;

  // Tasks: the project's, by triage state so filed suggestions are never read
  // (org.resolveScope's rule), plus its plans' tasks that name no other project.
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
    const rows = await ctx.db.query("tasks").withIndex("by_plan_id", (q: any) => q.eq("plan_id", plan._id)).order("desc").take(TASKS_PER_STATE);
    admitTasks(rows.filter((t: any) => t.triage_status === undefined || t.triage_status === "active"));
  }
  const taskRef = new Map<string, OutputTask>();
  for (const t of tasks.values()) {
    if (await mayRead("tasks", t)) taskRef.set(String(t._id), { id: String(t._id), short_id: t.short_id ?? String(t._id), title: t.title });
  }

  // Sessions: filed under the project, listed by its tasks and plans, then
  // their workers breadth first. Each row read once.
  const cache = sessionProjectCache();
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
  const listed = new Set<string>();
  const tasksNewest = [...tasks.values()].sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0));
  for (const ids of [...tasksNewest.map((t) => t.conversation_ids ?? []), ...plans.map((p: any) => p.session_ids ?? [])]) {
    for (const id of ids) {
      if (candidates.size >= SESSIONS_MAX) break;
      listed.add(String(id));
      if (!candidates.has(String(id))) consider(await ctx.db.get(id));
    }
  }
  for (let i = 0; i < queue.length && candidates.size < SESSIONS_MAX; i++) {
    const parent = queue[i];
    for (const index of ["by_parent_conversation_id", "by_spawned_by"] as const) {
      const field = index === "by_parent_conversation_id" ? "parent_conversation_id" : "spawned_by_conversation_id";
      const kids = await ctx.db.query("conversations").withIndex(index, (q: any) => q.eq(field, parent._id)).order("desc").take(CHILDREN_PER_SESSION);
      kids.forEach(consider);
    }
  }
  for (const t of tasks.values()) cache.taskProjects.set(String(t._id), t.project_id ? String(t.project_id) : null);

  // In the project by SP1, or listed on one of its tasks: the latter brings
  // only pull requests that name a project task (below).
  const inProject = new Map<string, Doc<"conversations">>();
  const taskListed = new Map<string, Doc<"conversations">>();
  for (const c of candidates.values()) {
    if (!(await canAccessConversation(ctx as any, viewerId, c as any))) continue;
    const pid = await effectiveSessionProjectId(ctx, c, cache);
    if (pid && String(pid) === projectKey) inProject.set(String(c._id), c);
    else if (listed.has(String(c._id))) taskListed.set(String(c._id), c);
  }
  const sessionRef = (id: any): OutputSession | null => {
    const c = id ? inProject.get(String(id)) ?? taskListed.get(String(id)) : undefined;
    return c ? { id: String(c._id), short_id: c.short_id ?? null, title: c.title || "(untitled)" } : null;
  };
  const sessionTask = (id: any): OutputTask | null => {
    const c = id ? inProject.get(String(id)) ?? taskListed.get(String(id)) : undefined;
    return c?.active_task_id ? taskRef.get(String(c.active_task_id)) ?? null : null;
  };
  const sessionsNewest = [...inProject.values()].sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0));
  const reached = [...sessionsNewest, ...taskListed.values()];

  // Pull requests: every link row of the sessions reached, newest session first.
  const links = new Map<string, { sessions: Array<{ id: string; committed: boolean }> }>();
  const linkRows = await Promise.all(reached.map((c) => ctx.db.query("pull_request_sessions").withIndex("by_conversation", (q: any) => q.eq("conversation_id", c._id)).collect()));
  for (const rows of linkRows) {
    for (const row of rows) {
      const key = String(row.pull_request_id);
      const entry = links.get(key) ?? { sessions: [] };
      entry.sessions.push({ id: String(row.conversation_id), committed: row.tier === "committed" });
      links.set(key, entry);
    }
  }
  if (links.size > PRS_MAX) truncated = true;
  const teamMember = new Map<string, boolean>();
  const prs: OutputPr[] = [];
  for (const [prId, link] of [...links].slice(0, PRS_MAX)) {
    const pr: Doc<"pull_requests"> | null = await ctx.db.get(prId as Id<"pull_requests">);
    if (!pr) continue;
    const teamKey = String(pr.team_id);
    if (!teamMember.has(teamKey)) teamMember.set(teamKey, await canAccessPullRequest(ctx as any, viewerId, pr));
    if (!teamMember.get(teamKey)) continue;
    const namedTask = (pr.task_ids ?? []).map((id) => taskRef.get(String(id))).find(Boolean) ?? null;
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
      session: sessionRef(maker?.id),
      task: namedTask ?? sessionTask(maker?.id),
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
  for (const rows of await Promise.all(sessionsNewest.map((c) => ctx.db.query("artifacts").withIndex("by_session_conversation", (q: any) => q.eq("session_conversation_id", c._id)).collect()))) addPages(rows);
  for (const rows of await Promise.all([...taskRef.keys()].map((id) => ctx.db.query("artifacts").withIndex("by_task", (q: any) => q.eq("task_id", id)).collect()))) addPages(rows);
  for (const rows of await Promise.all(plans.map((p) => ctx.db.query("artifacts").withIndex("by_plan", (q: any) => q.eq("plan_id", p._id)).collect()))) addPages(rows);
  const pagesSorted = [...pageRows.values()].sort((a, b) => b.updated_at - a.updated_at);
  if (pagesSorted.length > PAGES_MAX) truncated = true;
  const pages: OutputPage[] = [];
  for (const a of pagesSorted.slice(0, PAGES_MAX)) {
    if (a.expires_at && a.expires_at < Date.now()) continue;
    if (!(await viewerSeesPage(ctx as any, viewerId, a))) continue;
    pages.push({
      kind: "page",
      id: String(a._id),
      title: a.title,
      href: `/a/${a.slug}`,
      updated_at: a.updated_at,
      session: sessionRef(a.session_conversation_id),
      task: (a.task_id ? taskRef.get(String(a.task_id)) : null) ?? sessionTask(a.session_conversation_id),
      slug: a.slug,
      version: a.version,
      page_kind: a.kind ?? "html",
      thumbnail_url: (a.kind === "image" ? await storageUrl(ctx, a.storage_id) : await storageUrl(ctx, a.thumb_storage_id)) ?? null,
    });
  }

  // Docs: filed under the project or its plans, or written by its sessions.
  const docRows = new Map<string, Doc<"docs">>();
  const addDocs = (rows: Doc<"docs">[]) => { for (const d of rows) docRows.set(String(d._id), d); };
  addDocs(await ctx.db.query("docs").withIndex("by_project_id", (q: any) => q.eq("project_id", project._id)).order("desc").take(DOCS_MAX * 2));
  for (const rows of await Promise.all(plans.map((p) => ctx.db.query("docs").withIndex("by_plan_id", (q: any) => q.eq("plan_id", p._id)).take(DOCS_MAX)))) addDocs(rows);
  for (const rows of await Promise.all(sessionsNewest.map((c) => ctx.db.query("docs").withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", c._id)).take(DOCS_MAX)))) addDocs(rows);
  const docsSorted = [...docRows.values()].filter((d) => !d.archived_at).sort((a, b) => b.updated_at - a.updated_at);
  if (docsSorted.length > DOCS_MAX) truncated = true;
  const docs: OutputDoc[] = [];
  for (const d of docsSorted.slice(0, DOCS_MAX)) {
    if (!(await mayRead("docs", d))) continue;
    const namedTask = (d.task_ids ?? []).map((id) => taskRef.get(String(id))).find(Boolean) ?? null;
    docs.push({
      kind: "doc",
      id: String(d._id),
      title: (d as any).display_title ?? d.title,
      href: `/docs/${d._id}`,
      updated_at: d.updated_at,
      session: sessionRef(d.conversation_id),
      task: namedTask ?? sessionTask(d.conversation_id),
      doc_type: d.doc_type,
    });
  }

  // Images: what the newest sessions in the project posted.
  const found = (await Promise.all(sessionsNewest.slice(0, IMAGE_SESSIONS).map((c) => sessionImages(ctx, c._id, { since: 0, max: IMAGES_MAX })))).flat();
  found.sort((a, b) => b.timestamp - a.timestamp || b.seq - a.seq);
  const images: OutputImage[] = found.slice(0, IMAGES_MAX).map((img) => {
    const c = inProject.get(String(img.conversation_id))!;
    return {
      kind: "image",
      id: `${img.message_id}:${img.seq}`,
      title: c.title || "(untitled)",
      href: `/conversation/${c._id}#msg-${img.message_id}`,
      updated_at: img.timestamp,
      session: sessionRef(img.conversation_id),
      task: sessionTask(img.conversation_id),
      url: img.url,
      message_id: String(img.message_id),
    };
  });

  return {
    project: { id: projectKey, short_id: project.short_id ?? null, title: project.title },
    prs,
    pages,
    docs,
    images,
    truncated,
  };
}

// The project page's Outputs view and `cast project outputs`. A caller who
// cannot read the project gets null, never a hint that it exists.
export const get = query({
  args: { api_token: v.optional(v.string()), project_id: v.string() },
  handler: async (ctx, args): Promise<ProjectOutputs | null> => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) return null;
    const project = await findProjectByRef(ctx, args.project_id);
    if (!project || !(await canAccessProject(ctx, userId, project))) return null;
    return computeProjectOutputs(ctx, userId, project);
  },
});
