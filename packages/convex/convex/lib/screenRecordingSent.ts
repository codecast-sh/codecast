// The moment a screen recording is sent: the message that carries its tag
// is queued into its session (pendingMessages.enqueuePendingMessage, the one
// choke point every send passes). The recording is marked then, so the
// unsent sweep (screenRecordings.sweepUnsent) reads a mark instead of
// searching a session's queue, which a busy session would outgrow.
//
// Only the recording's own sending counts: its tag, at the head of a message
// into the session it was picked for, from the person who recorded it. A
// teammate's text naming it marks nothing.
// A leaf: pendingMessages imports it, and screenRecordings imports
// pendingMessages' callers, so nothing here may import a function module.
import { parseScreenRecordingMessage } from "@codecast/shared/contracts";

export async function noteScreenRecordingSent(ctx: { db: any }, conversationId: string, fromUserId: string, content: string): Promise<void> {
  const parsed = parseScreenRecordingMessage(content);
  if (!parsed?.transcriptId) return;
  const id = ctx.db.normalizeId("transcripts", parsed.transcriptId);
  const t = id ? await ctx.db.get(id) : null;
  const rec = t?.screen_recording;
  if (!rec || rec.sent_at || t.short_id !== parsed.call) return;
  if (String(rec.conversation_id ?? "") !== String(conversationId) || String(t.started_by) !== String(fromUserId)) return;
  await ctx.db.patch(t._id, { screen_recording: { ...rec, sent_at: Date.now() } });
}
