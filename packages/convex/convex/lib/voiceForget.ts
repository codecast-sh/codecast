// Forgetting a person's voice (docs/architecture/speaker-attribution.md,
// "Enrollment and consent"): their samples, any copy an engine holds, and
// every voice-match suggestion that names them. Run when they turn
// recognition off, delete their samples, or delete their account. A leaf
// (no function definitions), so accountDelete and voiceprints both call it.
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";

/** Delete every sample of `userId`'s voice, ask each engine that holds a
 *  copy (`ref`) to delete it, and schedule the scrub of suggestions naming
 *  them in their teams' recordings. Returns how many samples went. */
export async function forgetVoice(ctx: any, userId: Id<"users">): Promise<number> {
  const rows: Doc<"voiceprints">[] = await ctx.db
    .query("voiceprints")
    .withIndex("by_user", (q: any) => q.eq("user_id", userId))
    .collect();
  const refs = new Map<string, string[]>();
  for (const r of rows) {
    if (r.ref) refs.set(r.engine, [...(refs.get(r.engine) ?? []), r.ref]);
    await ctx.db.delete(r._id);
  }
  for (const [engine, list] of refs) {
    await ctx.scheduler.runAfter(0, internal.voiceprints.forgetEngineRefs, { engine, refs: list });
  }
  const memberships = await ctx.db
    .query("team_memberships")
    .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
    .collect();
  const team_ids = [...new Set(memberships.map((m: any) => String(m.team_id)))] as Id<"teams">[];
  if (team_ids.length) {
    await ctx.scheduler.runAfter(0, internal.voiceprints.scrubVoiceSuggestions, { user_id: userId, team_ids, cursor: null });
  }
  return rows.length;
}
