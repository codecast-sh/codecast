// The backlog side of promotion (ingest.ts promoteDue files a group when its
// opening transition is promoted): a group that opened before its source
// promoted its kind is queued here, so promoteDue files it at the source's rate.
import { v } from "convex/values";
import { internalMutation } from "./functions";
import { KIND_TRANSITIONS, transitionSignalKind } from "@codecast/shared/contracts/ingest";

/**
 * Groups that opened before their source promoted their kind, queued to file
 * as if their opening transition had just been refused by the hourly cap:
 * promoteDue then files them at the source's promotion rate. A group already
 * filed, gone, or of a kind its source does not promote is skipped, with why.
 */
export const queuePromotions = internalMutation({
  args: { short_ids: v.array(v.string()) },
  handler: async (ctx, args) => {
    const queued: string[] = [];
    const skipped: Array<{ short_id: string; why: string }> = [];
    for (const shortId of args.short_ids) {
      const group = await ctx.db.query("event_groups").withIndex("by_short_id", (q) => q.eq("short_id", shortId)).first();
      const source = group ? await ctx.db.get(group.source_id) : null;
      if (!group || !source) { skipped.push({ short_id: shortId, why: "no such group" }); continue; }
      if (group.signal_task_id) { skipped.push({ short_id: shortId, why: "already filed" }); continue; }
      const transition = KIND_TRANSITIONS[group.kind].find((t) => transitionSignalKind(t) && source.promote.includes(t));
      if (!transition) { skipped.push({ short_id: shortId, why: `${source.name} promotes no ${group.kind} transition` }); continue; }
      const prefix = source.fingerprint_prefix?.trim();
      const fingerprint = prefix ? `${prefix}:${group.fingerprint}` : group.fingerprint;
      await ctx.db.patch(group._id, { promotion_due: { transition, fingerprint, at: Date.now() } });
      queued.push(shortId);
    }
    return { queued, skipped };
  },
});
