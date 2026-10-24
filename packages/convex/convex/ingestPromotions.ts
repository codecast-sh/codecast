// A group's promotion while it waits and while it files (ingest.ts
// announceTransition and promoteDue schedule it, ingest.promote files it): it
// stays on the group as promotion_due until the promote action settles it, so
// a run that fails (an OCC storm on the short-id counter when many file at
// once, prod 2026-10-24: 7 of 65) is scheduled again by promoteDue instead of
// lost. A group that opened before its source promoted its kind is queued
// here too, so promoteDue files it at the source's rate.
import { v } from "convex/values";
import { internalMutation } from "./functions";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { KIND_TRANSITIONS, transitionSignalKind, type Transition } from "@codecast/shared/contracts/ingest";

/** A scheduled promotion that has not settled after this long is taken as failed and scheduled again. */
export const PROMOTE_RETRY_MS = 10 * 60_000;
/** Runs a promotion gets before it is let go. */
export const PROMOTE_TRIES = 3;
/** Between the promotions one promoteDue pass schedules, so they do not all contend for the same counters at once. */
export const PROMOTE_SPACING_MS = 3_000;

type Due = { transition: Transition; fingerprint: string; external_event_id?: Id<"external_events"> };

/** Schedule a group's promotion, counting the run on its promotion_due so a run that never settles is tried again. */
export async function schedulePromotion(ctx: any, groupId: Id<"event_groups">, due: Due, delayMs = 0): Promise<void> {
  const prev = (await ctx.db.get(groupId))?.promotion_due;
  const now = Date.now();
  const { transition, fingerprint, external_event_id } = due;
  await ctx.db.patch(groupId, {
    promotion_due: { transition, fingerprint, ...(external_event_id ? { external_event_id } : {}), at: prev?.at ?? now, scheduled_at: now + delayMs, tries: (prev?.tries ?? 0) + 1 },
  });
  await ctx.scheduler.runAfter(delayMs, internal.ingest.promote, { group_id: groupId, transition, fingerprint, ...(external_event_id ? { external_event_id } : {}) });
}

/** What promoteDue does with a waiting promotion: wait (a run is in flight), let it go (out of tries), or schedule it. */
export function promotionStep(d: { scheduled_at?: number; tries?: number }, now: number): "in_flight" | "give_up" | "schedule" {
  if (d.scheduled_at !== undefined && now - d.scheduled_at < PROMOTE_RETRY_MS) return "in_flight";
  return (d.tries ?? 0) >= PROMOTE_TRIES ? "give_up" : "schedule";
}

/** The promote action finished without throwing: the group's promotion is done. */
export const settlePromotion = internalMutation({
  args: { group_id: v.id("event_groups") },
  handler: async (ctx, args) => {
    const group = await ctx.db.get(args.group_id);
    if (group?.promotion_due) await ctx.db.patch(group._id, { promotion_due: undefined });
  },
});

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
