// TEMPORARY: size one conversation's materialized file changes. Aggregates
// only, never content. Run:
//   packages/convex/run.sh debugFileChangeWeight:byConversation '{"conversation_id":"<id>"}'
import { internalQuery } from "./functions";
import { v } from "convex/values";

export const byConversation = internalQuery({
  args: { conversation_id: v.id("conversations") },
  handler: async (ctx, args) => {
    const perFile = new Map<string, { rows: number; writes: number; edits: number; oldBytes: number; newBytes: number; maxRow: number }>();
    let rows = 0;
    let bytes = 0;
    let jsonBytes = 0;
    const byType: Record<string, number> = {};
    const query = ctx.db
      .query("file_changes")
      .withIndex("by_conversation_id", (q) => q.eq("conversation_id", args.conversation_id));
    for await (const r of query) {
      rows++;
      const o = r.old_content?.length ?? 0;
      const n = r.new_content?.length ?? 0;
      bytes += o + n;
      jsonBytes += JSON.stringify(r).length;
      byType[r.change_type] = (byType[r.change_type] ?? 0) + 1;
      const f = perFile.get(r.file_path) ?? { rows: 0, writes: 0, edits: 0, oldBytes: 0, newBytes: 0, maxRow: 0 };
      f.rows++;
      if (r.change_type === "write") f.writes++;
      if (r.change_type === "edit") f.edits++;
      f.oldBytes += o;
      f.newBytes += n;
      f.maxRow = Math.max(f.maxRow, o + n);
      perFile.set(r.file_path, f);
    }
    const top = Array.from(perFile.entries())
      .sort((a, b) => (b[1].oldBytes + b[1].newBytes) - (a[1].oldBytes + a[1].newBytes))
      .slice(0, 12)
      .map(([path, f]) => ({ path: path.slice(-60), ...f, totalBytes: f.oldBytes + f.newBytes }));
    return { rows, files: perFile.size, contentBytes: bytes, jsonBytes, byType, top };
  },
});
