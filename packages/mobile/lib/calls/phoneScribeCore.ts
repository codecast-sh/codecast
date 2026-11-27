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

  async function letGo(opts: { keepLive: boolean }): Promise<void> {
    tap?.close();
    tap = null;
    await engine.stop(opts);
  }

  function reconcile(): void {
    const call = d.call();
    const roomKey = call.phase === "connected" ? call.roomKey : null;
    if (roomKey !== watchedRoom) {
      if (engine.getStatus().active) void letGo({ keepLive: true });
      tapUnavailable = false;
      retryAt = 0;
      watchRoom(roomKey);
    }
    if (busy || !roomKey) return;
    const meId = d.meId();
    const flags = d.roomFlags(roomKey);
    const status = engine.getStatus();
    const verdict = decidePhoneScribe({
      roomKey,
      connected: true,
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
    if (verdict === "start" && !tapUnavailable && meId && d.now() >= retryAt) void begin(roomKey, meId);
    else if (verdict === "yield") void letGo({ keepLive: true });
    else if (verdict === "stop") void letGo({ keepLive: false });
    else if (verdict === "release") void release(roomKey);
  }

  // Hand the run to a seat that hears every track. The last words go first: a
  // graceful stop commits the line being spoken and appends it, and the flush
  // delivers them to the run's agents, while this phone is still the scribe
  // (after the hand-over the server refuses its writes). Convex applies one
  // client's mutations in order, so the release lands after both.
  async function release(roomKey: string): Promise<void> {
    busy = true;
    try {
      const id = engine.getStatus().transcriptId;
      tap?.close();
      tap = null;
      await engine.stop({ keepLive: true, graceful: true });
      if (id) await d.flush(id).catch(() => {});
      await d.release(roomKey).catch(() => {});
    } finally {
      busy = false;
    }
    reconcile();
  }

  async function begin(roomKey: string, meId: string): Promise<void> {
    busy = true;
    try {
      const id = await engine.start({ convex: d.convex, roomKey, auto: true }).catch(() => null);
      if (!id) {
        retryAt = d.now() + RETRY_MS;
        d.later(reconcile, RETRY_MS);
        return;
      }
      const micTap = tap ?? (await d.openTap());
      if (!micTap || watchedRoom !== roomKey) {
        micTap?.close();
        if (!micTap) tapUnavailable = true;
        await engine.stop({ keepLive: true });
        if (!micTap) await d.release(roomKey).catch(() => {});
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
    } finally {
      busy = false;
    }
    reconcile();
  }

  return { reconcile };
}
