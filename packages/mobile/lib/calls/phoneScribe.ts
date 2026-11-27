// The phone as a huddle's scribe for its own microphone. Web and desktop
// transcribe every track in the room; a phone huddle with nobody else in it
// (a walk, talking to a session) had no transcript at all. This runs the same
// scribe engine web runs, on the native mic tap (asrCapture.openMicTap), and
// decides when with phoneScribeRule. A module singleton beside callManager,
// so it keeps going with the call screen closed and the phone locked.
import { makeFunctionReference } from "convex/server";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { openAsrPcmSession } from "@codecast/web/lib/calls/asrPipe";
import { createScribeEngine } from "@codecast/web/lib/calls/scribeEngine";
import { useInboxStore } from "@codecast/web/store/inboxStore";
import { convex } from "../convex";
import { openMicTap, type MicTap } from "../asrCapture";
import { getCallSnapshot, subscribeCall } from "./callManager";
import { decidePhoneScribe } from "./phoneScribeRule";

// Hands the scribe seat back when another person sits down. A reference by
// name until transcripts.releaseScribe is in this tree's generated api.
const releaseScribe = makeFunctionReference<"mutation", { room_key: string }>("transcripts:releaseScribe");

const engine = createScribeEngine();
let watchedRoom: string | null = null;
let unwatchLive: (() => void) | null = null;
// transcripts.getLive for the watched room: undefined while loading.
let live: { startedBy: string | null } | null | undefined;
let tap: MicTap | null = null;
// This binary cannot tap the mic (an old build): never take a seat it cannot fill.
let tapUnavailable = false;
let busy = false;
// A start that did not make this phone the scribe (refused, observer, off)
// waits before asking again: reconcile runs on every call-snapshot change.
const RETRY_MS = 10_000;
let retryAt = 0;
let started = false;

/** Start watching calls. Idempotent; called once at app start. */
export function startPhoneScribe(): void {
  if (started) return;
  started = true;
  subscribeCall(reconcile);
  engine.subscribe(reconcile);
  useInboxStore.subscribe((s: any, prev: any) => {
    if (s.callRooms !== prev.callRooms || s.currentUser?._id !== prev.currentUser?._id) reconcile();
  });
  reconcile();
}

function watchRoom(roomKey: string | null): void {
  unwatchLive?.();
  unwatchLive = null;
  watchedRoom = roomKey;
  live = undefined;
  if (!roomKey) return;
  const watch = convex.watchQuery(api.transcripts.getLive, { room_key: roomKey, tail: 1 });
  const read = () => {
    let result: any;
    try {
      result = watch.localQueryResult();
    } catch {
      return;
    }
    if (result === undefined) return;
    live = result ? { startedBy: result.started_by ? String(result.started_by) : null } : null;
    reconcile();
  };
  unwatchLive = watch.onUpdate(read);
  read();
}

async function letGo(opts: { keepLive: boolean }): Promise<void> {
  tap?.close();
  tap = null;
  await engine.stop(opts);
}

function reconcile(): void {
  const call = getCallSnapshot();
  const roomKey = call.phase === "connected" ? call.roomKey : null;
  if (roomKey !== watchedRoom) {
    if (engine.getStatus().active) void letGo({ keepLive: true });
    tapUnavailable = false;
    retryAt = 0;
    watchRoom(roomKey);
  }
  if (busy || !roomKey) return;
  const s: any = useInboxStore.getState();
  const meId = s.currentUser?._id ? String(s.currentUser._id) : null;
  const flags = s.callRooms?.[roomKey];
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
    live,
    scribeActive: status.active,
  });
  if (verdict === "start" && !tapUnavailable && meId && Date.now() >= retryAt) void begin(roomKey, meId);
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
    if (id) await convex.mutation(api.transcripts.flush, { transcript_id: id as Id<"transcripts"> }).catch(() => {});
    await convex.mutation(releaseScribe, { room_key: roomKey }).catch(() => {});
  } finally {
    busy = false;
  }
  reconcile();
}

async function begin(roomKey: string, meId: string): Promise<void> {
  busy = true;
  try {
    const id = await engine.start({ convex, roomKey, auto: true }).catch(() => null);
    if (!id) {
      retryAt = Date.now() + RETRY_MS;
      setTimeout(reconcile, RETRY_MS);
      return;
    }
    const micTap = tap ?? (await openMicTap());
    if (!micTap || watchedRoom !== roomKey) {
      micTap?.close();
      if (!micTap) tapUnavailable = true;
      await engine.stop({ keepLive: true });
      if (!micTap) await convex.mutation(releaseScribe, { room_key: roomKey }).catch(() => {});
      return;
    }
    tap = micTap;
    const me = getCallSnapshot().participants.find((p) => p.isLocal);
    engine.attachPcm(
      "local:mic",
      (o) => {
        const session = openAsrPcmSession(o);
        // The tap hears the microphone whether or not the huddle is muted, so
        // a muted mic is fed silence: nothing said is heard, and a turn spoken
        // just before muting still closes.
        micTap.setSink((samples, rate) =>
          session.feedInt16(getCallSnapshot().muted ? new Int16Array(samples.length) : samples, rate));
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
