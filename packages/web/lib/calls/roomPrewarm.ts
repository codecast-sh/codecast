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
//   Not a microphone. Nothing is published, nothing is captured, and the
//   browser's recording indicator stays dark. `pttHoldProps` warms the MIC on
//   hover and this file deliberately does not — a face is not a key you aimed
//   at, and a pointer crossing the shell sweeps six of them.
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
import { ConnectionState, Room } from "livekit-client";
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

type Warm = {
  roomKey: string;
  room: Room;
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
    void held.room.disconnect();
    return null;
  }
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
  void held.room.disconnect();
  void convex?.mutation(api.calls.leaveRoom, { room_key: held.roomKey }).catch(() => {});
}
