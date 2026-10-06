// The room's stream: people's messages, the builder's cards and system notes,
// newest first, a page at a time. A build card's state is joined from its
// builds row at read time, so the card and the build can never disagree.
import { paginationOptsValidator, type PaginationResult } from "convex/server";
import { v } from "convex/values";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { fail } from "./lib/errors";
import { MESSAGE_PAGE_MAX } from "./lib/limits";
import { cleanElement, cleanMessageBody } from "./lib/room";
import { takeRate } from "./limits";
import { requireApp, touchApp } from "./model";
import { stopTyping } from "./presence";
import { enqueueBuild } from "./builder/queue";
import { internal } from "./_generated/api";
import { versionByNumber } from "./versions";
import { publicVisitors, requireVisitor, type PublicVisitor } from "./visitors";
import { composerMode, elementRef, visitorArgs, type BuildStatus, type ElementRef, type MessageKind, type SystemNote, type TouchedFile } from "./validators";

/** Post a system note ("Raccoon forked v12 into Haiku Wall"). `body` is the
 *  plain-text fallback; the shell renders from `note`. */
export async function postSystemNote(ctx: MutationCtx, appId: Id<"apps">, note: SystemNote, body: string): Promise<Id<"messages">> {
  return ctx.db.insert("messages", { app_id: appId, kind: "system", body, note });
}

/** Send a message. `change` makes it a change request, `chat` plain chat, and
 *  `auto` stores it as chat marked triage "pending" for the builder's triage
 *  to settle. Sending clears the sender's typing indicator. */
export const send = mutation({
  args: { ...visitorArgs, app_id: v.id("apps"), body: v.string(), mode: composerMode, element: v.optional(elementRef) },
  handler: async (ctx, args) => {
    const visitor = await requireVisitor(ctx, args);
    const app = await requireApp(ctx, args.app_id);
    const body = cleanMessageBody(args.body) ?? fail("invalid", "Say something first.");
    await takeRate(ctx, "message", visitor._id);
    await takeRate(ctx, "appMessage", app._id);
    const element = args.element ? cleanElement(args.element) : null;
    const kind: MessageKind = args.mode === "change" ? "request" : "chat";
    const messageId = await ctx.db.insert("messages", {
      app_id: app._id,
      kind,
      visitor_id: visitor._id,
      body,
      ...(element ? { element } : {}),
      ...(args.mode === "auto" ? { triage: "pending" as const } : {}),
    });
    if (kind === "request") await enqueueBuild(ctx, app, (await ctx.db.get(messageId))!, visitor._id);
    if (args.mode === "auto") await ctx.scheduler.runAfter(0, internal.builder.triage.classify, { message_id: messageId });
    await stopTyping(ctx, app._id, visitor._id);
    await touchApp(ctx, app);
    return { message_id: messageId, kind };
  },
});

export type BuildView = {
  id: Id<"builds">;
  status: BuildStatus;
  /** 1 for next in line; null unless queued. */
  queue_position: number | null;
  base_version: number | null;
  result_version: number | null;
  narration: { at: number; text: string }[];
  files_touched: TouchedFile[];
  /** The live version's one-line summary, once live. */
  summary: string | null;
  /** Why it failed, for people; `error_detail` is the raw cause behind "Details". */
  error: string | null;
  error_detail: string | null;
  started_at: number | null;
  finished_at: number | null;
};

export type NoteView =
  | { type: "fork"; by: PublicVisitor | null; version: number; fork: { slug: string; name: string } | null }
  | { type: "restore"; by: PublicVisitor | null; from_version: number; version: number };

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
    narration: b.narration,
    files_touched: b.files_touched,
    summary,
    error: b.error ?? null,
    error_detail: b.error_detail ?? null,
    started_at: b.started_at ?? null,
    finished_at: b.finished_at ?? null,
  };
}

async function noteView(ctx: QueryCtx, note: SystemNote, people: Map<Id<"visitors">, PublicVisitor>): Promise<NoteView> {
  const by = people.get(note.visitor_id) ?? null;
  if (note.type === "restore") return { type: "restore", by, from_version: note.from_version, version: note.version };
  const fork = await ctx.db.get(note.fork_app_id);
  return { type: "fork", by, version: note.version, fork: fork && { slug: fork.slug, name: fork.name } };
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

    const people = await publicVisitors(
      ctx,
      page.page.flatMap((m) => [m.visitor_id, m.note?.visitor_id].filter((id): id is Id<"visitors"> => !!id)),
    );
    const builds = await Promise.all(page.page.map((m) => (m.build_id ? ctx.db.get(m.build_id) : null)));
    const positions = builds.some((b) => b?.status === "queued") ? await queuePositions(ctx, args.app_id) : new Map();
    const summaries = await Promise.all(
      builds.map(async (b) => (b?.result_version ? ((await versionByNumber(ctx, b.app_id, b.result_version))?.summary ?? null) : null)),
    );

    const views = await Promise.all(
      page.page.map(
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
    return { ...page, page: views };
  },
});
