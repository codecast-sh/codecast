// The message half of a burst: the container it is recorded in, whether it was
// anything at all, and the round trip that lands it.
//
// Its own module because none of it knows about rooms, seats or surfaces — it
// turns captured audio into a chat message, and that is a different question
// from the one the state machine next door is answering.
import { api as _api } from "@codecast/convex/convex/_generated/api";

const api = _api as any;

/** Below this, the key was brushed rather than held: nothing was said.
 *
 *  EXPORTED because the people wall's face is both a hold and a click, and a
 *  click is only safe to let open the microphone because anything this short is
 *  discarded here. Its tap window imports the real number and asserts the gap,
 *  so a hand-copied 700 cannot go quietly stale the day this moves. */
export const MIN_BURST_MS = 700;

type ConvexHandle = { mutation: (fn: any, args: any) => Promise<any> };

/** The best container this browser will actually record. */
export function recorderMime(): string {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  for (const mime of candidates) {
    try {
      if (MediaRecorder.isTypeSupported?.(mime)) return mime;
    } catch {}
  }
  return "";
}

/** What the attachment says it is: the container, without the codec parameter
 *  a recorder reports. An <audio> element wants "audio/webm", not the full
 *  "audio/webm;codecs=opus" the browser negotiated. */
export function containerMime(recorded: string): string {
  const base = (recorded || "audio/webm").split(";")[0].trim();
  return base || "audio/webm";
}

/**
 * How long the burst was, and whether it was anything at all.
 *
 * Two spans, because the two questions are different. The HOLD is press to
 * release, and it is the only honest test of "did somebody mean this": mic
 * acquisition, the room join and the start round trip all sit between the two,
 * and charging them to the hold made a 60ms brush measure 1.3s — so MIN_BURST_MS
 * could never fire and every brushed key posted a wordless voice note. The
 * DURATION is the recording's own span, capture to stop, which is what the
 * bubble displays and what the audio actually contains. A burst with no
 * recorder to run (an old browser, a blocked codec) has only its hold to report.
 */
export function measureBurst(input: {
  startedAt: number;
  captureAt: number | null;
  releasedAt: number;
  stoppedAt: number;
  transcript: string;
  hasAudio: boolean;
}): { durationMs: number; discard: boolean } {
  const holdMs = Math.max(0, input.releasedAt - input.startedAt);
  const durationMs = input.captureAt ? Math.max(0, input.stoppedAt - input.captureAt) : holdMs;
  // Brushed, or a burst carrying neither words nor audio: the same nothing by
  // two routes, and the caller throws both away the same way.
  const discard = holdMs < MIN_BURST_MS || (!input.transcript.trim() && !input.hasAudio);
  return { durationMs, discard };
}

/**
 * The last round trip of a burst, and the one place that decides what a failed
 * one means. A burst that cannot be finalized is not a message — the audio is
 * over and cannot be replayed later — so the fallback is to cancel it, exactly
 * as a burst too short to mean anything is cancelled.
 *
 * Three honest answers, because the sender's own bubble depends on which:
 *   landed     — it is a message; paint it done.
 *   cancelled  — the server took it back; nothing exists anywhere.
 *   unresolved — nobody answered; the row's fate is the server's to settle.
 */
export async function landBurst(
  convex: ConvexHandle,
  opts: {
    messageId: string;
    content: string;
    durationMs: number;
    attachments: Array<{ storage_id: string; mime: string; name: string }>;
  },
): Promise<"landed" | "cancelled" | "unresolved"> {
  try {
    await convex.mutation(api.chat.finalizeVoiceBurst, {
      message_id: opts.messageId,
      content: opts.content,
      duration_ms: opts.durationMs,
      attachments: opts.attachments.length ? opts.attachments : undefined,
    });
    return "landed";
  } catch {
    try {
      await convex.mutation(api.chat.cancelVoiceBurst, { message_id: opts.messageId });
      return "cancelled";
    } catch {
      return "unresolved";
    }
  }
}
