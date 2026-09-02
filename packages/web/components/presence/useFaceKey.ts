// A FACE IS A KEY YOU HOLD.
//
// The people wall proved the gesture: the whole circle is the push-to-talk key,
// a release under WALL_TAP_MS is a click that opens the DM instead, and the two
// rings on the face say which direction a voice is going. The avatar bar in the
// shell is the same face doing the same job, so the gesture lives here once and
// each surface supplies only its shape.
//
// No components in this file, so the surfaces that DO render one stay Fast
// Refresh boundaries — the same split hooks/useWalkie keeps.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { dmRoomKey } from "@codecast/shared/contracts";
import {
  getWalkieStatus,
  subscribeWalkie,
  walkieJoinedRoom,
  type WalkieStatus,
} from "../../lib/calls/walkie";
import { usePushToTalk, useWalkieLevelVar, walkieKeyState, type PushToTalk } from "../../hooks/useWalkie";
import { prewarmRoom } from "../../lib/calls/roomPrewarm";
import { useInboxStore } from "../../store/inboxStore";
import { useMountEffect } from "../../hooks/useMountEffect";

/** How long the refusal hint stays up after a press that could not open a mic.
 *  Long enough to read a short sentence, short enough that it is gone before
 *  the hand comes back. */
export const REFUSAL_MS = 2200;

/** How long "joined" stays under a face after somebody steps into the burst.
 *  The founder asked for "a message like hey he joined": long enough to read
 *  across a room, short enough that it is not a badge the face now wears. */
export const JOINED_MS = 4000;

/** How long a pointer has to REST on a face before it counts as interest.
 *
 *  A mouse crossing the shell to reach anything at all sweeps six faces, and
 *  each one would mint a token, open an SFU connection and open a microphone.
 *  Four hundred milliseconds is longer than any crossing and shorter than any
 *  decision, so what it selects is a pointer that stopped — which is a person
 *  looking at somebody, and the best warning this side gets.
 *
 *  It carries more weight than it used to. The prewarm now opens the device as
 *  well as the connection, so this number is what stands between a mouse
 *  crossing the screen and the recording indicator coming on. */
export const PREWARM_DWELL_MS = 400;

/**
 * THE THREE WALKIE FACTS A FACE DRAWS, as one string.
 *
 * The engine's status moves on more than a face draws — the recognizer going
 * down, an error being cleared, a room changing what it is. A surface that
 * subscribes to the object re-renders on every one of those, and the avatar bar
 * is mounted for the life of the app. So the subscription is a signature of
 * exactly what a face shows: who is talking to me, which room my own key is
 * open into, and which room somebody stepped into on purpose.
 *
 * Pure and exported so a test can prove both halves of the promise: it moves
 * when the walkie moves, and it holds still through everything else.
 */
export function walkieFacesSig(s: WalkieStatus): string {
  return `${s.incoming?.fromUserId ?? ""}|${s.sending?.roomKey ?? ""}|${walkieJoinedRoom(s) ?? ""}`;
}

export type WalkieFaces = {
  /** Whose voice is coming out of this machine right now, if anyone's. */
  talkingId: string;
  /** The room this client's own key is open into, if any. */
  sendingRoomKey: string;
  /** The room somebody stepped into on purpose, if any. */
  joinedRoom: string;
};

// Cached at module scope, keyed by the signature: useSyncExternalStore compares
// snapshots by identity, so a fresh object every call would render forever.
let facesSig = "";
let faces: WalkieFaces = { talkingId: "", sendingRoomKey: "", joinedRoom: "" };

function facesSnapshot(): WalkieFaces {
  const s = getWalkieStatus();
  const sig = walkieFacesSig(s);
  if (sig !== facesSig) {
    facesSig = sig;
    faces = {
      talkingId: String(s.incoming?.fromUserId ?? ""),
      sendingRoomKey: s.sending?.roomKey ?? "",
      joinedRoom: walkieJoinedRoom(s) ?? "",
    };
  }
  return faces;
}

/** The walkie, as the three facts a wall or a bar of faces draws — and nothing
 *  else, so nine fields of engine churn wake nobody. */
export function useWalkieFaces(): WalkieFaces {
  return useSyncExternalStore(subscribeWalkie, facesSnapshot, facesSnapshot);
}

