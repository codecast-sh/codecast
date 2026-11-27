// The phone as a huddle's scribe for its own microphone. Web and desktop
// transcribe every track in the room; a phone huddle with nobody else in it
// (a walk, talking to a session) had no transcript at all. This runs the same
// scribe engine web runs, on the native mic tap (asrCapture.openMicTap), and
// decides when with phoneScribeRule; phoneScribeCore holds the state machine.
// A module singleton beside callManager, so it keeps going with the call
// screen closed and the phone locked.
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { openAsrPcmSession } from "@codecast/web/lib/calls/asrPipe";
import { createScribeEngine } from "@codecast/web/lib/calls/scribeEngine";
import { storePacing } from "@codecast/web/lib/calls/scribePacing";
import { useInboxStore } from "@codecast/web/store/inboxStore";
import { convex } from "../convex";
import { openMicTap } from "../asrCapture";
import { getCallSnapshot, setBeforeLeave, subscribeCall } from "./callManager";
import { createPhoneScribe } from "./phoneScribeCore";

const engine = createScribeEngine();
const scribe = createPhoneScribe({
  engine,
  convex,
  call: getCallSnapshot,
  meId: () => {
    const id = (useInboxStore.getState() as any).currentUser?._id;
    return id ? String(id) : null;
  },
  roomFlags: (roomKey) => (useInboxStore.getState() as any).callRooms?.[roomKey],
  watchLive: (roomKey, onLive) => {
    const watch = convex.watchQuery(api.transcripts.getLive, { room_key: roomKey, tail: 1 });
    const read = () => {
      let result: any;
      try {
        result = watch.localQueryResult();
      } catch {
        return;
      }
      onLive(result === undefined ? undefined : result ? { startedBy: result.started_by ? String(result.started_by) : null, routes: result.routes } : null);
    };
    const stop = watch.onUpdate(read);
    read();
    return stop;
  },
  openTap: openMicTap,
  openSession: openAsrPcmSession,
  flush: (id) => convex.mutation(api.transcripts.flush, { transcript_id: id as Id<"transcripts"> }),
  release: (roomKey) => convex.mutation(api.scribeSeat.releaseScribe, { room_key: roomKey }),
  pacing: (feedTargets) => storePacing(feedTargets, () => useInboxStore.getState()),
  now: Date.now,
  later: (fn, ms) => void setTimeout(fn, ms),
});

let started = false;

/** Start watching calls. Idempotent; called once at app start. */
export function startPhoneScribe(): void {
  if (started) return;
  started = true;
  subscribeCall(scribe.reconcile);
  setBeforeLeave(scribe.finishForLeave);
  engine.subscribe(scribe.reconcile);
  useInboxStore.subscribe((s: any, prev: any) => {
    if (s.callRooms !== prev.callRooms || s.currentUser?._id !== prev.currentUser?._id) scribe.reconcile();
  });
  scribe.reconcile();
}
