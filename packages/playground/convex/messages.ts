// The room's stream: people's messages, the builder's cards and system notes,
// newest first, a page at a time. A build card's state is joined from its
// builds row at read time, so the card and the build can never disagree; its
// narration is not (builds.progress), so Clay's running commentary never
// re-runs the page.
import { paginationOptsValidator, type PaginationResult } from "convex/server";
import { v } from "convex/values";
import { mutation, query, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { fail } from "./lib/errors";
import { LATEST_MESSAGES, MESSAGE_BODY_MAX, MESSAGE_PAGE_MAX, RUNTIME_ERROR_MAX, TRIAGE_CEILING_USD } from "./lib/limits";
import { cleanElement, cleanLine, cleanMessageBody } from "./lib/room";
import { takeRate } from "./limits";
import { postSystemNote, requireApp, touchApp } from "./model";
import { stopTyping } from "./presence";
import { buildRefusal, chargeSpend, enqueueBuild } from "./builder/queue";
import { internal } from "./_generated/api";
import { versionByNumber } from "./versions";
import { publicVisitors, requireVisitor, type PublicVisitor } from "./visitors";
import { composerMode, elementRef, visitorArgs, type BuildStatus, type ElementRef, type FailureKind, type MessageKind, type SystemNote } from "./validators";

/** Send a message. `change` makes it a change request and queues its build
 *  (the message then carries the build card), `chat` plain chat, and `auto`
 *  stores it as chat marked triage "pending" until builder/triage settles it
 *  (plain chat while builds are refused).
 *  Sending clears the sender's typing indicator. */
export const send = mutation({
  args: { ...visitorArgs, app_id: v.id("apps"), body: v.string(), mode: composerMode, element: v.optional(elementRef) },
  handler: async (ctx, args) => {
    const visitor = await requireVisitor(ctx, args);
    const app = await requireApp(ctx, args.app_id);
    if (args.body.trim().length > MESSAGE_BODY_MAX) fail("invalid", `That's longer than a message can be. Keep it under ${MESSAGE_BODY_MAX} characters.`);
    const body = cleanMessageBody(args.body) ?? fail("invalid", "Say something first.");
    await takeRate(ctx, "message", visitor._id);
    await takeRate(ctx, "appMessage", app._id);
    const element = args.element ? cleanElement(args.element) : null;
    const kind: MessageKind = args.mode === "change" ? "request" : "chat";
    // While builds are refused (paused, a budget spent) an Auto message is
    // chat: triage would pay a model to queue a build that cannot start.
    const triage = args.mode === "auto" && !(await buildRefusal(ctx, app, visitor._id));
    const messageId = await ctx.db.insert("messages", {
      app_id: app._id,
      kind,
      visitor_id: visitor._id,
      body,
      ...(element ? { element } : {}),
      ...(triage ? { triage: "pending" as const } : {}),
    });
    if (kind === "request") await enqueueBuild(ctx, app, (await ctx.db.get(messageId))!, visitor._id);
    if (triage) {
      // Held against the budgets until the call's real cost replaces it, so
      // a burst of triage calls cannot run past them.
      await chargeSpend(ctx, app._id, visitor._id, TRIAGE_CEILING_USD);
      await ctx.scheduler.runAfter(0, internal.builder.triage.classify, { message_id: messageId });
    }
    await stopTyping(ctx, app._id, visitor._id);
    await touchApp(ctx, app);
    return { message_id: messageId, kind };
  },
});

/** The app threw in someone's browser: Clay tells the room, once per version,
 *  whoever saw it first. */
export const reportError = mutation({
  args: { ...visitorArgs, app_id: v.id("apps"), version: v.number(), message: v.string() },
  handler: async (ctx, args) => {
    const visitor = await requireVisitor(ctx, args);
    const app = await requireApp(ctx, args.app_id);
    if (!Number.isInteger(args.version) || args.version < 1 || args.version > app.version_count) fail("invalid", "That version does not exist.");
    const reported = await ctx.db
      .query("app_errors")
      .withIndex("by_app_version", (q) => q.eq("app_id", app._id).eq("version", args.version))
      .first();
    if (reported) return { message_id: reported.message_id, fresh: false };
    const message = cleanLine(args.message, RUNTIME_ERROR_MAX) ?? "Something went wrong";
    await takeRate(ctx, "message", visitor._id);
    const message_id = await postSystemNote(ctx, app._id, { type: "error", version: args.version, message }, `The app hit an error: ${message}`);
    await ctx.db.insert("app_errors", { app_id: app._id, version: args.version, message_id });
    return { message_id, fresh: true };
  },
});

export type BuildView = {
  id: Id<"builds">;
  status: BuildStatus;
  /** 1 for next in line; null unless queued. */
  queue_position: number | null;
  base_version: number | null;
  result_version: number | null;
  /** The live version's one-line summary, once live. */
  summary: string | null;
  /** Why it failed, for people; `error_detail` is the raw cause behind "Details". */
  error: string | null;
  error_detail: string | null;
  /** How it failed, which decides what its card offers; null when not failed. */
  failure: FailureKind | null;
  started_at: number | null;
  finished_at: number | null;
};

export type NoteView =
  | { type: "fork"; by: PublicVisitor | null; version: number; fork: { slug: string; name: string } | null }
  | { type: "restore"; by: PublicVisitor | null; from_version: number; version: number; undid: number | null }
  | { type: "error"; version: number; message: string }
  | { type: "data"; outcome: "skipped" | "partial" };

export type MessageView = {
  id: Id<"messages">;
  created_at: number;
  kind: MessageKind;
  /** null for the builder's cards and system notes. */
  author: PublicVisitor | null;
  body: string;
  element: ElementRef | null;
  triage_pending: boolean;
  build: BuildView | null;
  note: NoteView | null;
};

async function queuePositions(ctx: QueryCtx, appId: Id<"apps">): Promise<Map<Id<"builds">, number>> {
  const queued = await ctx.db
    .query("builds")
    .withIndex("by_app_status", (q) => q.eq("app_id", appId).eq("status", "queued"))
    .collect();
  return new Map(queued.map((b, i) => [b._id, i + 1]));
}

function buildView(b: Doc<"builds">, positions: Map<Id<"builds">, number>, summary: string | null): BuildView {
  return {
    id: b._id,
    status: b.status,
    queue_position: positions.get(b._id) ?? null,
    base_version: b.base_version ?? null,
    result_version: b.result_version ?? null,
    summary,
    error: b.error ?? null,
    error_detail: b.error_detail ?? null,
    failure: b.status === "failed" ? (b.failure ?? failureFromDetail(b.error_detail)) : null,
    started_at: b.started_at ?? null,
    finished_at: b.finished_at ?? null,
  };
}

/** Builds that failed before failures had kinds: read it from the cause. */
function failureFromDetail(detail: string | undefined): FailureKind {
  if (detail?.startsWith("declined: ")) return "declined";
  if (detail === "the draft matched the base version") return "unchanged";
  return "stopped";
}

async function noteView(ctx: QueryCtx, note: SystemNote, people: Map<Id<"visitors">, PublicVisitor>): Promise<NoteView> {
  if (note.type === "error" || note.type === "data") return note;
  const by = people.get(note.visitor_id) ?? null;
  if (note.type === "restore") return { type: "restore", by, from_version: note.from_version, version: note.version, undid: note.undid ?? null };
  const fork = await ctx.db.get(note.fork_app_id);
  return { type: "fork", by, version: note.version, fork: fork && { slug: fork.slug, name: fork.name } };
}

const noteAuthor = (note: SystemNote | undefined) => (note && (note.type === "fork" || note.type === "restore") ? note.visitor_id : undefined);

/** Messages as the room shows them, in the order given: each with its
 *  author, its build card's state and its note joined in. */
async function messageViews(ctx: QueryCtx, appId: Id<"apps">, rows: Doc<"messages">[]): Promise<MessageView[]> {
  const people = await publicVisitors(
    ctx,
    rows.flatMap((m) => [m.visitor_id, noteAuthor(m.note)].filter((id): id is Id<"visitors"> => !!id)),
  );
  const builds = await Promise.all(rows.map((m) => (m.build_id ? ctx.db.get(m.build_id) : null)));
  const positions = builds.some((b) => b?.status === "queued") ? await queuePositions(ctx, appId) : new Map();
  const summaries = await Promise.all(
    builds.map(async (b) => (b?.result_version ? ((await versionByNumber(ctx, b.app_id, b.result_version))?.summary ?? null) : null)),
  );
  return Promise.all(
    rows.map(
      async (m, i): Promise<MessageView> => ({
        id: m._id,
        created_at: m._creationTime,
        kind: m.kind,
        author: m.visitor_id ? (people.get(m.visitor_id) ?? null) : null,
        body: m.body,
        element: m.element ?? null,
        triage_pending: m.triage === "pending",
        build: builds[i] ? buildView(builds[i], positions, summaries[i]) : null,
        note: m.note ? await noteView(ctx, m.note, people) : null,
      }),
    ),
  );
}

/** The stream, newest first; feed straight to usePaginatedQuery. */
export const list = query({
  args: { ...visitorArgs, app_id: v.id("apps"), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args): Promise<PaginationResult<MessageView>> => {
    await requireVisitor(ctx, args);
    const page = await ctx.db
      .query("messages")
      .withIndex("by_app", (q) => q.eq("app_id", args.app_id))
      .order("desc")
      .paginate({ ...args.paginationOpts, numItems: Math.min(args.paginationOpts.numItems, MESSAGE_PAGE_MAX) });
    return { ...page, page: await messageViews(ctx, args.app_id, page.page) };
  },
});

/** What the app's link follows while its room is closed, newest first: the
 *  last few messages, every request in line or building, the request behind
 *  the live version, and the live version's error note, if it has one. A
 *  small slice of the stream, for the capsule; the room reads list. */
export const latest = query({
  args: { ...visitorArgs, app_id: v.id("apps") },
  handler: async (ctx, args): Promise<MessageView[]> => {
    await requireVisitor(ctx, args);
    const app = await requireApp(ctx, args.app_id);
    const [recent, inFlight, live, error] = await Promise.all([
      ctx.db.query("messages").withIndex("by_app", (q) => q.eq("app_id", app._id)).order("desc").take(LATEST_MESSAGES),
      Promise.all(
        (["building", "queued"] as const).map((status) =>
          ctx.db.query("builds").withIndex("by_app_status", (q) => q.eq("app_id", app._id).eq("status", status)).take(LATEST_MESSAGES),
        ),
      ),
      versionByNumber(ctx, app._id, app.live_version),
      ctx.db.query("app_errors").withIndex("by_app_version", (q) => q.eq("app_id", app._id).eq("version", app.live_version)).first(),
    ]);
    const seen = new Set<string>(recent.map((m) => m._id));
    const wanted = [...inFlight.flat().map((b) => b.card_message_id ?? b.request_message_id), live?.request_message_id, error?.message_id];
    const more = [...new Set(wanted.filter((id): id is Id<"messages"> => !!id && !seen.has(id)))];
    const older = (await Promise.all(more.map((id) => ctx.db.get(id)))).filter((m): m is Doc<"messages"> => m !== null);
    const rows = [...recent, ...older].sort((a, b) => b._creationTime - a._creationTime);
    return messageViews(ctx, app._id, rows);
  },
});
