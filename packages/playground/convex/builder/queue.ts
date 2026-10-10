// The build queue: one build at a time per app, first in first out, each
// starting from the live version at the moment it starts, and committing only
// on top of that same version (a restore that lands meanwhile restarts it). A
// request message
// carries its build (build_id), so the room shows one item per request that
// morphs from queued to building to live or failed, and a retry re-queues the
// same item. run.ts does the work; everything that changes a build's status
// is here.
import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import { internalMutation, internalQuery, mutation, type MutationCtx, type QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { fail, type PlaygroundErrorData } from "../lib/errors";
import { BUILD_CEILING_USD, BUILD_DEADLINE_MS, BUILD_HISTORY_CONTEXT, BUILD_ROOM_CONTEXT, GLOBAL_DAILY_BUDGET_USD } from "../lib/limits";
import { takeRate } from "../limits";
import { requireApp } from "../model";
import { cleanAppName } from "../lib/slugs";
import { appendVersion } from "../versions";
import { publicVisitors, requireVisitor } from "../visitors";
import { RETRYABLE_FAILURES, failureKind, narrationLine, touchedFile, visitorArgs, type NarrationLine } from "../validators";
import type { PromptMessage } from "../prompts";
import { TALLY, addTally, isOver, setOver, tally } from "../tallies";
import { SPEND_BUDGET_USD, cleanIdeas, nextInLine, overBudget, startRefusal, type Budget, type Refusal } from "./rules";

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
  });
  await ctx.db.patch(message._id, { kind: "request", build_id: buildId, triage: undefined });
  await ctx.scheduler.runAfter(0, internal.builder.queue.advance, { app_id: app._id });
  return buildId;
}

/** Each daily spend budget a build in `appId` counts toward, with its tally
 *  key: the asker's own only when there is one. */
function spendKeys(appId: Id<"apps">, asker: Id<"visitors"> | undefined): [Budget, string][] {
  return [["global", TALLY.spend], ["app", TALLY.appSpend(appId)], ...(asker ? [["visitor", TALLY.visitorSpend(asker)] as [Budget, string]] : [])];
}

/** Read every budget of a build in `appId` asked by `asker`, one way or another. */
async function perBudget<T>(appId: Id<"apps">, asker: Id<"visitors">, read: (key: string) => Promise<T>): Promise<Record<Budget, T>> {
  const entries = await Promise.all(spendKeys(appId, asker).map(async ([b, key]) => [b, await read(key)] as const));
  return Object.fromEntries(entries) as Record<Budget, T>;
}

const buildsOff = () => process.env.PLAYGROUND_BUILDS_OFF === "1";

/** Why a build of `app` asked by `asker` may not start now (paused, a
 *  budget spent), or null. `heldUsd` is spend not charged yet that already
 *  counts against the global budget (builds running elsewhere). */
export async function buildRefusal(ctx: QueryCtx, app: Doc<"apps">, asker: Id<"visitors">, heldUsd = 0): Promise<Refusal | null> {
  const spent = await perBudget(app._id, asker, (key) => tally(ctx, key));
  return startRefusal({ paused: buildsOff(), over: overBudget({ ...spent, global: spent.global + heldUsd }) });
}

/** The same answer for a page to show, read from the over-budget marks,
 *  which change only when a total crosses its budget. Not the last word: a
 *  build that starts is checked again against the totals (advance). */
export async function shownRefusal(ctx: QueryCtx, appId: Id<"apps">, asker: Id<"visitors">): Promise<Refusal | null> {
  return startRefusal({ paused: buildsOff(), over: await perBudget(appId, asker, (key) => isOver(ctx, key)) });
}

/** What builds running anywhere may still cost: each holds its ceiling until
 *  finish charges what it really spent, so a burst of builds starting at once
 *  cannot overrun the global budget. Read only when a build starts, so the
 *  queries that show whether builds are paused do not watch every build. */
