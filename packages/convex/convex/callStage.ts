// The things a huddle's stage holds besides faces and screen shares: boards,
// sheets, dashboards, docs, published pages and other codecast objects that
// someone in the room pinned for everyone to look at and work on together.
// Like a screen share, a pin is the room's: anyone seated may pin or unpin,
// and so may an agent fed the room (`cast call pin`). Unlike a screen share it
// is not a picture: each person sees the thing itself, live, and edits it
// with the others' cursors on it.
//
// The call's board is the one pin the room gets without asking: the first
// agent to join makes it (ensureCallBoard), and its briefing tells it to keep
// the board as the room's shared picture of the talk.
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internalMutation, mutation, query, type MutationCtx } from "./functions";
import type { Doc, Id } from "./_generated/dataModel";
import { parseStagePinRef, stagePinRowId, STAGE_PIN_LIMIT, type StagePinTarget } from "@codecast/shared/contracts/stagePins";
import { liveSeat, readRoomState } from "./callRooms";
import { liveTranscriptFor, postEvent } from "./callChat";
import { canAccessDoc } from "./lib/access";
import { verifyApiToken } from "./apiTokens";
import { findConversationByAnyRefWhere } from "./conversationSessionLookup";
import { createDocAs } from "./docs";
import { characterOf } from "@codecast/shared/contracts/sessionCharacter";

type PinRow = Doc<"call_stage_pins">;

async function roomPins(ctx: { db: any }, roomKey: string): Promise<PinRow[]> {
  const rows: PinRow[] = await ctx.db
    .query("call_stage_pins")
    .withIndex("by_room", (q: any) => q.eq("room_key", roomKey))
    .collect();
  return rows.sort((a, b) => a.at - b.at);
}

/** What a typed ref pins, checked against what `userId` may read. A bare id
 *  that is not a doc falls back to an object reference. Throws the words an
 *  agent or a person needs to fix the ref. */
async function resolveTarget(
  ctx: MutationCtx,
  userId: Id<"users">,
  raw: string,
): Promise<{ target: StagePinTarget; doc?: Doc<"docs">; title?: string }> {
  const target = parseStagePinRef(raw);
  if (!target) throw new Error(`Nothing to pin in "${raw}": give a doc (doc:<id> or its /docs link), a page link (https://codecast.sh/a/<slug>), or an object's short id`);
  if (target.kind === "doc") {
    const id = ctx.db.normalizeId("docs", target.id);
    if (!id) {
      // A bare 20+ character id that is not a doc: some other object.
      if (raw.trim() === target.id) return { target: { kind: "object", ref: target.id } };
      throw new Error(`${raw} is not a doc id`);
    }
    const doc = await ctx.db.get(id);
    if (!doc || doc.archived_at || !(await canAccessDoc(ctx, userId, doc))) throw new Error(`No doc ${target.id} that you can open`);
    return { target: { kind: "doc", id: String(id), ref: `doc:${id}` }, doc };
  }
  if (target.kind === "page") {
    const page = await ctx.db.query("artifacts").withIndex("by_slug", (q: any) => q.eq("slug", target.slug)).first();
    if (!page) throw new Error(`No published page a/${target.slug}`);
    return { target, title: page.title };
  }
  return { target };
}

/** Put a thing on the room's stage, or bring an existing pin to the front. */
async function writePin(
  ctx: MutationCtx,
  roomKey: string,
  teamId: Id<"teams">,
  userId: Id<"users">,
  target: StagePinTarget,
  bySession?: Id<"conversations">,
  title?: string | null,
): Promise<{ ref: string; replaced: string | null }> {
  const now = Date.now();
  const pins = await roomPins(ctx, roomKey);
  const existing = pins.find((p) => p.ref === target.ref);
  if (existing) {
    await ctx.db.patch(existing._id, { at: now });
    return { ref: target.ref, replaced: null };
  }
  let replaced: string | null = null;
  if (pins.length >= STAGE_PIN_LIMIT) {
    await ctx.db.delete(pins[0]._id);
    replaced = pins[0].ref;
  }
  await ctx.db.insert("call_stage_pins", {
    room_key: roomKey,
    team_id: teamId,
    ref: target.ref,
    kind: target.kind,
    ...(target.kind === "doc" ? { doc_id: target.id as Id<"docs"> } : {}),
    ...(target.kind === "page" ? { slug: target.slug } : {}),
    pinned_by: userId,
    ...(bySession ? { pinned_by_session: bySession } : {}),
    at: now,
  });
  // The room's thread says what went up, so someone with the stage folded
  // away still learns of it (the call's door counts the line).
  await postEvent(ctx, {
    room_key: roomKey,
    team_id: teamId,
    user_id: userId,
    event: "stage_pinned",
    ...(bySession ? { agent_conversation_id: bySession } : {}),
    detail: title?.trim() || (target.kind === "page" ? "a page" : target.ref),
  });
  return { ref: target.ref, replaced };
}

