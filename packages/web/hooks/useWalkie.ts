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
import { useShortcutAction, useShortcutContext } from "../shortcuts";
import { useEventListener } from "./useEventListener";
import { useMountEffect } from "./useMountEffect";
import { usePagePresence } from "./usePagePresence";

export function useWalkieStatus(): WalkieStatus {
  return useSyncExternalStore(subscribeWalkie, getWalkieStatus, getWalkieStatus);
}

// One subscription to the engine, for the two facts no single component owns.
//
// THE CONVERSATION THE WALKIE LAST USED. `lingerUntil` says a room is being held
// open in case somebody answers, but not WHICH room, and the engine does not
// clear it when the person walks into some other call. Without this, joining a
// huddle inside that half minute would put the walkie strip over a real call: no
// mic, no hang-up, somebody else's name on it. The strip also has to keep
// offering the answer through the linger, which means still knowing whose DM to
// send it to.
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
subscribeWalkie(() => {
  const s = getWalkieStatus();
  const live = s.sending ?? s.incoming;
  if (live) lastTarget = { roomKey: live.roomKey, channelId: live.channelId };

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

/** Why the key cannot be held right now, in the words the tooltip says, or null
 *  when it can. */
export function walkieBlockedReason(roomKey: string | undefined): string | null {
  if (!roomKey) return "There is nobody to talk to here yet";
  const blocked = walkieBlockedFor(roomKey);
  if (blocked === "another-call") return "You are in another call";
  if (blocked === "not-ready") return "Calls are not ready yet";
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
 */
export function walkieOwnsCall(
  status: WalkieStatus,
  call: { roomKey: string | null; phase: string; muted: boolean },
  lingerRoom: string | null = lastTarget?.roomKey ?? null,
): boolean {
  if (status.sending) return status.sending.roomKey === call.roomKey;
  if (status.incoming) return status.incoming.roomKey === call.roomKey;
  // Lingering: THIS room is being held open in case anybody answers. An open
  // mic means somebody did, and a room people are talking in is a huddle rather
  // than a burst, so the ordinary dock takes it back.
  return (
    !!status.lingerUntil && !!call.roomKey && call.roomKey === lingerRoom && call.muted
  );
}
