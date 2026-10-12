// Once: trial findings filed before the evidence key named who the words
// were said to (judges.ts evidenceSubject) take that key, and copies of one
// message collapse onto the first filed (docs/architecture/learning-loop.md LL8).
import { v } from "convex/values";
import { internalMutation } from "./functions";
import type { Doc, Id } from "./_generated/dataModel";
import { insertTaskComment, moveTaskStatus } from "./tasks";
import { refreshCauseDescription } from "./signals";

/** Problem statuses a run is working or has finished: those keep their state and only lose the finding. */
const WORKED = new Set(["in_progress", "in_review", "done", "dropped"]);
/**
 * For findings filed before the evidence key named who the words were
 * said to (judges.ts evidenceSubject): each finding takes the key the caller
 * computed from its moment, and of the findings that now share a key only
 * the first filed stays; the rest are the same message read again (from a
 * later moment, or from a match that shows a party's email) and retire with
 * a pointer to it, the way moments.ts would have skipped them. Problems are
 * recounted; one left empty is closed as the duplicate of the problem its
 * messages live on.
 */
export const mergeEvidenceKeys = internalMutation({
  args: { workspace: v.string(), rows: v.array(v.object({ signal: v.string(), key: v.string() })), actor: v.id("users"), dry_run: v.boolean() },
  handler: async (ctx, args) => {
    const found: Array<{ row: Doc<"signals">; key: string }> = [];
    for (const r of args.rows) {
      const row = await ctx.db.query("signals").withIndex("by_short_id", (q: any) => q.eq("short_id", r.signal)).first();
      if (row && row.workspace === args.workspace && !row.retired) found.push({ row, key: r.key });
    }
    const byKey = new Map<string, Array<{ row: Doc<"signals">; key: string }>>();
    for (const f of found) byKey.set(f.key, [...(byKey.get(f.key) ?? []), f]);
    let rekeyed = 0;
    const retire: Array<{ row: Doc<"signals">; keeper: Doc<"signals"> }> = [];
    for (const group of byKey.values()) {
      group.sort((a, b) => a.row.created_at - b.row.created_at);
      const keeper = group[0]!.row;
      for (const [i, f] of group.entries()) {
        if (f.row.fingerprint !== f.key) {
          rekeyed++;
          if (!args.dry_run) await ctx.db.patch(f.row._id, { fingerprint: f.key });
        }
        if (i > 0) retire.push({ row: { ...f.row, fingerprint: f.key }, keeper });
      }
    }
    // Problems keep their key list current: an old key becomes its row's new one.
    const tasks = new Set(found.map((f) => f.row.task_id).filter(Boolean).map(String));
    if (!args.dry_run) {
      for (const id of tasks) {
        const task: Doc<"tasks"> | null = await ctx.db.get(id as Id<"tasks">);
        if (!task?.cause) continue;
        const rename = new Map(found.filter((f) => String(f.row.task_id) === id).map((f) => [f.row.fingerprint, f.key]));
        const fingerprints = [...new Set(task.cause.fingerprints.map((k) => rename.get(k) ?? k))];
        await ctx.db.patch(task._id, { cause: { ...task.cause, fingerprints } });
      }
    }
    const split = retire.filter((r) => String(r.row.task_id) !== String(r.keeper.task_id)).length;
    if (args.dry_run) return { findings: found.length, keys: byKey.size, rekeyed, retire: retire.length, across_problems: split };
    const now = Date.now();
    const byTask = new Map<string, Array<{ row: Doc<"signals">; keeper: Doc<"signals"> }>>();
    for (const r of retire) {
      await ctx.db.patch(r.row._id, { task_id: undefined, retired: { at: now, reason: `the same message as ${r.keeper.short_id}, filed again from another moment`, ...(r.row.task_id ? { task_id: r.row.task_id } : {}) } });
      if (r.row.task_id) byTask.set(String(r.row.task_id), [...(byTask.get(String(r.row.task_id)) ?? []), r]);
    }
    const closed: string[] = [];
    for (const [taskId, gone] of byTask) {
      const task: Doc<"tasks"> | null = await ctx.db.get(taskId as Id<"tasks">);
      if (!task?.cause) continue;
      const left: Doc<"signals">[] = await ctx.db.query("signals").withIndex("by_task", (q: any) => q.eq("task_id", task._id)).collect();
      const keys = new Set(left.map((s) => s.fingerprint));
      await ctx.db.patch(task._id, { cause: { ...task.cause, signal_count: left.length, fingerprints: task.cause.fingerprints.filter((k) => keys.has(k)) }, updated_at: now });
      if (left.length) await refreshCauseDescription(ctx, task._id, gone.map((g) => g.row));
      if (left.length || WORKED.has(task.status)) continue;
      // Every finding it held is a message another problem already holds: it is that problem's duplicate.
      const homes = [...new Set(gone.map((g) => String(g.keeper.task_id ?? "")))].filter(Boolean);
      const home: Doc<"tasks"> | null = homes.length === 1 ? await ctx.db.get(homes[0] as Id<"tasks">) : null;
      await moveTaskStatus(ctx, task, "dropped", { actorUserId: args.actor, actorType: "system", now, ...(home ? { extra: { duplicate_of: home.short_id } } : {}) });
      const copies = gone.map((g) => g.keeper.short_id).join(", ");
      await insertTaskComment(ctx, task._id, { author: "line", comment_type: "note", text: `Closed: ${gone.length === 1 ? "its finding is the same message as" : "its findings are the same messages as"} ${copies}${home ? ` on ${home.short_id}` : ""}, read again from another moment.` });
      closed.push(task.short_id);
    }
    return { findings: found.length, keys: byKey.size, rekeyed, retire: retire.length, across_problems: split, closed };
  },
});

