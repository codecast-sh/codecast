// The scribe: live, speaker-attributed transcription of a huddle.
//
// Runs entirely in the client that toggled Transcribe on. For every audio
// track in the room — the local mic and each subscribed remote track — it
// opens one OpenAI Realtime transcription websocket and streams that track's
// PCM. One track = one participant, so every piece of text arrives already
// attributed; there is no diarization step to be wrong.
//
// What this file OWNS is the room: which LiveKit tracks exist right now, and
// keeping the run's set of microphones equal to that set as people join,
// leave, mute and reconnect. Everything downstream of a microphone — the
// recognizers, the appended segments, the caption tail and the silence beat on
// which live routes deliver — is lib/calls/scribeEngine, which the recorder
// runs a second instance of on one local mic.
//
// Module singleton beside callManager, same pattern: components read the small
// status snapshot via subscribe/getSnapshot; nothing here touches the store
// except through convex mutations.
import { Room, RoomEvent, Track } from "livekit-client";
import { createScribeEngine, type ConvexHandle, type ScribeStatus } from "./scribeEngine";

export { GAP_MS, MAX_HOLD_MS, type ScribeStatus } from "./scribeEngine";

const engine = createScribeEngine();

let room: Room | null = null;
let roomListener: (() => void) | null = null;
/** Every pipe key the room opened, so a track that goes away can be matched
 *  back to it by track sid alone (LiveKit hands the sid to the unsubscribe
 *  event, never our key). */
const keysBySid = new Map<string, string>();

export function subscribeScribe(cb: () => void): () => void {
  return engine.subscribe(cb);
}

export function getScribeStatus(): ScribeStatus {
  return engine.getStatus();
}

function attachTrack(
  key: string,
  sid: string | undefined,
  track: MediaStreamTrack,
  speakerId: string,
  speakerName: string,
) {
  if (sid) keysBySid.set(sid, key);
  engine.attach(key, track, speakerId, speakerName);
}

function attachRoomTracks() {
  if (!room) return;
  // Local mic.
  const micPub = room.localParticipant.getTrackPublication(Track.Source.Microphone);
  const me = room.localParticipant;
  if (micPub?.track?.mediaStreamTrack) {
    attachTrack(
      `local:${micPub.trackSid}`,
      micPub.trackSid,
      micPub.track.mediaStreamTrack,
      me.identity,
      me.name || "Me",
    );
  }
  // Every subscribed remote audio track.
  for (const p of room.remoteParticipants.values()) {
    const pub = p.getTrackPublication(Track.Source.Microphone);
    if (pub?.isSubscribed && pub.track?.mediaStreamTrack) {
      attachTrack(
        `${p.identity}:${pub.trackSid}`,
        pub.trackSid,
        pub.track.mediaStreamTrack,
        p.identity,
        p.name || p.identity,
      );
    }
  }
}

/** Become the room's scribe, if the server says this client is it. Resolves
 *  true when a run is now live here; false when somebody else's run already
 *  covers the room, the huddle opted out (`auto` only), or the server
 *  refused — in which case no track was attached and nothing is held. */
export async function startScribe(opts: {
  convex: ConvexHandle;
  room: Room;
  roomKey: string;
  routes?: Array<{ kind: "session" | "doc" | "slack"; target: string; mode: "live" | "after" }>;
  auto?: boolean;
}): Promise<boolean> {
  if (engine.getStatus().active) return true;
  const id = await engine.start({
    convex: opts.convex,
    roomKey: opts.roomKey,
    routes: opts.routes,
    auto: opts.auto,
  });
  if (!id) return false;
  room = opts.room;
  keysBySid.clear();

  attachRoomTracks();
  const onTrack = () => attachRoomTracks();
  room.on(RoomEvent.TrackSubscribed, onTrack);
  room.on(RoomEvent.LocalTrackPublished, onTrack);
  const onGone = (_t: unknown, pub: { trackSid?: string }) => {
    const key = pub?.trackSid ? keysBySid.get(pub.trackSid) : undefined;
    if (key) {
      engine.detach(key);
      keysBySid.delete(pub.trackSid!);
    }
  };
  room.on(RoomEvent.TrackUnsubscribed, onGone as any);
  roomListener = () => {
    room?.off(RoomEvent.TrackSubscribed, onTrack);
    room?.off(RoomEvent.LocalTrackPublished, onTrack);
    room?.off(RoomEvent.TrackUnsubscribed, onGone as any);
  };
  return true;
}

/**
 * End this window's scribe run.
 *
 * `keepLive` passes straight through to the engine: it releases the local
 * machinery without declaring the transcript over on the server. The call panel
 * handoff is what needs it — the huddle carries on in another window, and a
 * transcript must not end at a window boundary the speakers never saw.
 */
export async function stopScribe(opts?: { keepLive?: boolean }): Promise<void> {
  roomListener?.();
  roomListener = null;
  room = null;
  keysBySid.clear();
  await engine.stop(opts);
}

// Dev console / e2e access to the real module instance (a dynamic import()
// of this file would be a second instance with its own empty state — the
// same trap __callManager documents).
if (typeof window !== "undefined" && import.meta.env.DEV) {
  (window as any).__scribe = {
    start: startScribe,
    stop: stopScribe,
    status: getScribeStatus,
  };
}
