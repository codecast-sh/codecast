// The walkie's React layer, and no components — so the surfaces that DO render
// one stay Fast Refresh boundaries.
//
// The heart of it is the hold-to-talk gesture, which every surface shares.
//
// Three do — the DM composer's mic, a teammate's hover card, the receiver
// banner's reply — plus the keyboard, and all four are the same hold: press,
// talk, release. So the gesture lives here once and each surface supplies only
// what it looks like and which room it opens.
//
// RELEASING IS THE HARD PART. A push-to-talk button that misses its release
// leaves a mic open in someone else's room, which is the worst failure this
// feature has. So every way a press can end is a release: the pointer coming
// up, the pointer leaving the button, the browser cancelling the gesture, the
// key coming up, the window losing focus with a finger still down, and the
// surface unmounting under the hand. The engine's endBurst is idempotent, so a
// release arriving twice costs nothing and one arriving late still lands the
// burst.
import { useCallback, useRef, useSyncExternalStore, type MouseEvent, type PointerEvent } from "react";
import { toast } from "sonner";
import {
  endBurst,
  getWalkieStatus,
  startBurst,
  subscribeWalkie,
  walkieBlockedFor,
  type WalkieStatus,
} from "../lib/calls/walkie";
import { useInboxStore, useTrackedStore } from "../store/inboxStore";
import { useShortcutAction, useShortcutContext } from "../shortcuts";
import { useEventListener } from "./useEventListener";
import { useMountEffect } from "./useMountEffect";
import { usePagePresence } from "./usePagePresence";

export function useWalkieStatus(): WalkieStatus {
  return useSyncExternalStore(subscribeWalkie, getWalkieStatus, getWalkieStatus);
}

// One subscription to the engine, for the three facts no single component owns.
//
// THE CONVERSATION THE WALKIE LAST USED. `lingerUntil` says a room is being held
// open in case somebody answers, but not WHICH room, and the engine does not
// clear it when the person walks into some other call. Without this, joining a
// huddle inside that half minute would put the walkie strip over a real call: no
// mic, no hang-up, somebody else's name on it. The strip also has to keep
// offering the answer through the linger, which means still knowing whose DM to
// send it to.
//
// WHETHER THE WALKIE IS A GUEST. A burst joins a room, but the room may already
// have been a live huddle with this person's mic open in it — the dm: room of a
// 1:1 call is the very room a burst to that person is spoken into. The walkie
// must not take the dock away from a call in progress, so it records, at the
// moment a burst begins, whether it opened that mic or merely walked in. The
// engine publishes `sending` synchronously BEFORE it unmutes, so the call state
// read here is still the pre-burst world, which is exactly the question.
//
// A BURST THAT FAILED TO SEND, below.
//
// Both live at module scope rather than in a component: they are plain facts
// about the engine, and a DM has several push-to-talk surfaces mounted at once,
// so anything per-surface would have to collapse itself back into the single
// event it always was.
export type WalkieTarget = { roomKey: string; channelId: string };

let lastTarget: WalkieTarget | null = null;
let reportedError: string | null = null;
/** The burst currently being tracked, so a guest ruling is made once per burst
 *  rather than re-read after the engine has changed the world. */
let engagedBurst: string | null = null;
let guest = false;

subscribeWalkie(() => {
  const s = getWalkieStatus();
  const live = s.sending ?? s.incoming;
  const burstKey = s.sending ? s.sending.clientId : (s.incoming?.messageId ?? null);
  if (live) {
    lastTarget = { roomKey: live.roomKey, channelId: live.channelId };
    if (burstKey !== engagedBurst) {
      engagedBurst = burstKey;
      const call = useInboxStore.getState().call;
      guest =
        call.roomKey === live.roomKey &&
        !call.muted &&
        (call.phase === "connected" || call.phase === "connecting");
    }
  } else {
    // The ruling outlives the burst: the linger that follows a guest burst is
    // still happening inside somebody's huddle.
    engagedBurst = null;
  }

  // A burst that did not send has to SAY so. The engine reports the failure and
  // stops there, and both ways it fails are silent lies otherwise: a row that
  // never opened takes its own bubble back, so words spoken out loud vanish off
  // the screen unexplained, and a finalize that failed leaves a bubble sitting
  // there looking sent.
  //
  // A toast rather than something drawn into the mic: by the time a burst fails
  // the hand is off the key and the eye has moved on.
  if (s.error !== reportedError) {
    reportedError = s.error;
    if (s.error) toast.error(s.error);
  }
});

