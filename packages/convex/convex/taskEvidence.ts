// Evidence attaches at the station (docs/architecture/the-line.md L6).
//
// One place decides which task and station a published page belongs to
// (`resolveEvidenceBinding`): `cast publish --task/--plan`, a publish from a
// session bound to a task, and `cast task handoff --page` all end here, so the
// three paths cannot stamp a page differently. `computeTaskEvidence` is the one
// object the task page and `cast task show` render: pages grouped by station,
// docs linked to the task, images from the task's sessions, the handoff
// fields, the PR and the review verdict.
import { v } from "convex/values";
import { query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { getAuthenticatedUserId } from "./pendingMessages";
import { canAccessDoc, canAccessPlan, canAccessTask } from "./lib/access";
import { linkedSessionsFor } from "./tasks";

type Ctx = { db: any; storage?: any };

const IMAGES_MAX = 12;
const WORKSPACE_DOC_SCAN = 300;

// `ct-N` (the short id the CLI prints) or a raw Convex id.
export async function findTaskByRef(ctx: Ctx, ref: string): Promise<any | null> {
  if (/^ct-\d+$/.test(ref)) {
    return (await ctx.db.query("tasks").withIndex("by_short_id", (q: any) => q.eq("short_id", ref)).first()) ?? null;
  }
  const id = ctx.db.normalizeId("tasks", ref);
  return id ? await ctx.db.get(id) : null;
}

// `pl-N` or a raw Convex id.
export async function findPlanByRef(ctx: Ctx, ref: string): Promise<any | null> {
  if (/^pl-\d+$/.test(ref)) {
    return (await ctx.db.query("plans").withIndex("by_short_id", (q: any) => q.eq("short_id", ref)).first()) ?? null;
  }
  const id = ctx.db.normalizeId("plans", ref);
  return id ? await ctx.db.get(id) : null;
}

// A task's station is its status (L3). The same rule askCore uses for a
// decision's station, so a page and a hold on the same task name one station.
export const stationOf = (task: any): string => task.status_id ?? task.status;

export type EvidenceBinding = {
  task_id?: Id<"tasks">;
  plan_id?: Id<"plans">;
  station?: string;
  // Short ids for the caller's output; never stored.
  task_short_id?: string;
  plan_short_id?: string;
};

/**
 * L6: which task and station a page attaches to. An explicit task or plan
 * wins; a missing or inaccessible ref is an error so a publish never lands
 * on the wrong task silently. With no flag, a publish from a session bound to
 * a task (its active task) attaches to that task at its current status. A
 * task under a plan carries the plan too, so the plan's by_plan read sees it.
 */
export async function resolveEvidenceBinding(
  ctx: Ctx,
  userId: Id<"users">,
  args: { task?: string; plan?: string; session_conversation_id?: Id<"conversations"> | string; station?: string },
): Promise<{ binding: EvidenceBinding; error: null } | { binding: null; error: string }> {
  const binding: EvidenceBinding = {};
  if (args.task) {
    const task = await findTaskByRef(ctx, args.task);
    if (!task || !(await canAccessTask(ctx as any, userId, task))) return { binding: null, error: `Task not found: ${args.task}` };
    binding.task_id = task._id;
    binding.task_short_id = task.short_id;
    binding.station = args.station ?? stationOf(task);
    if (task.plan_id && !args.plan) binding.plan_id = task.plan_id;
  }
  if (args.plan) {
    const plan = await findPlanByRef(ctx, args.plan);
    if (!plan || !(await canAccessPlan(ctx as any, userId, plan))) return { binding: null, error: `Plan not found: ${args.plan}` };
    binding.plan_id = plan._id;
    binding.plan_short_id = plan.short_id;
  }
  if (!args.task && !args.plan && args.session_conversation_id) {
    const conv = await ctx.db.get(args.session_conversation_id);
    const task = conv?.active_task_id ? await ctx.db.get(conv.active_task_id) : null;
    if (task && (await canAccessTask(ctx as any, userId, task))) {
      binding.task_id = task._id;
      binding.task_short_id = task.short_id;
      binding.station = stationOf(task);
      if (task.plan_id) binding.plan_id = task.plan_id;
    }
  }
  return { binding, error: null };
}

/** The stored fields of a binding, for a patch or an insert. */
export function evidencePatch(binding: EvidenceBinding): { task_id?: Id<"tasks">; plan_id?: Id<"plans">; station?: string } {
  const out: { task_id?: Id<"tasks">; plan_id?: Id<"plans">; station?: string } = {};
  if (binding.task_id) out.task_id = binding.task_id;
  if (binding.plan_id) out.plan_id = binding.plan_id;
  if (binding.station) out.station = binding.station;
  return out;
}

const storageUrl = async (ctx: Ctx, storageId: any): Promise<string | undefined> =>
  storageId && ctx.storage?.getUrl ? (await ctx.storage.getUrl(storageId)) ?? undefined : undefined;

export type EvidencePage = {
  id: string;
  slug: string;
  title: string;
  version: number;
  kind: string;
  station: string | null;
  thumbnail_url: string | null;
  href: string;
  updated_at: number;
};

export type TaskEvidence = {
  task: { id: string; short_id: string; station: string };
  pages: EvidencePage[];
  stations: Array<{ station: string; pages: EvidencePage[] }>;
  docs: Array<{ id: string; title: string; doc_type: string; updated_at: number; href: string }>;
  images: Array<{ url: string; conversation_id: string; message_id: string; timestamp: number }>;
  files_changed: string[];
  verification_evidence: string | null;
  execution_status: string | null;
  pr_url: string | null;
  review_verdict: { verdict: string; at: number; note?: string; by_conversation_id?: string } | null;
};

// The handoff writes the PR only into its review comment ("PR: <url>",
// handoffCommentText in the CLI); the newest such line is the task's PR.
export function prUrlFromComments(comments: Array<{ text?: string; created_at: number }>): string | null {
  const sorted = [...comments].sort((a, b) => b.created_at - a.created_at);
  for (const c of sorted) {
    const m = (c.text ?? "").match(/^PR:\s*(\S+)/m);
    if (m) return m[1];
  }
  return null;
}

// How many linked sessions feed the docs and images reads. The task's own
// conversation_ids come first, then the comment trail's sessions, newest last.
const LINKED_SESSIONS_MAX = 20;

export async function computeTaskEvidence(ctx: Ctx, viewerId: Id<"users">, task: any): Promise<TaskEvidence> {
  const comments: any[] = await ctx.db.query("task_comments").withIndex("by_task_created", (q: any) => q.eq("task_id", task._id)).order("desc").take(50);
  // The sessions whose work the task is: the ones `cast task show` lists.
  // linkedSessionsFor unions the task's conversation_ids with the comment
  // trail's sessions and keeps only those the viewer can read in the task's
  // workspace, so a linked session that is private to its owner shows a
  // teammate no images and no docs. Linked sessions stay linked after the
  // task closes (active_task_id is cleared then), so evidence survives the
  // move to done.
  const linkedConversationIds = (await linkedSessionsFor(ctx, viewerId, task, comments, LINKED_SESSIONS_MAX)).map((s) => s.conversation_id);
  const pagesRaw: any[] = await ctx.db.query("artifacts").withIndex("by_task", (q: any) => q.eq("task_id", task._id)).collect();
  pagesRaw.sort((a, b) => b.updated_at - a.updated_at);
  const pages: EvidencePage[] = [];
  for (const a of pagesRaw) {
    pages.push({
      id: String(a._id),
      slug: a.slug,
      title: a.title,
      version: a.version,
      kind: a.kind ?? "html",
      station: a.station ?? null,
      thumbnail_url: (a.kind === "image" ? await storageUrl(ctx, a.storage_id) : await storageUrl(ctx, a.thumb_storage_id)) ?? null,
      href: `/a/${a.slug}`,
      updated_at: a.updated_at,
    });
  }
  const byStation = new Map<string, EvidencePage[]>();
  for (const p of pages) {
    const key = p.station ?? "";
    if (!byStation.has(key)) byStation.set(key, []);
    byStation.get(key)!.push(p);
  }
  const stations = Array.from(byStation, ([station, rows]) => ({ station, pages: rows }));

  // Docs carry task_ids, which no index covers: read the task's project, plan
  // and sessions, plus the newest docs of its workspace, then keep the ones
  // that name the task.
  const docById = new Map<string, any>();
  const addDocs = (rows: any[]) => { for (const d of rows) docById.set(String(d._id), d); };
  if (task.project_id) addDocs(await ctx.db.query("docs").withIndex("by_project_id", (q: any) => q.eq("project_id", task.project_id)).collect());
  if (task.plan_id) addDocs(await ctx.db.query("docs").withIndex("by_plan_id", (q: any) => q.eq("plan_id", task.plan_id)).collect());
  for (const cid of linkedConversationIds) {
    addDocs(await ctx.db.query("docs").withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", cid)).collect());
  }
  if (task.workspace) addDocs(await ctx.db.query("docs").withIndex("by_workspace", (q: any) => q.eq("workspace", task.workspace)).order("desc").take(WORKSPACE_DOC_SCAN));
  const docs: TaskEvidence["docs"] = [];
  for (const d of docById.values()) {
    if (d.archived_at) continue;
    if (!(d.task_ids ?? []).some((id: any) => String(id) === String(task._id))) continue;
    if (!(await canAccessDoc(ctx as any, viewerId, d))) continue;
    docs.push({ id: String(d._id), title: d.display_title ?? d.title, doc_type: d.doc_type, updated_at: d.updated_at, href: `/docs/${d._id}` });
  }
  docs.sort((a, b) => b.updated_at - a.updated_at);

  // Images from cast image have no row of their own; the message that carries
  // them lands in conversation_images, so a linked session's images are the
  // task's images (L6). Newest 12 across the sessions.
  const imagesRaw: any[] = [];
  for (const cid of linkedConversationIds) {
    const rows: any[] = await ctx.db.query("conversation_images").withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", cid)).order("desc").take(IMAGES_MAX);
    imagesRaw.push(...rows);
  }
  imagesRaw.sort((a, b) => b.timestamp - a.timestamp || b.seq - a.seq);
  const images: TaskEvidence["images"] = [];
  for (const img of imagesRaw.slice(0, IMAGES_MAX)) {
    const url = (await storageUrl(ctx, img.storage_id)) ?? img.src;
    if (!url) continue;
    images.push({ url, conversation_id: String(img.conversation_id), message_id: String(img.message_id), timestamp: img.timestamp });
  }

  return {
    task: { id: String(task._id), short_id: task.short_id, station: stationOf(task) },
    pages,
    stations,
    docs,
    images,
    files_changed: task.files_changed ?? [],
    verification_evidence: task.verification_evidence ?? null,
    execution_status: task.execution_status ?? null,
    pr_url: prUrlFromComments(comments),
    review_verdict: task.review_verdict
      ? { verdict: task.review_verdict.verdict, at: task.review_verdict.at, note: task.review_verdict.note, by_conversation_id: task.review_verdict.by_conversation_id ? String(task.review_verdict.by_conversation_id) : undefined }
      : null,
  };
}

// tasks.evidence (L6): the caller must be able to read the task; a stranger
// gets nothing, and the answer never says whether the task exists.
export const get = query({
  args: { api_token: v.optional(v.string()), task_id: v.string() },
  handler: async (ctx, args): Promise<TaskEvidence | null> => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) return null;
    const task = await findTaskByRef(ctx, args.task_id);
    if (!task || !(await canAccessTask(ctx, userId, task))) return null;
    return computeTaskEvidence(ctx, userId, task);
  },
});
