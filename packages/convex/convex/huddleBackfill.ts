// One-time backfill for the huddle record (transcripts.HUDDLE_GRACE_MS).
//
// Before it, a transcript ended whenever transcription was switched off or the
// room emptied for a moment, so one conversation could leave several call
// records a few seconds apart: the history listed a "Silent huddle" between
// two halves of the same talk, and the chat (keyed by room) read across all
// of them. This folds each run of fragments into its first record and stamps
// every room chat line with the huddle it was said in.
//
// A fragment joins the record before it when it started within the grace of
// that record's end, or within OFF_GAP_MS when that end was somebody pressing
// the transcription switch off (the room kept talking; the record ended).
//
//   packages/convex/run.sh huddleBackfill:run '{"room_key":"channel:…"}'            (dry run)
//   packages/convex/run.sh huddleBackfill:run '{"room_key":"channel:…","dryRun":false}'
//   packages/convex/run.sh huddleBackfill:rooms '{}'                                   (rooms to run)
import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { HUDDLE_GRACE_MS } from "./transcripts";
import { retireCallDigest } from "./chat";
import { isRecRoomKey } from "@codecast/shared/contracts";

const OFF_GAP_MS = 15 * 60_000;

type Group = { keep: Doc<"transcripts">; fold: Doc<"transcripts">[] };

/** Every huddle room that has a call record. */
export const rooms = internalQuery({
  args: {},
  handler: async (ctx) => {
    const keys = new Set<string>();
    for await (const t of ctx.db.query("transcripts")) {
      if (!isRecRoomKey(t.room_key)) keys.add(t.room_key);
    }
    return [...keys];
  },
});

export const run = internalMutation({
  args: { room_key: v.string(), dryRun: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? true;
    if (isRecRoomKey(args.room_key)) return { groups: [], stamped: 0 };
    const records = (
      await ctx.db
        .query("transcripts")
        .withIndex("by_room", (q) => q.eq("room_key", args.room_key))
        .collect()
    ).sort((a, b) => a.started_at - b.started_at);
    const lines = await ctx.db
      .query("call_chat_messages")
      .withIndex("by_room", (q) => q.eq("room_key", args.room_key))
      .collect();
    const offAt = lines.filter((l) => l.event === "transcribe_off").map((l) => l._creationTime);

    const groups: Group[] = [];
    for (const t of records) {
      const last = groups[groups.length - 1];
      const prev = last ? [last.keep, ...last.fold].reduce((a, b) => ((a.ended_at ?? 0) >= (b.ended_at ?? 0) ? a : b)) : null;
      const prevEnd = prev?.ended_at;
      if (prev && prev.status === "ended" && t.status === "ended" && prevEnd !== undefined) {
        const gap = t.started_at - prevEnd;
        const switchedOff = offAt.some((at) => Math.abs(at - prevEnd) < 5_000);
        if (gap >= 0 && (gap <= HUDDLE_GRACE_MS || (switchedOff && gap <= OFF_GAP_MS))) {
          last.fold.push(t);
          continue;
        }
      }
      groups.push({ keep: t, fold: [] });
    }

    const report = groups
      .filter((g) => g.fold.length > 0)
      .map((g) => ({
        keep: String(g.keep._id),
        title: g.keep.title ?? null,
        fold: g.fold.map((t) => ({ id: String(t._id), started_at: t.started_at, segments: t.last_seq, title: t.title ?? null })),
      }));
    if (!dryRun) {
      for (const g of groups) if (g.fold.length > 0) await fold(ctx, g);
    }

    // Stamp each unstamped line with the huddle it fell inside (a grace's
    // slack either side), after the fold so it lands on the kept record.
    const spans = groups.map((g) => {
      const all = [g.keep, ...g.fold];
      return {
        id: g.keep._id,
        from: g.keep.started_at - HUDDLE_GRACE_MS,
        to: Math.max(...all.map((t) => t.ended_at ?? Date.now())) + HUDDLE_GRACE_MS,
        live: all.some((t) => t.status === "live"),
        folded: new Set(g.fold.map((t) => String(t._id))),
      };
    });
    let stamped = 0;
    for (const l of lines) {
      const owner = l.transcript_id
        ? spans.find((s) => s.folded.has(String(l.transcript_id)))
        : spans.find((s) => !s.live && l._creationTime >= s.from && l._creationTime <= s.to);
      if (!owner) continue;
      stamped++;
      if (!dryRun) await ctx.db.patch(l._id, { transcript_id: owner.id });
    }
    return { dryRun, records: records.length, groups: report, stamped };
  },
});

/** Fold a run of fragments into its first record: words on its clock and
 *  numbering, the sessions they reached, who spoke, and one summary. */
async function fold(ctx: any, g: Group): Promise<void> {
  const keep = g.keep;
  let lastSeq = keep.last_seq;
  let endedAt = keep.ended_at ?? keep.started_at;
  const participants = new Map((keep.participants ?? []).map((p) => [p.id, p]));
  const routes = [...keep.routes];
  for (const t of g.fold) {
    const shiftSeq = lastSeq;
    const shiftMs = t.started_at - keep.started_at;
    const segs = await ctx.db
      .query("transcript_segments")
      .withIndex("by_transcript_seq", (q: any) => q.eq("transcript_id", t._id))
      .collect();
    for (const s of segs) {
      await ctx.db.patch(s._id, { transcript_id: keep._id, seq: s.seq + shiftSeq, t0: s.t0 + shiftMs, t1: s.t1 + shiftMs });
    }
    for (const r of t.routes) {
      if (routes.some((k) => k.kind === r.kind && k.target === r.target)) continue;
      routes.push({ ...r, sent_seq: r.sent_seq + shiftSeq });
    }
    const links = await ctx.db
      .query("call_session_links")
      .withIndex("by_transcript", (q: any) => q.eq("transcript_id", t._id))
      .collect();
    for (const link of links) {
      const excerpts = (link.excerpts ?? []).map((e: any) => ({ ...e, from_seq: e.from_seq + shiftSeq, to_seq: e.to_seq + shiftSeq }));
      const twin = await ctx.db
        .query("call_session_links")
        .withIndex("by_transcript", (q: any) => q.eq("transcript_id", keep._id))
        .filter((q: any) => q.eq(q.field("conversation_id"), link.conversation_id))
        .first();
      if (twin) {
        await ctx.db.patch(twin._id, {
          excerpts: [...(twin.excerpts ?? []), ...excerpts],
          live: twin.live || link.live,
          updated_at: Math.max(twin.updated_at, link.updated_at),
        });
        await ctx.db.delete(link._id);
      } else {
        await ctx.db.patch(link._id, { transcript_id: keep._id, excerpts });
      }
    }
    for (const p of t.participants ?? []) if (!participants.has(p.id)) participants.set(p.id, p);
    lastSeq += t.last_seq;
    endedAt = Math.max(endedAt, t.ended_at ?? t.started_at);
    await retireCallDigest(ctx, t);
    await ctx.db.delete(t._id);
  }
  await ctx.db.patch(keep._id, {
    last_seq: lastSeq,
    ended_at: endedAt,
    participants: [...participants.values()],
    routes,
    summary_status: "pending",
  });
  await ctx.scheduler.runAfter(0, internal.transcripts.generateSummary, { transcript_id: keep._id });
}
