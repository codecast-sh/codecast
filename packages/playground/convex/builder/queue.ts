// The build queue: one build at a time per app, first in first out, each
// starting from the live version at the moment it starts. A request message
// carries its build (build_id), so the room shows one item per request that
// morphs from queued to building to live or failed, and a retry re-queues the
// same item. run.ts does the work; everything that changes a build's status
// is here.
import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import { internalMutation, internalQuery, mutation, type MutationCtx, type QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { fail, type PlaygroundErrorData } from "../lib/errors";
import { BUILD_DEADLINE_MS, BUILD_HISTORY_CONTEXT, BUILD_ROOM_CONTEXT } from "../lib/limits";
import { takeRate } from "../limits";
import { requireApp } from "../model";
import { appendVersion } from "../versions";
import { publicVisitors, requireVisitor } from "../visitors";
import { touchedFile, visitorArgs } from "../validators";
import type { PromptMessage } from "../prompts";
import { dayKey, nextInLine, spentOn, startRefusal, type Refusal } from "./rules";

/** Time past the run's own deadline before the watchdog fails a build whose
 *  action died without reporting. */
const WATCHDOG_GRACE_MS = 60_000;

/** Queue a build for a request message and kick the queue. `by` is who is
 *  asking now (the asker, or whoever pressed Try again); the build is
 *  credited to the message's author. Throws rate_limited. */
export async function enqueueBuild(
  ctx: MutationCtx,
  app: Doc<"apps">,
  message: Doc<"messages">,
  by: Id<"visitors">,
): Promise<Id<"builds">> {
  if (!message.visitor_id) throw new Error("a build needs a request from a person");
  await takeRate(ctx, "build", by);
  await takeRate(ctx, "appBuild", app._id);
  const buildId = await ctx.db.insert("builds", {
    app_id: app._id,
    request_message_id: message._id,
    card_message_id: message._id,
    requested_by: message.visitor_id,
    status: "queued",
    narration: [],
    files_touched: [],
  });
  await ctx.db.patch(message._id, { kind: "request", build_id: buildId, triage: undefined });
  await ctx.scheduler.runAfter(0, internal.builder.queue.advance, { app_id: app._id });
  return buildId;
}

/** Why a build of `app` may not start now (paused, a budget spent), or null. */
export async function buildRefusal(ctx: QueryCtx, app: Doc<"apps">, now = Date.now()): Promise<Refusal | null> {
  const day = dayKey(now);
  const global = await ctx.db.query("spend").withIndex("by_day", (q) => q.eq("day", day)).unique();
  return startRefusal({
    paused: process.env.PLAYGROUND_BUILDS_OFF === "1",
    appSpent: spentOn(app.budget && { day: app.budget.day, usd: app.budget.spent_usd }, day),
    globalSpent: spentOn(global, day),
  });
}

/** Start the next build if none is running. Refused builds (paused,
 *  budgets) fail at once and the queue moves on. */
export const advance = internalMutation({
  args: { app_id: v.id("apps") },
  handler: async (ctx, { app_id }) => {
    const app = await ctx.db.get(app_id);
    if (!app) return;
    const rows = [
      ...(await ctx.db.query("builds").withIndex("by_app_status", (q) => q.eq("app_id", app_id).eq("status", "building")).take(1)),
      ...(await ctx.db.query("builds").withIndex("by_app_status", (q) => q.eq("app_id", app_id).eq("status", "queued")).collect()),
    ];
    const next = nextInLine(rows);
    if (!next) return;

    const now = Date.now();
    const refusal = await buildRefusal(ctx, app, now);
    if (refusal) {
      await ctx.db.patch(next, { status: "failed", error: refusal.error, error_detail: refusal.detail, finished_at: now });
      await ctx.scheduler.runAfter(0, internal.builder.queue.advance, { app_id });
      return;
    }

    await ctx.db.patch(next, { status: "building", base_version: app.live_version, started_at: now });
    await ctx.scheduler.runAfter(0, internal.builder.run.build, { build_id: next });
    await ctx.scheduler.runAfter(BUILD_DEADLINE_MS + WATCHDOG_GRACE_MS, internal.builder.queue.expire, { build_id: next });
  },
});

/** The people's messages just before `message`, oldest first, by name: the
 *  room context the builder and triage read. */
export async function roomBefore(ctx: QueryCtx, message: Doc<"messages">, limit: number): Promise<PromptMessage[]> {
  const rows = await ctx.db
    .query("messages")
    .withIndex("by_app", (q) => q.eq("app_id", message.app_id).lt("_creationTime", message._creationTime))
    .order("desc")
    .filter((q) => q.or(q.eq(q.field("kind"), "chat"), q.eq(q.field("kind"), "request")))
    .take(limit);
  const people = await publicVisitors(ctx, rows.flatMap((m) => (m.visitor_id ? [m.visitor_id] : [])));
  return rows.reverse().map((m) => ({ who: (m.visitor_id && people.get(m.visitor_id)?.name) || "Someone", body: m.body }));
}

/** Everything a build reads before it starts, or null once it is not building. */
export const job = internalQuery({
  args: { build_id: v.id("builds") },
  handler: async (ctx, { build_id }) => {
    const build = await ctx.db.get(build_id);
    if (!build || build.status !== "building" || build.base_version === undefined) return null;
    const app = await ctx.db.get(build.app_id);
    const request = await ctx.db.get(build.request_message_id);
    if (!app || !request) return null;

    const versions = await ctx.db
      .query("versions")
      .withIndex("by_app_number", (q) => q.eq("app_id", app._id).lte("number", build.base_version!))
      .order("desc")
      .take(BUILD_HISTORY_CONTEXT);
    const people = await publicVisitors(ctx, [build.requested_by, ...versions.map((r) => r.author_id)]);
    const name = (id: Id<"visitors">) => people.get(id)?.name ?? "Someone";

    return {
      app_id: app._id,
      app_name: app.name,
      base: build.base_version,
      next: app.version_count + 1,
      asker: name(build.requested_by),
      request: request.body,
      element: request.element ?? null,
      room: await roomBefore(ctx, request, BUILD_ROOM_CONTEXT),
      history: versions.reverse().map((r) => ({ number: r.number, summary: r.summary, who: name(r.author_id) })),
    };
  },
});

const narrationLine = v.object({ at: v.number(), text: v.string() });

/** The card's live state while building. False once the build is no longer
 *  building, which tells the run to stop. */
export const progress = internalMutation({
  args: { build_id: v.id("builds"), narration: v.array(narrationLine), files_touched: v.array(touchedFile) },
  handler: async (ctx, { build_id, ...state }): Promise<boolean> => {
    const build = await ctx.db.get(build_id);
    if (build?.status !== "building") return false;
    await ctx.db.patch(build_id, state);
    return true;
  },
});

async function chargeSpend(ctx: MutationCtx, app: Doc<"apps">, usd: number, now: number): Promise<void> {
  if (!(usd > 0)) return;
  const day = dayKey(now);
  const appSpent = spentOn(app.budget && { day: app.budget.day, usd: app.budget.spent_usd }, day);
  await ctx.db.patch(app._id, { budget: { day, spent_usd: appSpent + usd } });
  const row = await ctx.db.query("spend").withIndex("by_day", (q) => q.eq("day", day)).unique();
  if (row) await ctx.db.patch(row._id, { usd: row.usd + usd });
  else await ctx.db.insert("spend", { day, usd });
}

async function failBuild(ctx: MutationCtx, build: Doc<"builds">, error: string, detail: string, now: number) {
  await ctx.db.patch(build._id, { status: "failed", error, error_detail: detail.slice(0, 4_000), finished_at: now });
}

/** The run's end: commit the draft as the new live version, or fail with a
 *  reason. Either way the cost is charged and the queue moves on. */
export const finish = internalMutation({
  args: {
    build_id: v.id("builds"),
    cost_usd: v.number(),
    narration: v.array(narrationLine),
    files_touched: v.array(touchedFile),
    result: v.union(
      v.object({ ok: v.literal(true), summary: v.string(), files: v.array(v.object({ path: v.string(), text: v.string() })) }),
      v.object({ ok: v.literal(false), error: v.string(), detail: v.string() }),
    ),
  },
  handler: async (ctx, args) => {
    const build = await ctx.db.get(args.build_id);
    if (!build) return;
    const app = await requireApp(ctx, build.app_id);
    const now = Date.now();
    await chargeSpend(ctx, app, args.cost_usd, now);
    await ctx.db.patch(build._id, { cost_usd: (build.cost_usd ?? 0) + args.cost_usd });
    // The watchdog may have failed it already; its result then goes nowhere.
    if (build.status !== "building") return;
    await ctx.db.patch(build._id, { narration: args.narration, files_touched: args.files_touched });

    if (!args.result.ok) {
      await failBuild(ctx, build, args.result.error, args.result.detail, now);
    } else {
      try {
        const { number } = await appendVersion(
          ctx,
          (await ctx.db.get(app._id))!,
          {
            kind: "build",
            summary: args.result.summary,
            author_id: build.requested_by,
            parent_number: build.base_version,
            request_message_id: build.request_message_id,
          },
          args.result.files,
        );
        await ctx.db.patch(build._id, { status: "live", result_version: number, finished_at: now });
      } catch (e) {
        if (!(e instanceof ConvexError)) throw e;
        await failBuild(ctx, build, "The code Clay wrote didn't run.", (e.data as PlaygroundErrorData).message, now);
      }
    }
    await ctx.scheduler.runAfter(0, internal.builder.queue.advance, { app_id: build.app_id });
  },
});

/** The watchdog: a build still building well past its deadline lost its run
 *  (the action died); fail it so the queue moves on. */
export const expire = internalMutation({
  args: { build_id: v.id("builds") },
  handler: async (ctx, { build_id }) => {
    const build = await ctx.db.get(build_id);
    if (build?.status !== "building") return;
    await failBuild(ctx, build, "It ran out of time on a big change. Try a smaller step.", "the build's run stopped reporting", Date.now());
    await ctx.scheduler.runAfter(0, internal.builder.queue.advance, { app_id: build.app_id });
  },
});

/** Try again: re-queue a failed request, in place in the room. */
export const retry = mutation({
  args: { ...visitorArgs, build_id: v.id("builds") },
  handler: async (ctx, args): Promise<{ build_id: Id<"builds"> }> => {
    const visitor = await requireVisitor(ctx, args);
    const build = (await ctx.db.get(args.build_id)) ?? fail("not_found", "That build does not exist.");
    const message = await ctx.db.get(build.request_message_id);
    if (build.status !== "failed" || message?.build_id !== build._id) fail("invalid", "Only the latest failed build of a request can be tried again.");
    const app = await requireApp(ctx, build.app_id);
    return { build_id: await enqueueBuild(ctx, app, message, visitor._id) };
  },
});