async function removePin(ctx: MutationCtx, roomKey: string, raw: string): Promise<boolean> {
  const ref = parseStagePinRef(raw)?.ref ?? raw.trim();
  const row = await ctx.db
    .query("call_stage_pins")
    .withIndex("by_room_ref", (q: any) => q.eq("room_key", roomKey).eq("ref", ref))
    .first();
  if (!row) return false;
  await ctx.db.delete(row._id);
  return true;
}

/** The call's board, made on first need and pinned on the stage when made.
 *  It lives where the huddle's people can open it: the team's workspace, or
 *  for a private huddle the personal workspace of whoever asked for it.
 *  Returns the board's id, or null when the room has no live record to hang
 *  it on. */
export async function ensureCallBoard(
  ctx: MutationCtx,
  t: Doc<"transcripts">,
  userId: Id<"users">,
  /** The agent whose arrival made it: the pin and the thread line are its. */
  bySession?: Id<"conversations">,
  /** false: make it without putting it on the stage (a person's board view). */
  pin = true,
): Promise<Id<"docs"> | null> {
  if (t.status !== "live") return null;
  if (t.board_doc_id) {
    const doc = await ctx.db.get(t.board_doc_id);
    if (doc && !doc.archived_at) return t.board_doc_id;
  }
  const isPrivate = !!(await readRoomState(ctx, t.room_key))?.private;
  const day = new Date(t.started_at).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const title = `${t.title?.trim() || "Huddle"} board · ${day}`;
  const { id } = await createDocAs(ctx, userId, {
    title,
    doc_type: "board",
    workspace: isPrivate ? "personal" : "team",
    ...(isPrivate ? {} : { team_id: t.team_id }),
  });
  const boardId = id as Id<"docs">;
  await ctx.db.patch(t._id, { board_doc_id: boardId });
  if (pin) await writePin(ctx, t.room_key, t.team_id, userId, { kind: "doc", id: String(boardId), ref: `doc:${boardId}` }, bySession, "the call's board");
  return boardId;
}

/** The board for a call an agent just joined (transcripts.syncAgentFeeds). */
export const ensureBoardForFeed = internalMutation({
  args: { transcript_id: v.id("transcripts"), user_id: v.id("users"), conversation_id: v.id("conversations") },
  handler: async (ctx, args) => {
    const t = await ctx.db.get(args.transcript_id);
    if (!t) return null;
    return await ensureCallBoard(ctx, t, args.user_id, args.conversation_id);
  },
});

// ── People in the room ────────────────────────────────────────────────────

/** The stage's pins, for someone seated in the room. Each says what it is
 *  and whether this viewer can open it: a personal doc pinned into a team
 *  huddle shows its pinner's name and a lock to everyone else. */
export const listPins = query({
  args: { room_key: v.string() },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    if (!(await liveSeat(ctx, userId, args.room_key))) return [];
    const out = [];
    for (const p of await roomPins(ctx, args.room_key)) {
      const by = await ctx.db.get(p.pinned_by);
      let title: string | null = null;
      let docType: string | null = null;
      let readable = true;
      if (p.kind === "doc" && p.doc_id) {
        const doc = await ctx.db.get(p.doc_id);
        readable = !!doc && !doc.archived_at && (await canAccessDoc(ctx, userId, doc));
        title = readable ? doc!.title : null;
        docType = doc?.doc_type ?? null;
      } else if (p.kind === "page" && p.slug) {
        const page = await ctx.db.query("artifacts").withIndex("by_slug", (q: any) => q.eq("slug", p.slug)).first();
        title = page?.title ?? null;
        readable = !!page;
      }
      const session = p.pinned_by_session ? await ctx.db.get(p.pinned_by_session) : null;
      out.push({
        _id: stagePinRowId(args.room_key, p.ref),
        room_key: args.room_key,
        ref: p.ref,
        kind: p.kind,
        doc_id: p.doc_id ?? null,
        slug: p.slug ?? null,
        at: p.at,
        title,
        doc_type: docType,
        readable,
        pinned_by: String(p.pinned_by),
        pinned_by_name: by?.name ?? null,
        pinned_by_session: p.pinned_by_session ? String(p.pinned_by_session) : null,
        pinned_by_agent: session ? characterOf({ ...(session as any), _id: String(session._id) }).name : null,
      });
    }
    return out;
  },
});

export const pin = mutation({
  args: { room_key: v.string(), ref: v.string() },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthorized");
    const seat = await liveSeat(ctx, userId, args.room_key);
    if (!seat) throw new Error("Only someone in the huddle can pin to its stage");
    const { target, doc, title } = await resolveTarget(ctx, userId, args.ref);
    return await writePin(ctx, args.room_key, seat.team_id, userId, target, undefined, doc?.title ?? title);
  },
});

export const unpin = mutation({
  args: { room_key: v.string(), ref: v.string() },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthorized");
    if (!(await liveSeat(ctx, userId, args.room_key))) throw new Error("Only someone in the huddle can change its stage");
    return { removed: await removePin(ctx, args.room_key, args.ref) };
  },
});

