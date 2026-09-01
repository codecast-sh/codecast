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
import {
  isWalkieHoldKey,
  pttHoldProps,
  usePushToTalk,
  useWalkieLevelVar,
  walkieKeyState,
} from "../../hooks/useWalkie";
import { prewarmRoom } from "../../lib/calls/roomPrewarm";
import { useInboxStore } from "../../store/inboxStore";
import { useMountEffect } from "../../hooks/useMountEffect";
import { isWallTap } from "../people/peopleWallLayout";

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

/**
 * The hold gesture with the tap folded into it.
 *
 * `pttHoldProps` alone is a key that only holds. A face is a key AND a link, so
 * every way a press can start is timed and every way it can end asks whether
 * that was a click. Pure, because the two numbers that make it safe
 * (WALL_TAP_MS under MIN_BURST_MS) are only load-bearing if a test can drive
 * the gesture rather than reason about it.
 *
 * NO WARM ON HOVER, and this is the one place a face departs from the key it is
 * built on. `pttHoldProps` opens the microphone when a pointer ARRIVES, which
 * is right for a 28px key you aim at — pointing at it is already the gesture.
 * It is wrong for a face: a mouse crossing the shell to reach anything at all
 * sweeps six of them, and the browser's recording indicator would light up
 * because somebody moved a pointer. Focus still warms: tabbing onto a face is
 * deliberate in a way that passing over one is not.
 */
export function faceKeyHandlers(
  hold: ReturnType<typeof pttHoldProps>,
  gesture: { begin: () => void; finish: () => void },
  /** Ask for this face's room to be connected ahead of any press, after a
   *  delay, or drop a request that has not fired yet. Absent leaves the face
   *  exactly as cold as it was. */
  warm?: { start: (delayMs: number) => void; cancel: () => void },
) {
  return {
    ...hold,
    // THE DWELL IS WHAT BUYS THE DEVICE. Arriving on a face says nothing — a
    // pointer crossing the shell arrives on six of them — so nothing happens on
    // entry. Resting on one says somebody is looking at a person, and that is
    // now enough for the microphone as well as the connection: the prewarm
    // publishes it muted so a press is an unmute rather than a publish, which
    // is the founder's call and the reason the recording indicator can light up
    // while you hover. Four hundred milliseconds is the whole protection, and
    // it is why this is a dwell rather than a pointer-enter.
    onPointerEnter: warm ? () => warm.start(PREWARM_DWELL_MS) : undefined,
    onPointerLeave: () => {
      warm?.cancel();
      hold.onPointerLeave();
    },
    // Tabbing onto a face is the deliberate version of resting on one, so it
    // needs no dwell to prove it — the same judgement `pttHoldProps` already
    // makes about warming the microphone on focus.
    onFocus: () => {
      hold.onFocus();
      warm?.start(0);
    },
    onPointerDown: (e: Parameters<typeof hold.onPointerDown>[0]) => {
      gesture.begin();
      hold.onPointerDown(e);
    },
    onPointerUp: () => {
      hold.onPointerUp();
      gesture.finish();
    },
    // Gated on the same key set the hold itself uses, asked of the same
    // function: without it Tab would time a press of zero milliseconds and its
    // keyup would open a DM on the way past.
    onKeyDown: (e: Parameters<typeof hold.onKeyDown>[0]) => {
      if (isWalkieHoldKey(e.key) && !e.repeat) gesture.begin();
      hold.onKeyDown(e);
    },
    onKeyUp: (e: Parameters<typeof hold.onKeyUp>[0]) => {
      hold.onKeyUp(e);
      if (isWalkieHoldKey(e.key)) gesture.finish();
    },
  };
}

export type FaceKey = {
  /** What the key is doing: idle, opening, live, dropped. */
  state: ReturnType<typeof walkieKeyState>;
  /** The microphone is open into this face's room — what lights the warm ring. */
  sending: boolean;
  /** The thumb is down, which starts before the mic answers. */
  holding: boolean;
  /** Their voice is coming out of this machine right now. */
  talking: boolean;
  /** A press that could not open a mic, for REFUSAL_MS. */
  refused: boolean;
  /** Why the hold is refused, in the words a tooltip says; null when it can. */
  blocked: string | null;
  /** The DM room this face's key opens into. */
  roomKey: string;
  /** Ref callbacks for the two level rings: warm going out, cool coming in. */
  txRef: (el: HTMLSpanElement | null) => void;
  rxRef: (el: HTMLSpanElement | null) => void;
  /** Spread onto whatever element is the face. */
  keyProps: ReturnType<typeof faceKeyHandlers>;
};

