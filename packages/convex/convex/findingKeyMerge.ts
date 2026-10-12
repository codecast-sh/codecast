// Once: trial findings filed before the evidence key named who the words
// were said to (judges.ts evidenceSubject) take that key, and copies of one
// message collapse onto the first filed (docs/architecture/learning-loop.md LL8).
import { v } from "convex/values";
import { internalMutation } from "./functions";
import type { Doc, Id } from "./_generated/dataModel";
import { retireSignals } from "./judgeRetire";
/**
 * For findings filed before the evidence key named who the words were
 * said to (judges.ts evidenceSubject): each finding takes the key the caller
 * computed from its moment, and of the findings that now share a key only
 * the first filed stays; the rest are the same message read again (from a
 * later moment, or from a match that shows a party's email) and retire with
 * a pointer to it, the way moments.ts would have skipped them. Problems are
 * recounted by retireSignals.
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
    const results = [];
    for (const r of retire) {
      results.push(await retireSignals(ctx, [r.row], { reason: `the same message as ${r.keeper.short_id}, filed again from another moment`, actor: args.actor }));
    }
    return { findings: found.length, keys: byKey.size, rekeyed, retire: retire.length, across_problems: split, closed: results.flatMap((x) => x.closed) };
  },
});
