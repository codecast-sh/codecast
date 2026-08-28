// BEING HEARD FROM THE FIRST WORD.
//
// A walkie burst is audible only once the speaker's media connection is up, and
// that connection is the slow part of the whole feature: 1.0s into a room this
// client had already touched, up to 12.7s into a cold one. Those seconds are
// not silence — the recorder and the recognizer run from t=0, so the words are
// kept and the message lands — but they are RECORDED rather than heard, which
// is the difference between a walkie and voicemail.
//
// So the connection is opened before the gesture that needs it. Opening a DM,
// or resting on somebody's face, is enough of a signal to mint a token and sit
// in the room silently. When the press comes, `joinCall` takes this connection
// instead of building one.
//
// WHAT A PREWARM IS NOT, because every one of these would be a lie told on
// somebody's behalf:
//
//   A MICROPHONE, OPEN AND MUTED — and this one changed. The first version held
//   the connection and published nothing, which measured 1.2s from a press to
//   the far side hearing it: about 550ms of that was the SFU negotiating
//   delivery of a NEWLY published track, and that leg only disappears if the
//   track is already published and already subscribed when the key goes down.
//   The founder chose the trade: the device is opened while you hover, muted at
//   the SFU and sending nothing, so a press is an unmute rather than a publish.
//   The browser's recording indicator lights up while you rest on a face, and
//   that is the accepted cost.
//
//   What did NOT move: this can never PROMPT. It takes the walkie's warm path,
//   which proceeds only where permission is already granted, so a pointer
//   crossing the shell can no more raise a permission dialog than before. The
//   device is muted before it is published, never after, so no audio escapes in
//   the gap. And it is given back — the clone is stopped on release, and the
//   shared device goes back on the walkie's own idle clock.
//
//   Not a seat. The row it writes carries `prewarm: true` and `liveMembers`
//   drops it, so it is not occupancy, not "X hears you", not a grant and not
//   the room's lease. Nobody's screen says a person is here.
//
//   Not a surface. The store's `call` slice is never written, so
//   `callDockSurface` reads "none" by construction: no dock, no strip, no
//   window. There is nothing to show, because nothing is happening.
//
//   Not unbounded. One room at a time, released after PREWARM_IDLE_MS, and
//   never while the call plane is doing anything real.
import { ConnectionState, RemoteParticipant, RemoteTrack, Room, RoomEvent, Track } from "livekit-client";
import { api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../../store/inboxStore";
import { micConstraints, readJoinPrefs } from "./joinPrefs";

type ConvexHandle = {
  mutation: (fn: any, args: any) => Promise<any>;
  action: (fn: any, args: any) => Promise<any>;
};

/** How long a connection nobody used is worth holding open.
 *
 *  It pays for an SFU connection and a token, so it is not free, and the whole
 *  value is spent in the seconds after the signal that opened it — a DM you
 *  just opened, a face you are resting on. A minute and a half covers reading a
 *  message and answering it; past that the guess was wrong and the room should
 *  go back. Under the token's own 15 minute life by a wide margin, so a warm
 *  room never hands `joinCall` an expired one. */
export const PREWARM_IDLE_MS = 90_000;

let convex: ConvexHandle | null = null;

/**
 * The microphone, and the speakers, handed IN rather than imported.
 *
 * Both live behind `callManager`, and `callManager` owns this module, so an
 * import in that direction would close a cycle — the class that has already
 * cost this repo a boot crash. `walkieMic` registers the mic from its own side
 * (it may import this file; this file may not import it) for exactly the reason
 * `bindMicInUse` next door is injected, and callManager hands over the audio
 * sink when it binds.
 *
 * Absent either one, a prewarm is still a prewarm: it holds the connection and
 * simply does not go as fast. Nothing here is load-bearing for correctness.
 */
type MicSource = () => Promise<MediaStreamTrack | null>;
let micSource: MicSource | null = null;
export function bindPrewarmMic(fn: MicSource): void {
  micSource = fn;
}

type AudioSink = {
  attach: (track: RemoteTrack, participantId: string) => void;
  detach: (track: RemoteTrack, participantId: string) => void;
};
let sink: AudioSink | null = null;
export function bindPrewarmAudio(s: AudioSink): void {
  sink = s;
}

type Warm = {
  roomKey: string;
  room: Room;
  /** Our own copy of the shared device. A CLONE, by this codebase's rule: the
   *  walkie records from the original and a room closing mid-word must not be
   *  able to truncate the recording. Stopped when the prewarm is released. */
  micClone?: MediaStreamTrack;
  /** The microphone the prefs named when this room was built. A room carries
   *  its capture defaults from construction, so if the person has changed
   *  device since, this connection would open the wrong microphone. */
  micDeviceId?: string;
};

let warm: Warm | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
// Same job as callManager's `callGen`, for the same reason: a connect that
// resumes after its awaits and finds the world moved on must abandon its Room
// rather than install it. Here the stake is higher than a stray connection —
// `mintAccessToken` signs the identity as the user id, so a late prewarm
// landing on top of a real join evicts that join with DUPLICATE_IDENTITY and
// takes the audio out of a live conversation.
let gen = 0;

export function bindPrewarmConvex(client: ConvexHandle) {
  convex = client;
}

function clearIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
}

