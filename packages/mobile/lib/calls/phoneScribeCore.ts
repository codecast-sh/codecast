// The phone scribe's state machine, with its world handed in: the call, the
// store, the getLive watch, the mic tap and the server. lib/calls/phoneScribe
// binds it to the real ones; tests bind it to fakes. No React Native here.
import type { AsrPcmSession } from "@codecast/web/lib/calls/asrPipe";
import type { AsrPipeOpener, ConvexHandle, ScribeEngine } from "@codecast/web/lib/calls/scribeEngine";
import { decidePhoneScribe } from "./phoneScribeRule";

export type PhoneCallView = {
  phase: "idle" | "connecting" | "connected" | "error";
  roomKey: string | null;
  muted: boolean;
  participants: Array<{ identity: string; name: string; phone: boolean; isLocal: boolean }>;
};

export type LiveView = { startedBy: string | null; routes?: Array<{ kind: string; target: unknown }> };

export type MicTapLike = {
  setSink(sink: ((samples: Int16Array, sampleRate: number) => void) | null): void;
  close(): void;
};

export type PhoneScribeDeps = {
  engine: ScribeEngine;
  convex: ConvexHandle;
  call(): PhoneCallView;
  meId(): string | null;
  roomFlags(roomKey: string): { transcribe_off?: boolean; transcribe_off_at?: number | null } | undefined;
  /** transcripts.getLive for one room: undefined while loading, null with no record. */
  watchLive(roomKey: string, onLive: (live: LiveView | null | undefined) => void): () => void;
  openTap(): Promise<MicTapLike | null>;
  openSession(o: Parameters<AsrPipeOpener>[0]): AsrPcmSession;
  flush(transcriptId: string): Promise<unknown>;
  release(roomKey: string): Promise<unknown>;
  now(): number;
  later(fn: () => void, ms: number): void;
};

export const MIC_KEY = "local:mic";
// A start that did not make this phone the scribe (refused, observer, off)
// waits before asking again: reconcile runs on every call-snapshot change.
export const RETRY_MS = 10_000;

/** The room this phone sits in: connected, or reconnecting to the same room. */
function seatedRoom(call: PhoneCallView): string | null {
  return call.phase === "connected" || call.phase === "connecting" ? call.roomKey : null;
}

export function createPhoneScribe(d: PhoneScribeDeps) {
  const { engine } = d;
  let watchedRoom: string | null = null;
  let unwatchLive: (() => void) | null = null;
  let live: LiveView | null | undefined;
  let tap: MicTapLike | null = null;
  // This binary cannot tap the mic: never take a seat it cannot fill.
  let tapUnavailable = false;
  let busy = false;
  let retryAt = 0;

  function watchRoom(roomKey: string | null): void {
    unwatchLive?.();
    unwatchLive = null;
    watchedRoom = roomKey;
    live = undefined;
    if (!roomKey) return;
    unwatchLive = d.watchLive(roomKey, (next) => {
      if (next === undefined) return;
      live = next;
      reconcile();
    });
  }

  // One thing at a time: a start, a hand-over or a stop runs to its end
  // before anything else is decided. The engine emits all through a graceful
  // stop, and a decision taken mid-stop would cut its last line off.
  let op: Promise<void> | null = null;
  function run(fn: () => Promise<void>): void {
    busy = true;
    op = fn().finally(() => {
      busy = false;
      op = null;
      reconcile();
    });
  }

  // End this phone's part in the run. Graceful: commit the line being spoken
  // (the tap still feeding it) and flush the words to the run's agents while
  // this phone is still the scribe, since the server refuses its writes once
  // the run moves on or the room ends. Then the hand-over, if any: Convex
  // applies one client's mutations in order, so it lands after both.
  async function retire(o: { graceful: boolean; keepLive: boolean; releaseRoom?: string }): Promise<void> {
    const id = engine.getStatus().transcriptId;
    await engine.stop({ keepLive: o.keepLive, graceful: o.graceful });
    if (o.graceful && id) await d.flush(id).catch(() => {});
    if (o.releaseRoom) await d.release(o.releaseRoom).catch(() => {});
    tap?.close();
    tap = null;
  }

  function reconcile(): void {
    if (busy) return;
    const call = d.call();
    const roomKey = seatedRoom(call);
    if (roomKey !== watchedRoom) {
      tapUnavailable = false;
      retryAt = 0;
      watchRoom(roomKey);
      if (engine.getStatus().active) return run(() => retire({ graceful: true, keepLive: true }));
    }
    if (!roomKey) return;
    const meId = d.meId();
    const flags = d.roomFlags(roomKey);
    const status = engine.getStatus();
    const verdict = decidePhoneScribe({
      roomKey,
      // Reconnecting holds whatever is running (decideAutoScribe holds while
      // not connected), so a network blip neither ends the run nor starts one.
      connected: call.phase === "connected",
      // The phone has no walkie: every seat it holds was taken on purpose.
      deliberate: true,
      transcribeOff: !!flags?.transcribe_off,
      transcribeOffAt: flags?.transcribe_off_at ?? null,
      scribeStartedAt: status.startedAt,
      rosterIds: call.participants.map((p) => p.identity),
      phoneIds: call.participants.filter((p) => p.phone || p.isLocal).map((p) => p.identity),
      meId,
      live: live === undefined ? undefined : live && { startedBy: live.startedBy },
      scribeActive: status.active,
    });
    if (verdict === "start" && !tapUnavailable && meId && d.now() >= retryAt) run(() => begin(roomKey, meId));
    // Adopted by someone else: its writes would be refused, so nothing to save.
    else if (verdict === "yield") run(() => retire({ graceful: false, keepLive: true }));
    else if (verdict === "stop") run(() => retire({ graceful: false, keepLive: false }));
    else if (verdict === "release") run(() => retire({ graceful: true, keepLive: true, releaseRoom: roomKey }));
  }

  async function begin(roomKey: string, meId: string): Promise<void> {
    const id = await engine.start({ convex: d.convex, roomKey, auto: true }).catch(() => null);
    if (!id) {
      retryAt = d.now() + RETRY_MS;
      d.later(reconcile, RETRY_MS);
      return;
    }
    const micTap = tap ?? (await d.openTap());
    // The mic can take a while (a permission sheet, the audio session): the
    // call may have ended or moved rooms by the time it opens.
    if (!micTap || seatedRoom(d.call()) !== roomKey) {
      micTap?.close();
      if (!micTap) tapUnavailable = true;
      await retire({ graceful: false, keepLive: true, releaseRoom: micTap ? undefined : roomKey });
      return;
    }
    tap = micTap;
    const me = d.call().participants.find((p) => p.isLocal);
    engine.attachPcm(
      MIC_KEY,
      (o) => {
        const session = d.openSession(o);
        // The tap hears the microphone whether or not the huddle is muted, so
        // a muted mic is fed silence: nothing said is heard, and a turn spoken
        // just before muting still closes.
        micTap.setSink((samples, rate) => session.feedInt16(d.call().muted ? new Int16Array(samples.length) : samples, rate));
        return session;
      },
      meId,
      me?.name || "Me",
    );
  }

  /** The call is ending: wait for the last line to be committed and flushed,
   *  so leaving the room (which ends its record) cannot cut it off. */
  async function finishForLeave(): Promise<void> {
    reconcile();
    await op;
  }

  return { reconcile, finishForLeave };
}