/**
 * Once, for problems a line dissolved before `cast line dissolve` stamped
 * cause.dissolved: the stamp from the closing note the dissolve left (a note
 * opening "Dissolved", or "Dropped: the judge was wrong." before it; older
 * dissolves wrote it under the person who ran the line),
 * at the time the note was written. A problem with no such note is left alone.
 */
export const stampDissolved = internalMutation({
  args: { workspace: v.string(), project_id: v.id("projects"), dry_run: v.boolean() },
  handler: async (ctx, args) => {
    const stamped: string[] = [];
    for (const status of ["done", "dropped"] as const) {
      const tasks: Doc<"tasks">[] = await ctx.db.query("tasks").withIndex("by_source_status_readiness", (q: any) => q.eq("source", "signal").eq("status", status)).collect();
      for (const task of tasks) {
        if (task.workspace !== args.workspace || task.project_id !== args.project_id || !task.cause || task.cause.dissolved) continue;
        const notes: Doc<"task_comments">[] = await ctx.db.query("task_comments").withIndex("by_task_created", (q: any) => q.eq("task_id", task._id)).order("desc").take(100);
        const note = notes.find((c) => /^(Dropped: the judge was wrong\. )?Dissolved\b/.test(c.text ?? ""));
        if (!note) continue;
        stamped.push(task.short_id);
        if (!args.dry_run) await ctx.db.patch(task._id, { cause: { ...task.cause, dissolved: { at: note.created_at, note: note.text ?? "" } } });
      }
    }
    return { stamped: stamped.length, tasks: stamped };
  },
});

/** Takes a stamp back off problems it should not have reached. */
export const clearDissolved = internalMutation({
  args: { workspace: v.string(), tasks: v.array(v.string()) },
  handler: async (ctx, args) => {
    const cleared: string[] = [];
    for (const short of args.tasks) {
      const task = await ctx.db.query("tasks").withIndex("by_short_id", (q: any) => q.eq("short_id", short)).first();
      if (!task || task.workspace !== args.workspace || !task.cause?.dissolved) continue;
      const { dissolved: _, ...cause } = task.cause;
      await ctx.db.patch(task._id, { cause });
      cleared.push(short);
    }
    return { cleared };
  },
});
