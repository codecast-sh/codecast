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

// ── the channel behind a stub ───────────────────────────────────────────────
//
// A face pressed before its DM exists hands the burst an optimistic stub id.
// The server row that makes it real used to be the only way to learn the real
// id: the burst polled the store for it and, after eight seconds of nothing,
// threw itself away with a message that named no cause. Two things were wrong
// with that. The open's own answer already carries the id, so a row that is
// slow to sync back (a satellite window fed by replication) is no reason to
// wait; and an open the server REFUSED is a failure the moment it is refused,
// not eight seconds later under a generic error.

export type ChannelStubOutcome = { id: string } | { failed: string } | null;

/** Resolve a stub to the channel id the server will accept: the store's
 *  answer or the open's own answer, whichever comes first. A refused open
 *  fails at once with its reason; null once the deadline passes or the burst
 *  ended meanwhile. */
export function resolveChannelStub(opts: {
  /** The store's answer right now: the real row the stub rekeyed onto. */
  lookup: () => string | null;
  /** The open still in flight behind this stub, if any: resolves to the
   *  server's id, rejects with its refusal. */
  inFlight: Promise<string | null> | null;
  /** The burst ended, so nobody needs the answer. */
  done: () => boolean;
  deadlineMs: number;
  /** The refusal, in words a strip can show. */
  reason?: (err: unknown) => string;
  tickMs?: number;
  now?: () => number;
}): Promise<ChannelStubOutcome> {
  const found = opts.lookup();
  if (found) return Promise.resolve({ id: found });
  const now = opts.now ?? (() => Date.now());
  const tickMs = opts.tickMs ?? 200;
  const deadline = now() + opts.deadlineMs;
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (out: ChannelStubOutcome) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(out);
    };
    const tick = () => {
      const id = opts.lookup();
      if (id) return finish({ id });
      if (opts.done() || now() > deadline) return finish(null);
      timer = setTimeout(tick, tickMs);
    };
    opts.inFlight
      ?.then((id) => {
        // An answer with no id (an older server) says nothing; the row is
        // still the way to learn it.
        if (id) finish({ id });
      })
      .catch((err) => finish({ failed: (opts.reason ?? String)(err) }));
    timer = setTimeout(tick, tickMs);
  });
}