export function lastWalkieTarget(): WalkieTarget | null {
  return lastTarget;
}

/**
 * Why this room cannot be entered right now, or null when it can. A live call
 * somewhere else is the only thing that keeps you out of a room — walking into
 * the one you are already in is a no-op, not an error.
 *
 * This is the question a LIVE BUBBLE asks, where the gesture is to walk in and
 * listen. Push-to-talk asks a stricter one, below.
 */
export function walkieJoinReason(roomKey: string | undefined): string | null {
  if (!roomKey) return "This one cannot be joined";
  const blocked = walkieBlockedFor(roomKey);
  if (blocked === "another-call") return "You are in another call";
  if (blocked === "not-ready") return "Calls are not ready yet";
  return null;
}

/**
 * Why the key cannot be held right now, in the words the tooltip says, or null
 * when it can. Everything that keeps you out of the room, plus one more.
 *
 * The engine answers most of this. The one question it does not ask is about
 * the room you are ALREADY in: it blocks a call in some other room, and lets
 * this one through so that a burst can join, or reply inside, the room it
 * belongs to. That is right for a muted room — being in one is how you hear a
 * teammate, and hold-to-reply is the whole point of the receiving side. It is
 * wrong for a room where your own mic is already open, because there push to
 * talk has nothing left to do: you are talking. Holding it would take the
 * call's controls away for the length of a sentence and then mute the call on
 * release, which is the engine tidying up after a burst doing real damage to a
 * conversation.
 */
export function walkieBlockedReason(roomKey: string | undefined): string | null {
  if (!roomKey) return "There is nobody to talk to here yet";
  const engine = walkieJoinReason(roomKey);
  if (engine) return engine;
  const status = getWalkieStatus();
  // Not when the open mic is the walkie's own doing — that is a burst in
  // flight, and the surface holding it must not disable itself mid-hold.
  if (status.sending?.roomKey === roomKey) return null;
  const call = useInboxStore.getState().call;
  if (
    call.roomKey === roomKey &&
    !call.muted &&
    (call.phase === "connected" || call.phase === "connecting")
  ) {
    return "Your mic is already open here — just talk";
  }
  return null;
}

export type PushToTalk = {
  /** This surface's room is the one being talked into right now. */
  holding: boolean;
  /** Null when the gesture is available. */
  reason: string | null;
  press: () => void;
  release: () => void;
};

/**
 * The gesture, without any of the chrome.
 *
 * `resolveChannelId` is called at PRESS time, never at render, because the
 * hover card's answer is "open the DM with this person, making it if it does
 * not exist" — a side effect that must happen when somebody actually keys the
 * mic, not every time a card is pointed at.
 */
export function usePushToTalk(
  roomKey: string | undefined,
  resolveChannelId: () => string | null,
): PushToTalk {
  const status = useWalkieStatus();
  // The engine wakes this hook when the WALKIE moves, but the answer below also
  // depends on where the call plane is — and a mute the person toggled in the
  // dock moves that without moving the walkie. A signature of the three scalars
  // the answer reads, so the button's disabled state stays honest rather than
  // waiting for the next unrelated burst to refresh it.
  useTrackedStore([
    (st: any) => st.call?.roomKey ?? "",
    (st: any) => st.call?.phase ?? "idle",
    (st: any) => st.call?.muted !== false,
  ]);
  const held = useRef(false);

  const release = useCallback(() => {
    if (!held.current) return;
    held.current = false;
    void endBurst();
  }, []);

  const press = useCallback(() => {
    if (held.current || walkieBlockedReason(roomKey)) return;
    const channelId = resolveChannelId();
    if (!channelId || !roomKey) return;
    held.current = true;
    void startBurst(channelId, roomKey);
  }, [roomKey, resolveChannelId]);

  // A hold that survives the window losing focus is a mic left open in someone
  // else's room: the pointerup or keyup that was going to end it happens
  // somewhere else entirely and is never delivered here.
  useEventListener("blur", release);
  // And the last resort: the surface going away mid-hold — a channel switch, a
  // hover card closing under the pointer — must not leave the mic open either.
  useMountEffect(() => () => release());

  return {
    holding: !!status.sending && status.sending.roomKey === roomKey,
    reason: walkieBlockedReason(roomKey),
    press,
    release,
  };
}