async function heldByRunningBuilds(ctx: QueryCtx): Promise<number> {
  const enough = Math.ceil(GLOBAL_DAILY_BUDGET_USD / BUILD_CEILING_USD);
  const running = await ctx.db.query("builds").withIndex("by_status", (q) => q.eq("status", "building")).take(enough);
  return running.length * BUILD_CEILING_USD;
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
    const nextId = nextInLine(rows);
    const next = nextId && rows.find((r) => r._id === nextId);
    if (!next) return;

    const now = Date.now();
    const refusal = await buildRefusal(ctx, app, next.requested_by, await heldByRunningBuilds(ctx));
    if (refusal) {
      await failBuild(ctx, next, refusal, now);
      await ctx.scheduler.runAfter(0, internal.builder.queue.advance, { app_id });
      return;
    }

    await ctx.db.patch(next._id, { status: "building", base_version: app.live_version, started_at: now });
    await ctx.scheduler.runAfter(0, internal.builder.run.build, { build_id: next._id });
    await ctx.scheduler.runAfter(BUILD_DEADLINE_MS + WATCHDOG_GRACE_MS, internal.builder.queue.expire, { build_id: next._id, started_at: now });
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
  // A request that didn't make it never happened to the app, and quoting it
  // would carry a refused ask (a phishing page, say) into every later build,
  // where the model refuses the whole turn for it.
  const failed = new Set(
    (await Promise.all(rows.map((m) => (m.build_id ? ctx.db.get(m.build_id) : null)))).flatMap((b) => (b?.status === "failed" ? [b.request_message_id] : [])),
  );
  const said = rows.filter((m) => !failed.has(m._id));
  const people = await publicVisitors(ctx, said.flatMap((m) => (m.visitor_id ? [m.visitor_id] : [])));
  return said.reverse().map((m) => ({ who: (m.visitor_id && people.get(m.visitor_id)?.name) || "Someone", body: m.body }));
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
      /** A new app's first build: its base is the starter. */
      first: versions[0]?.kind === "seed",
      next: app.version_count + 1,
      asker: name(build.requested_by),
      request: request.body,
      element: request.element ?? null,
      room: await roomBefore(ctx, request, BUILD_ROOM_CONTEXT),
      history: versions.reverse().map((r) => ({ number: r.number, summary: r.summary, who: name(r.author_id) })),
    };
  },
});

type Progress = { narration: NarrationLine[]; files_touched: Doc<"build_progress">["files_touched"] };

export function progressRow(ctx: QueryCtx, buildId: Id<"builds">) {
  return ctx.db.query("build_progress").withIndex("by_build", (q) => q.eq("build_id", buildId)).unique();
}

async function writeProgress(ctx: MutationCtx, buildId: Id<"builds">, progress: Progress): Promise<void> {
  const row = await progressRow(ctx, buildId);
  if (row) await ctx.db.patch(row._id, progress);
  else await ctx.db.insert("build_progress", { build_id: buildId, ...progress });
}

/** The card's live state while building. False once the build is no longer
 *  building, which tells the run to stop. */
export const narrate = internalMutation({
  args: { build_id: v.id("builds"), narration: v.array(narrationLine), files_touched: v.array(touchedFile) },
  handler: async (ctx, { build_id, ...progress }): Promise<boolean> => {
    const build = await ctx.db.get(build_id);
    if (build?.status !== "building") return false;
    await writeProgress(ctx, build_id, progress);
    return true;
  },
});

/** Count what a model call cost toward the global, the app's and the asker's
 *  daily budgets, marking each budget it uses up (or frees). A negative
 *  amount gives back part of a hold. */
export async function chargeSpend(ctx: MutationCtx, appId: Id<"apps">, asker: Id<"visitors"> | undefined, usd: number): Promise<void> {
  if (!Number.isFinite(usd) || usd === 0) return;
  const budgets = spendKeys(appId, asker);
  const totals = await addTally(ctx, budgets.map(([, key]) => key), usd);
  for (const [b, key] of budgets) await setOver(ctx, key, totals.get(key)! >= SPEND_BUDGET_USD[b]);
}

async function failBuild(ctx: MutationCtx, build: Doc<"builds">, { kind, error, detail }: Refusal, now: number) {
  await ctx.db.patch(build._id, { status: "failed", failure: kind, error, error_detail: detail.slice(0, 4_000), finished_at: now });
}

/** The run's end: commit the draft as the new live version, or fail with a
 *  reason. Either way the cost is charged and the queue moves on. A draft is
 *  committed only on top of the version it started from: when a restore (or
 *  anything else) moved the live version meanwhile, the build starts again
 *  from the new one once, then gives up, rather than undo what landed. */