/**
 * The face as a walkie key: hold to talk, tap to open the conversation.
 *
 * `onTap` runs on a release under WALL_TAP_MS and nowhere else. A tap DOES open
 * the microphone for those milliseconds — waiting to find out what somebody
 * meant would eat the first word of every sentence — and costs nothing, because
 * the engine discards any burst under MIN_BURST_MS.
 */
export function useFaceKey({
  viewerId,
  memberId,
  callsEnabled,
  talking,
  onTap,
  name,
}: {
  viewerId: string;
  memberId: string;
  callsEnabled: boolean;
  talking: boolean;
  onTap: () => void;
  /** What to call them in the lock's "You joined Jordan" sentence. Optional:
   *  a surface that cannot name them still locks the same way. */
  name?: string;
}): FaceKey {
  const roomKey = dmRoomKey(viewerId, memberId);
  const nameRef = useRef(name);
  nameRef.current = name;
  const ptt = usePushToTalk(
    callsEnabled ? roomKey : undefined,
    // At PRESS time, never at render: pointing at a bar of six faces must not
    // create six conversations.
    useCallback(() => useInboxStore.getState().openDmChannel([memberId]), [memberId]),
    useCallback(() => nameRef.current ?? null, []),
  );
  const state = walkieKeyState(ptt);
  // TWO different questions, and using one for both dimmed the face you were
  // talking to for the first tenth of a second. `sending` is the microphone
  // being OPEN, which is what lights the ring and presses the face down.
  // `ptt.holding` is the thumb being down, which starts at the press and covers
  // the opening gap before the mic answers. `locked` joins them because the
  // latch is this client's own voice going out too — the warm ring must not
  // blink off at the exact moment the gesture succeeds.
  const sending = state === "live" || state === "dropped" || state === "locked";

  // Two rings, two subscriptions, two custom properties — because one element
  // can carry only one `--level` and both directions can be true at once (you
  // hold their face while their own burst is still playing). Each ring owns its
  // ref, so the warm one follows this machine's microphone and the cool one
  // follows their voice, with no React render in either loop.
  const txRef = useWalkieLevelVar<HTMLSpanElement>(sending);
  const rxRef = useWalkieLevelVar<HTMLSpanElement>(talking, memberId);

  const blocked = callsEnabled ? ptt.reason : "Calls are not on for this team";

  const [refused, setRefused] = useState(false);
  const refusalTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useMountEffect(() => () => {
    if (refusalTimer.current) clearTimeout(refusalTimer.current);
  });

  // `performance.now()` rather than Date.now(): a duration must not be at the
  // mercy of the system clock being corrected mid-press.
  const downAt = useRef(0);

  // THE ROOM, EARLY. Resting on a face or tabbing onto it is the first signal
  // this side gets that a burst may be coming, and the connection is the slow
  // part of being heard. The timer is a ref rather than state: nothing on
  // screen changes, so a render would be a render for nobody.
  const dwellTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelDwell = () => {
    if (dwellTimer.current) clearTimeout(dwellTimer.current);
    dwellTimer.current = null;
  };
  useMountEffect(() => cancelDwell);
  const warm = {
    start: (delayMs: number) => {
      if (!callsEnabled) return;
      cancelDwell();
      if (delayMs <= 0) {
        prewarmRoom(roomKey);
        return;
      }
      dwellTimer.current = setTimeout(() => prewarmRoom(roomKey), delayMs);
    },
    cancel: cancelDwell,
  };

  const hold = pttHoldProps(ptt);
  const keyProps = faceKeyHandlers(hold, {
    begin: () => {
      downAt.current = performance.now();
      // A press that cannot open a mic must never be a dead press. `press`
      // itself is already a no-op here — this is only the part that SAYS so.
      if (!blocked) return;
      setRefused(true);
      if (refusalTimer.current) clearTimeout(refusalTimer.current);
      refusalTimer.current = setTimeout(() => setRefused(false), REFUSAL_MS);
    },
    // A release ON the face is the gesture that can be a click. A pointer that
    // wandered off it, or a cancelled gesture, ends the hold without opening
    // anything: letting go somewhere else is how people abort.
    finish: () => {
      if (isWallTap(downAt.current, performance.now())) onTap();
    },
  }, warm);

  return { state, sending, holding: ptt.holding, talking, refused, blocked, roomKey, txRef, rxRef, keyProps };
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