/**
 * The keyboard half, mounted by whatever surface has a DM open.
 *
 * Split across two mechanisms on purpose. The PRESS is a registered shortcut,
 * so the binding is listed in the help panel, is guarded against modals and
 * keyboard owners like every other binding, and is rebindable when bindings
 * become rebindable. The RELEASE is a plain keyup, because the dispatcher has
 * no keyup channel at all — its handlers take no event, so a hold cannot be
 * expressed as a binding. Ctrl+Tab's switcher splits the same way for the same
 * reason.
 *
 * Auto-repeat needs no guard here: a held key re-dispatches the press several
 * times a second, and `press` is already a no-op while this surface holds.
 *
 * ON SCREEN, NOT MERELY MOUNTED. The tab shell keeps a chat page mounted behind
 * whatever tab is in front, and the shortcut dispatcher's contexts are one
 * global set with no idea which pane a reader is looking at — so a binding
 * armed by a hidden page is armed for the whole app. For a shortcut that opens
 * a live mic into a DM, that is the feature's worst failure reached from the
 * other side: not a hold that fails to release, but a burst the person never
 * meant to start, into a conversation they are not even looking at. Presence is
 * read HERE rather than taken from the caller, so no surface can arm the key by
 * forgetting to ask. The chat page learned this same lesson for its toasts.
 */
export function useHoldToTalk(
  roomKey: string | undefined,
  resolveChannelId: () => string | null,
  enabled: boolean,
): PushToTalk {
  const ptt = usePushToTalk(roomKey, resolveChannelId);
  const present = usePagePresence();
  const armed = enabled && present;
  useShortcutContext("chat.dm", armed);
  useShortcutAction(
    "chat.pushToTalk",
    useCallback(() => {
      if (!armed) return false;
      ptt.press();
    }, [armed, ptt]),
  );
  // Any part of the chord coming up ends the hold. Watching only the space bar
  // would keep the mic open when the hand lifts off Ctrl first, which is how
  // people actually let go of a chord.
  //
  // Never gated on `armed`, unlike the press. Arming is a question about whether
  // to START; releasing has to work whatever the world did since — a tab that
  // went to the background mid-hold takes the arming away, and a release that
  // went with it would leave exactly the open mic all of this exists to prevent.
  useEventListener("keyup", (e: KeyboardEvent) => {
    if (e.key === " " || e.key === "Control" || e.key === "Shift" || e.key === "Meta" || e.key === "Alt") {
      ptt.release();
    }
  });
  return ptt;
}

/** The pointer half of the gesture, spread onto whatever element carries it. */
export function pttPointerProps(ptt: PushToTalk) {
  return {
    onPointerDown: (e: PointerEvent) => {
      // Left button only, and never the gesture that opens a context menu.
      if (e.button !== 0) return;
      e.preventDefault();
      ptt.press();
    },
    onPointerUp: ptt.release,
    onPointerLeave: ptt.release,
    onPointerCancel: ptt.release,
    // A hold is not a click, and a mic button that also fired on Enter would
    // key the mic with no way to release it.
    onClick: (e: MouseEvent) => e.preventDefault(),
  };
}

/**
 * Whether the walkie, rather than an ordinary huddle, owns the room the call
 * plane is in. It decides which of the two docks is on screen, and the two must
 * never both be: a burst joins a room the same way a huddle does, so without
 * this the call dock's floating window would open for every sentence anybody
 * says.
 *
 * Owning the dock means REPLACING the call's own controls — no hang-up, no
 * mute, no camera, no lock — so every branch below has to be sure the room is
 * a burst and not a conversation. Matching room keys is not enough: a 1:1 call
 * lives in the same dm: room a burst to that person is spoken into, so the keys
 * match exactly when the answer must be no.
 */
export function walkieOwnsCall(
  status: WalkieStatus,
  call: { roomKey: string | null; phase: string; muted: boolean },
  opts: { lingerRoom?: string | null; guest?: boolean } = {},
): boolean {
  const lingerRoom = opts.lingerRoom !== undefined ? opts.lingerRoom : (lastTarget?.roomKey ?? null);
  // The walkie walked into a call that was already running with this person's
  // mic open. It is a guest there, and a guest does not take the room's controls
  // away from it — not while talking, not while listening, and not through the
  // linger afterwards, which is still happening inside that same huddle.
  if (opts.guest !== undefined ? opts.guest : guest) return false;
  if (status.sending) return status.sending.roomKey === call.roomKey;
  if (status.incoming) return status.incoming.roomKey === call.roomKey && call.muted;
  // Lingering: THIS room is being held open in case anybody answers. An open
  // mic means somebody did, and a room people are talking in is a huddle rather
  // than a burst, so the ordinary dock takes it back.
  return (
    !!status.lingerUntil && !!call.roomKey && call.roomKey === lingerRoom && call.muted
  );
}