export type FaceKey = {
  /** What the talk is doing: idle, opening, live, dropped, locked. */
  state: ReturnType<typeof walkieKeyState>;
  /** The microphone is open into this face's room — what lights the warm ring. */
  sending: boolean;
  /** This client is talking into this face's room right now. */
  holding: boolean;
  /** Their voice is coming out of this machine right now. */
  talking: boolean;
  /** Why Talk cannot start, in the words a button says; null when it can. */
  blocked: string | null;
  /** The DM room this face's actions open into. */
  roomKey: string;
  /** The toggle itself, for the Talk button (FaceActions). */
  ptt: PushToTalk;
  /** Ref callbacks for the two level rings: warm going out, cool coming in. */
  txRef: (el: HTMLSpanElement | null) => void;
  rxRef: (el: HTMLSpanElement | null) => void;
  /** Spread onto the face: resting on it or tabbing to it warms the room, so
   *  a Talk pressed a moment later is heard from the first word. */
  warmProps: {
    onPointerEnter: () => void;
    onPointerLeave: () => void;
    onFocus: () => void;
  };
};

/**
 * The face as the front of three actions — Talk, Ring, Message — and the two
 * rings that say what is going on in its room. NO HOLD: a face is clicked, and
 * what it offers is written on buttons (components/presence/FaceActions). The
 * hold gesture was turned off because a click that opened a microphone felt
 * like an accident every time.
 *
 * NO WARM ON HOVER-ENTER, only on a DWELL. A mouse crossing the shell sweeps
 * six faces on the way to anything, and the browser's recording indicator
 * lighting up because somebody moved a pointer is not acceptable. Resting on
 * a face for PREWARM_DWELL_MS connects the ROOM (not the mic) ahead of a Talk.
 */
export function useFaceKey({
  viewerId,
  memberId,
  callsEnabled,
  talking,
}: {
  viewerId: string;
  memberId: string;
  callsEnabled: boolean;
  talking: boolean;
}): FaceKey {
  const roomKey = dmRoomKey(viewerId, memberId);
  const ptt = usePushToTalk(
    callsEnabled ? roomKey : undefined,
    // At TALK time, never at render: pointing at a bar of six faces must not
    // create six conversations.
    useCallback(() => useInboxStore.getState().openDmChannel([memberId]), [memberId]),
  );
  const state = walkieKeyState(ptt);
  // The warm ring lights on the microphone being OPEN, and stays lit through
  // the latch — the seat is this client's own voice going out either way.
  const sending = state === "live" || state === "dropped" || state === "locked";

  // Two rings, two subscriptions, two custom properties — because one element
  // can carry only one `--level` and both directions can be true at once. Each
  // ring owns its ref, so the warm one follows this machine's microphone and
  // the cool one follows their voice, with no React render in either loop.
  const txRef = useWalkieLevelVar<HTMLSpanElement>(sending);
  const rxRef = useWalkieLevelVar<HTMLSpanElement>(talking, memberId);

  const blocked = callsEnabled ? ptt.reason : "Calls are not on for this team";

  // THE ROOM, EARLY. The timer is a ref rather than state: nothing on screen
  // changes, so a render would be a render for nobody.
  const dwellTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelDwell = () => {
    if (dwellTimer.current) clearTimeout(dwellTimer.current);
    dwellTimer.current = null;
  };
  useMountEffect(() => cancelDwell);
  const warmProps = {
    onPointerEnter: () => {
      if (!callsEnabled) return;
      cancelDwell();
      dwellTimer.current = setTimeout(() => prewarmRoom(roomKey), PREWARM_DWELL_MS);
    },
    onPointerLeave: cancelDwell,
    // Tabbing onto a face is the deliberate version of resting on one.
    onFocus: () => {
      if (callsEnabled) prewarmRoom(roomKey);
    },
  };

  return { state, sending, holding: ptt.holding, talking, blocked, roomKey, ptt, txRef, rxRef, warmProps };
}

/**
 * Somebody stepped into this room in the last JOINED_MS.
 *
 * The founder's "a message like hey he joined", on the face it happened to. The
 * engine's live room becoming a call is the moment the burst stopped being one,
 * set by
 * this client's own Join live and by the far side's stamp arriving, so both
 * sides of the upgrade land here.
 *
 * One render when it opens and one when it closes, never a clock read in a
 * render: the badge is an event, not a duration.
 */
export function useRecentJoin(roomKey: string, joinedRoom: string): boolean {
  const [shown, setShown] = useState(false);
  const seen = useRef(joinedRoom);
  // eslint-disable-next-line no-restricted-syntax -- a four-second badge keyed to an engine event; the effect owns its timer
  useEffect(() => {
    if (joinedRoom === seen.current) return;
    seen.current = joinedRoom;
    if (!roomKey || joinedRoom !== roomKey) return;
    setShown(true);
    const t = setTimeout(() => setShown(false), JOINED_MS);
    return () => clearTimeout(t);
  }, [joinedRoom, roomKey]);
  return shown;
}