/** Board on the stage: the call's board, made now if the room has none, and
 *  pinned again if somebody took it down. */
export const pinCallBoard = mutation({
  args: { room_key: v.string() },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthorized");
    const seat = await liveSeat(ctx, userId, args.room_key);
    if (!seat) throw new Error("Only someone in the huddle can pin to its stage");
    const t = await liveTranscriptFor(ctx, args.room_key);
    if (!t) throw new Error("The huddle has no call record yet: turn transcription on to give it a board");
    const boardId = await ensureCallBoard(ctx, t, userId);
    if (!boardId) throw new Error("The call has ended");
    await writePin(ctx, args.room_key, seat.team_id, userId, { kind: "doc", id: String(boardId), ref: `doc:${boardId}` }, undefined, "the call's board");
    return { doc_id: boardId };
  },
});

/** The call's board for one person's board view: made if the room has none,
 *  never pinned, so looking at it changes nobody else's stage. */
export const openCallBoard = mutation({
  args: { room_key: v.string() },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthorized");
    if (!(await liveSeat(ctx, userId, args.room_key))) throw new Error("Only someone in the huddle can open its board");
    const t = await liveTranscriptFor(ctx, args.room_key);
    if (!t) throw new Error("The huddle has no call record yet: turn transcription on to give it a board");
    const boardId = await ensureCallBoard(ctx, t, userId, undefined, false);
    if (!boardId) throw new Error("The call has ended");
    return { doc_id: boardId };
  },
});

// ── Agents in the room (`cast call pin|unpin|pins|board`) ─────────────────

/** The live huddle a session is fed, as its owner may act in it. */
async function sessionRoom(ctx: any, apiToken: string, session: string) {
  const auth = await verifyApiToken(ctx, apiToken, false);
  if (!auth) throw new Error("Unauthorized");
  const conv = await findConversationByAnyRefWhere(
    ctx,
    session,
    (c: any) => c.user_id?.toString() === auth.userId.toString() || c.owner_user_id?.toString() === auth.userId.toString(),
  );
  if (!conv) throw new Error(`No session found for "${session}" (only a session you run or own)`);
  const feed = await ctx.db
    .query("call_agent_feeds")
    .withIndex("by_conversation", (q: any) => q.eq("conversation_id", conv._id))
    .first();
  const t: Doc<"transcripts"> | null = feed ? await ctx.db.get(feed.transcript_id) : null;
  if (!feed || !t || t.status !== "live") {
    throw new Error(`${conv.short_id ?? "This session"} is not in a live huddle: the stage belongs to a call, so pin from a session the call is feeding`);
  }
  return { userId: auth.userId as Id<"users">, conv, t };
}

export const cliPin = mutation({
  args: { api_token: v.string(), session: v.string(), ref: v.string() },
  handler: async (ctx, args) => {
    const { userId, conv, t } = await sessionRoom(ctx, args.api_token, args.session);
    const { target, doc, title } = await resolveTarget(ctx, userId, args.ref);
    const r = await writePin(ctx, t.room_key, t.team_id, userId, target, conv._id, doc?.title ?? title);
    return { ...r, title: doc?.title ?? null, call: t.short_id ?? null };
  },
});

export const cliUnpin = mutation({
  args: { api_token: v.string(), session: v.string(), ref: v.string() },
  handler: async (ctx, args) => {
    const { t } = await sessionRoom(ctx, args.api_token, args.session);
    return { removed: await removePin(ctx, t.room_key, args.ref) };
  },
});

export const cliPins = mutation({
  args: { api_token: v.string(), session: v.string() },
  handler: async (ctx, args) => {
    const { t } = await sessionRoom(ctx, args.api_token, args.session);
    const out = [];
    for (const p of await roomPins(ctx, t.room_key)) {
      const doc = p.doc_id ? await ctx.db.get(p.doc_id) : null;
      out.push({ ref: p.ref, kind: p.kind, title: doc?.title ?? null, doc_type: doc?.doc_type ?? null, board: !!t.board_doc_id && String(p.doc_id) === String(t.board_doc_id), at: p.at });
    }
    return { call: t.short_id ?? null, board: t.board_doc_id ?? null, pins: out };
  },
});

/** The call's board for an agent: made if the room has none yet. Pinned only
 *  when made, so a board the room took down stays down until someone pins it. */
export const cliBoard = mutation({
  args: { api_token: v.string(), session: v.string() },
  handler: async (ctx, args) => {
    const { userId, t } = await sessionRoom(ctx, args.api_token, args.session);
    const boardId = await ensureCallBoard(ctx, t, userId);
    const pinned = !!boardId && !!(await ctx.db
      .query("call_stage_pins")
      .withIndex("by_room_ref", (q: any) => q.eq("room_key", t.room_key).eq("ref", `doc:${boardId}`))
      .first());
    const doc = boardId ? await ctx.db.get(boardId) : null;
    return { doc_id: boardId, title: doc?.title ?? null, pinned, call: t.short_id ?? null };
  },
});