function armIdleTimer() {
  clearIdleTimer();
  idleTimer = setTimeout(() => releasePrewarm(), PREWARM_IDLE_MS);
}

/** The room being held, for tests and the dev console. */
export function prewarmedRoomKey(): string | null {
  return warm?.roomKey ?? null;
}

/**
 * Whether a prewarm may start at all, as one question about the call plane.
 *
 * The rule is that a prewarm never competes with anything real. A call plane
 * that holds a room — a huddle, a burst going out, a teammate's burst being
 * listened to — owns this client's LiveKit identity, and a prewarm connecting
 * under the same identity would evict it. A room somebody is already sitting in
 * needs no warming either: the connection it would open is the one that already
 * exists.
 *
 * Read off the store rather than the walkie engine on purpose. The store's
 * `call` slice is the media plane's own truth, which is the thing a second
 * connection would actually collide with, and reading it keeps this module
 * below `walkie.ts` in the import graph instead of in a cycle with it.
 */
export function prewarmAllowed(roomKey: string, state: any): boolean {
  if (!roomKey) return false;
  const call = state.call ?? {};
  if (call.roomKey || call.phase === "connecting" || call.phase === "connected") return false;
  // Somebody is in there. Either a burst is already playing, in which case the
  // join that matters is the receiver's and it is already under way, or a
  // huddle is running and walking in is a decision, not a guess. Connecting
  // anyway would also ring `ParticipantConnected` in their client and play a
  // join sound for a person who never arrived.
  const seated = state.callOccupancy?.[roomKey];
  if (Array.isArray(seated) && seated.length > 0) return false;
  return true;
}

/** Put every voice already in this room on the page, and keep doing it as more
 *  arrive. The room is muted-until-pressed on every side, so this can only ever
 *  play something somebody deliberately sent. */
function hearRoom(room: Room): void {
  const s = sink;
  if (!s) return;
  for (const p of room.remoteParticipants.values()) {
    for (const pub of p.trackPublications.values()) {
      if (pub.isSubscribed && pub.track) s.attach(pub.track as RemoteTrack, p.identity);
    }
  }
  room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _pub, participant: RemoteParticipant) => {
    sink?.attach(track, participant.identity);
  });
  room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack, _pub, participant: RemoteParticipant) => {
    sink?.detach(track, participant.identity);
  });
}

/**
 * Open the microphone and publish it MUTED.
 *
 * The order is the whole safety of it: the clone is disabled before it is
 * handed to LiveKit and the publication is muted immediately, so there is no
 * window in which a hover is broadcasting. Publishing first and muting after
 * would leave exactly such a window, measured in round trips.
 *
 * `micSource` is the walkie's warm path, which proceeds only where permission
 * is already granted — so this can never raise a permission dialog, which is
 * the one rule the founder's decision did not move.
 */