export const finish = internalMutation({
  args: {
    build_id: v.id("builds"),
    cost_usd: v.number(),
    narration: v.array(narrationLine),
    files_touched: v.array(touchedFile),
    result: v.union(
      v.object({
        ok: v.literal(true),
        summary: v.string(),
        name: v.optional(v.string()),
        ideas: v.optional(v.array(v.string())),
        spotlight: v.optional(v.string()),
        try: v.optional(v.string()),
        files: v.array(v.object({ path: v.string(), text: v.string() })),
      }),
      v.object({ ok: v.literal(false), kind: failureKind, error: v.string(), detail: v.string() }),
    ),
  },
  handler: async (ctx, args) => {
    const build = await ctx.db.get(args.build_id);
    if (!build) return;
    const app = await requireApp(ctx, build.app_id);
    const now = Date.now();
    await chargeSpend(ctx, app._id, build.requested_by, args.cost_usd);
    await ctx.db.patch(build._id, { cost_usd: (build.cost_usd ?? 0) + args.cost_usd });
    // The watchdog may have failed it already; its result then goes nowhere.
    if (build.status !== "building") return;

    const moved = args.result.ok && app.live_version !== build.base_version;
    if (moved && !build.restarted) {
      await ctx.db.patch(build._id, { status: "queued", base_version: undefined, started_at: undefined, restarted: true });
      await writeProgress(ctx, build._id, {
        narration: [{ at: now, text: `v${app.live_version} went live while Clay worked. Starting again from it.` }],
        files_touched: [],
      });
    } else if (moved) {
      await writeProgress(ctx, build._id, { narration: args.narration, files_touched: args.files_touched });
      await failBuild(ctx, build, { kind: "moved", error: "The app kept changing while Clay worked. Try again.", detail: `live moved from v${build.base_version} to v${app.live_version} twice` }, now);
    } else if (!args.result.ok) {
      await writeProgress(ctx, build._id, { narration: args.narration, files_touched: args.files_touched });
      await failBuild(ctx, build, args.result, now);
    } else {
      await writeProgress(ctx, build._id, { narration: args.narration, files_touched: args.files_touched });
      try {
        const { number } = await appendVersion(
          ctx,
          app,
          {
            kind: "build",
            summary: args.result.summary,
            ...(args.result.spotlight ? { spotlight: args.result.spotlight } : {}),
            ...(args.result.try ? { try_it: args.result.try } : {}),
            author_id: build.requested_by,
            parent_number: build.base_version,
            request_message_id: build.request_message_id,
          },
          args.result.files,
        );
        await ctx.db.patch(build._id, { status: "live", result_version: number, finished_at: now });
        const ideas = cleanIdeas(args.result.ideas ?? []);
        const name = cleanAppName(args.result.name);
        if (ideas.length || name) await ctx.db.patch(app._id, { ...(ideas.length ? { ideas } : {}), ...(name ? { name } : {}) });
      } catch (e) {
        if (!(e instanceof ConvexError)) throw e;
        await failBuild(ctx, build, { kind: "invalid", error: "The code Clay wrote didn't run.", detail: (e.data as PlaygroundErrorData).message }, now);
      }
    }
    await ctx.scheduler.runAfter(0, internal.builder.queue.advance, { app_id: build.app_id });
  },
});

/** The watchdog: a build still building well past its deadline lost its run
 *  (the action died); fail it so the queue moves on. */
export const expire = internalMutation({
  args: { build_id: v.id("builds"), started_at: v.number() },
  handler: async (ctx, { build_id, started_at }) => {
    const build = await ctx.db.get(build_id);
    // A restarted build has a later start and its own watchdog.
    if (build?.status !== "building" || build.started_at !== started_at) return;
    await failBuild(ctx, build, { kind: "time", error: "It ran out of time on a big change. Try a smaller step.", detail: "the build's run stopped reporting" }, Date.now());
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
    if (build.failure && !RETRYABLE_FAILURES.includes(build.failure)) fail("invalid", "Trying the same words again won't help here. Edit the request instead.");
    const app = await requireApp(ctx, build.app_id);
    return { build_id: await enqueueBuild(ctx, app, message, visitor._id) };
  },
});
