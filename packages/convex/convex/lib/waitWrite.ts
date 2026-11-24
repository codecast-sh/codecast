// The one writer of a task's waits (`tasks.waits`, docs/architecture/task-graph.md
// TG2), and the words stored text about them is written in. taskWaits.ts adds,
// removes and settles waits through writeWaits; lib/waitSetters.ts stamps the
// setters it has told.

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../functions";
import { recordTaskChange, type TaskChangeBy, type TaskFieldChange } from "./taskHistory";
import { patchTask } from "./taskWrite";
import { prByNumber } from "./gitRefs";
import { isPrWaitTarget, prWords, waitLine, type TaskWait, type WaitLabelOptions } from "@codecast/shared/tasks";
import { normalizeRepository, repositoryKeyOfRemote } from "@codecast/shared/contracts";

type Ctx = MutationCtx;
type Task = Doc<"tasks">;
type PR = Doc<"pull_requests">;

/** Stored text about a wait is read later, in other zones (TG11). */
export const STORED = { absolute: true } as const;

/** STORED for `task`'s own text. It is also read away from any checkout, so a
 *  PR outside the task's one repository (taskRepositories) is named in full. */
export async function storedWords(ctx: Ctx, task: Task, waits: TaskWait[] = task.waits ?? []): Promise<WaitLabelOptions> {
  if (!waits.some(isPrWaitTarget)) return STORED;
  const repos = await taskRepositories(ctx, task);
  return { ...STORED, ...prWords(repos.length === 1 ? repos[0] : null) };
}

// ---------------------------------------------------------------------------
// The one writer
// ---------------------------------------------------------------------------

/**
 * Replace `task`'s waits with `next`. Recomputes `waiting_since` (kept while
 * any wait still waits, cleared otherwise), writes one history line per wait
 * that was added, settled, reopened or removed, and links each new PR or
 * decision wait from its target (`waiting_task_ids`). Returns the row as
 * written and the words its waits are stored in (storedWords), for the
 * caller's own text about them.
 */
export async function writeWaits(ctx: Ctx, task: Task, next: TaskWait[], by: TaskChangeBy, now = Date.now()): Promise<{ task: Task; words: WaitLabelOptions }> {
  const prev = task.waits ?? [];
  const waiting_since = next.some((w) => w.state === "waiting") ? (task.waiting_since ?? now) : undefined;
  await patchTask(ctx, task, { waits: next, waiting_since, updated_at: now });

  const before = new Map(prev.map((w) => [w.id, w]));
  const kept = new Set(next.map((w) => w.id));
  const words = await storedWords(ctx, task, [...prev, ...next]);
  // Both sides of a line are rendered in today's words, so a wait left as it
  // was renders the same twice and recordTaskChange writes nothing for it.
  const changes: TaskFieldChange[] = [
    ...prev.filter((w) => !kept.has(w.id)).map((w): TaskFieldChange => ["waits", waitLine(w, words), ""]),
    ...next.map((w): TaskFieldChange => ["waits", before.has(w.id) ? waitLine(before.get(w.id)!, words) : "", waitLine(w, words)]),
  ];
  await recordTaskChange(ctx, task._id, by, changes, now);

  for (const w of next) {
    if (before.has(w.id) || w.kind === "time") continue;
    // A decision is linked even when met at once, so a reopen finds it.
    const target = w.kind === "decision" ? await decisionByShortId(ctx, w.decision)
      : w.state === "waiting" ? await prByNumber(ctx, w.repository, w.pr_number)
      : null;
    if (target) await linkTask(ctx, target, task._id);
  }
  return { task: { ...task, waits: next, waiting_since, updated_at: now }, words };
}

/** Add `taskId` to a wait target's back reference. */
export async function linkTask(ctx: Ctx, target: Doc<"session_decisions"> | PR, taskId: Id<"tasks">): Promise<boolean> {
  const linked = target.waiting_task_ids ?? [];
  if (linked.some((id) => String(id) === String(taskId))) return false;
  await ctx.db.patch(target._id, { waiting_task_ids: [...linked, taskId] });
  return true;
}

export async function decisionByShortId(ctx: Pick<Ctx, "db">, shortId: string) {
  return await ctx.db.query("session_decisions").withIndex("by_short_id", (q) => q.eq("short_id", shortId)).first();
}

/** The repositories a task's work happens in: the mapped checkout covering its
 *  project's path, and the remotes of the sessions on it. */
export async function taskRepositories(ctx: Ctx, task: Task): Promise<string[]> {
  const out = new Set<string>();
  const project = task.project_id ? await ctx.db.get(task.project_id) : null;
  const path = task.project_path || project?.project_path;
  if (path) {
    const mappings = [
      ...(await ctx.db.query("directory_team_mappings").withIndex("by_user_id", (q) => q.eq("user_id", task.user_id)).collect()),
      ...(task.team_id ? await ctx.db.query("directory_team_mappings").withIndex("by_team_id", (q) => q.eq("team_id", task.team_id)).collect() : []),
    ];
    for (const m of mappings) {
      const prefix = m.path_prefix.replace(/\/+$/, "");
      if (m.repository && (path === prefix || path.startsWith(`${prefix}/`))) out.add(normalizeRepository(m.repository));
    }
  }
  const sessions = [task.created_from_conversation, ...(task.conversation_ids ?? [])].filter((id): id is Id<"conversations"> => !!id);
  for (const id of [...new Set(sessions.map(String))].slice(0, 20)) {
    const conv = await ctx.db.get(id as Id<"conversations">);
    const repo = repositoryKeyOfRemote(conv?.git_remote_url);
    if (repo) out.add(normalizeRepository(repo));
  }
  return [...out];
}