async function publishMutedMic(room: Room, mine: number): Promise<void> {
  const src = micSource;
  if (!src) return;
  let clone: MediaStreamTrack | null = null;
  try {
    const shared = await src();
    if (!shared || shared.readyState !== "live") return;
    // Nothing owns the clone until it is published, so bailing here must stop
    // it: this is the only window in which stopping is ours to do.
    if (gen !== mine || warm?.room !== room) return;
    clone = shared.clone();
    // Silent before it is published, not after.
    clone.enabled = false;
    const pub = await room.localParticipant.publishTrack(clone, {
      source: Track.Source.Microphone,
    });
    await pub.mute();
    // ONCE IT IS PUBLISHED IT IS THE ROOM'S, and this module must not touch it
    // again. A press landing in the middle of this hands the room to `joinCall`
    // (`takePrewarmedRoom` clears `warm` and moves the generation on), and the
    // clone we just published is by then the live microphone of somebody's
    // burst — stopping it here would cut the voice off at the moment it opened.
    // A release instead disconnects the room, which stops the tracks it
    // publishes, so there is nothing left to clean up on that path either.
    if (gen !== mine || warm?.room !== room) return;
    warm.micClone = clone;
  } catch {
    // A microphone that will not open costs the speed and nothing else: the
    // room is still connected and the press still works, publishing then.
    try {
      clone?.stop();
    } catch {}
  }
}

/**
 * HOLD THIS ROOM OPEN. Fire and forget, safe to call on every hover and every
 * render that has a room key.
 *
 * Re-calling for the room already held only pushes the idle release out, so a
 * DM that stays open stays warm without reconnecting, and a pointer settling
 * on the same face twice costs nothing.
 */
export function prewarmRoom(roomKey: string): void {
  if (!convex || !roomKey) return;
  if (warm?.roomKey === roomKey) {
    armIdleTimer();
    return;
  }
  if (!prewarmAllowed(roomKey, useInboxStore.getState())) return;
  // A NEW ROOM RELEASES THE LAST, before anything is awaited: one prewarmed
  // room at a time is what keeps a bar of faces from opening six connections.
  releasePrewarm();
  const mine = ++gen;
  armIdleTimer();
  void (async () => {
    try {
      const prefs = readJoinPrefs();
      // The row saying a connection is being held here. Not awaited by the
      // connect below it — it grants nothing, so the media never waits on it.
      void convex!.mutation(api.calls.joinRoom, { room_key: roomKey, prewarm: true }).catch(() => {});
      const { url, token } = await convex!.action(api.calls.mintAccessToken, {
        room_key: roomKey,
      });
      if (gen !== mine) return;
      const room = new Room({
        adaptiveStream: true,
        dynacast: true,
        audioCaptureDefaults: micConstraints(prefs.micDeviceId),
      });
      await room.connect(url, token);
      if (gen !== mine) {
        void room.disconnect();
        return;
      }
      warm = { roomKey, room, micDeviceId: prefs.micDeviceId };
      // HEARING, ahead of the words. A prewarmed room is subscribed to whatever
      // is published into it, but a subscription is not a sound: something has
      // to put the track on the page. Doing it here rather than waiting for the
      // burst row to arrive and joinCall to adopt is the other half of the
      // saving — the row is a round trip, and a voice that has already reached
      // this machine should not wait for it.
      //
      // Nothing can be heard that nobody chose to send: every seat in the room
      // is muted until its owner presses.
      hearRoom(room);
      // BEING HEARD, ahead of the press. Muted at the SFU, so the publication
      // exists and the far side has negotiated it, and no audio moves until a
      // press unmutes it.
      await publishMutedMic(room, mine);
    } catch {
      // A prewarm that fails costs nothing: the join it was for still works,
      // it is simply as slow as it always was. Never a toast, never an error
      // on the store — nobody asked for this.
      if (gen === mine) clearIdleTimer();
    }
  })();
}

/**
 * HAND THE CONNECTION OVER, or say there isn't one.
 *
 * Called by `joinCall` for EVERY join, not only the ones that hit — because
 * the other half of its job is to stand any prewarm down. A join owns this
 * client's LiveKit identity from here, and a prewarm still in flight would
 * land on top of it and evict it.
 *
 * A room is only handed over if it is the right room, still connected, and
 * still opening the microphone the person currently has chosen. Anything else
 * is disconnected and the caller builds its own, which is the ordinary cold
 * path and correct — a stale prewarm must cost a join nothing but the check.
 */
export function takePrewarmedRoom(roomKey: string): Room | null {
  const held = warm;
  gen++;
  clearIdleTimer();
  warm = null;
  if (!held) return null;
  const usable =
    held.roomKey === roomKey &&
    held.room.state === ConnectionState.Connected &&
    held.micDeviceId === readJoinPrefs().micDeviceId;
  if (!usable) {
    try {
      held.micClone?.stop();
    } catch {}
    void held.room.disconnect();
    return null;
  }
  // The clone goes WITH the room. callManager owns every track it publishes,
  // and disconnecting stops this one like any other, so ownership transfers
  // whole rather than leaving this module holding a handle to a live device in
  // somebody else's call.
  return held.room;
}

/**
 * Drop the held room and the row behind it. Idempotent.
 *
 * The row is deleted rather than left to go stale so an occupancy query in the
 * next second cannot see it at all — `liveMembers` already hides it, and this
 * is the belt to that brace.
 */
export function releasePrewarm(): void {
  gen++;
  clearIdleTimer();
  const held = warm;
  warm = null;
  if (!held) return;
  // THE DEVICE GOES BACK. Disconnecting stops our published copy anyway, but
  // saying it here is what makes the guarantee readable: a hover that came to
  // nothing leaves no microphone open. The SHARED device is not ours to stop —
  // the walkie may still be recording from it — so it goes back on that
  // module's own idle clock, which is already gated on whether a burst is
  // using it.
  try {
    held.micClone?.stop();
  } catch {}
  void held.room.disconnect();
  void convex?.mutation(api.calls.leaveRoom, { room_key: held.roomKey }).catch(() => {});
}

/** Does the room being handed to a join already carry our microphone?
 *
 *  A prewarmed room publishes one, so the join must not publish a second — two
 *  publications of one device is two voices of the same person. */
export function warmRoomPublishesMic(room: Room): boolean {
  return !!room.localParticipant.getTrackPublication(Track.Source.Microphone);
}

// Dev console / e2e access to the real module instance, exactly as callManager
// and the walkie expose theirs. A headless rig has to be able to say "cold"
// and "warm" on purpose — the whole claim of this file is a difference between
// two runs, and a run that merely HOPED the room was cold proves nothing.
if (typeof window !== "undefined" && import.meta.env.DEV) {
  (window as any).__prewarm = {
    hold: prewarmRoom,
    release: releasePrewarm,
    held: prewarmedRoomKey,
    state: () =>
      warm
        ? {
            roomKey: warm.roomKey,
            state: warm.room.state,
            // The two facts that decide whether a press is an unmute or a
            // publish, and they are invisible from anywhere else: this module's
            // Room is not callManager's, so a harness cannot reach it.
            micPublished: warmRoomPublishesMic(warm.room),
            micMuted: !!warm.room.localParticipant.getTrackPublication(Track.Source.Microphone)
              ?.isMuted,
            remoteAudio: [...warm.room.remoteParticipants.values()].flatMap((p) =>
              [...p.trackPublications.values()]
                .filter((pub) => pub.kind === "audio")
                .map((pub) => ({ subscribed: pub.isSubscribed, muted: pub.isMuted })),
            ),
          }
        : null,
  };
}
