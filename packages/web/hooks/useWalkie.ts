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
import {
  useCallback,
  useRef,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from "react";
import { toast } from "sonner";
import {
  endBurst,
  getWalkieLevel,
  getWalkieStatus,
  startBurst,
  subscribeWalkie,
  subscribeWalkieLevel,
  walkieBlockedFor,
  warmMic,
  type WalkieStatus,
} from "../lib/calls/walkie";
import { useInboxStore, useTrackedStore } from "../store/inboxStore";
import { teamHasFeature } from "../lib/teamFeatures";
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

/** Calls are available at all: the deployment has LiveKit and the ACTIVE team
 *  has the feature on. Read from the store rather than the hook so the two
 *  reason functions below stay callable outside React, which is how the live
 *  bubble and every push-to-talk surface share one answer. */
export function callsAvailableNow(): boolean {
  const s = useInboxStore.getState() as any;
  return !!s.callConfig?.enabled && teamHasFeature(s.teams, s.clientState?.ui?.active_team_id, "calls");
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
  if (!roomKey) return "This burst has no room to join";
  // Calls off for this team, or the deployment has no LiveKit behind it. The
  // engine's own "not ready" only knows whether it has a Convex client, so
  // without this the gesture stayed offered and failed at the far end: the
  // join throws, the call plane lands in `error` rather than `idle`, and the
  // ordinary call dock opens a floating window on a failure — from a mic
  // button in a chat composer.
  if (!callsAvailableNow()) return "Calls are not on for this team";
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
  /** The mic is actually open in the room. False through setup — acquiring the
   *  mic, joining and unmuting — which is a real gap, not a formality: 1.0s
   *  into a warm room and 12.7s into a cold one, measured. A surface that says
   *  "talking" before this is telling the person their words are reaching
   *  somebody when they are reaching nobody. */
  live: boolean;
  /** The mic WAS open and the room went away under it. The words are still
   *  being recorded and the burst will still land as a message — that half is
   *  fine — but nobody is hearing them right now. */
  dropped: boolean;
  /** THE MICROPHONE IS OPEN and the recorder, the meter and the recognizer are
   *  running on it: every word from here is kept, whatever the room is doing.
   *  True about a tenth of a second after the press, because nothing but
   *  getUserMedia precedes it — so this, not `live`, is what the key lights on.
   *  `live` above answers the later and different question of whether anybody
   *  is hearing it as it is said. */
  capturing: boolean;
  /** Null when the gesture is available. */
  reason: string | null;
  press: () => void;
  release: () => void;
};

/**
 * What the key is doing, out of the three booleans the gesture reports — four
 * states, four different claims about where the words are going.
 *
 * `dropped` first, because it is the only one that is bad news and it is true
 * at the same time as `capturing`. Then the microphone being open, which is
 * what the key lights on: the words are being kept from that instant, whatever
 * the room is doing. `opening` is only the gap before it.
 */
export function walkieKeyState(
  ptt: Pick<PushToTalk, "holding" | "capturing" | "dropped">,
): "idle" | "opening" | "live" | "dropped" {
  if (ptt.dropped) return "dropped";
  if (ptt.capturing) return "live";
  return ptt.holding ? "opening" : "idle";
}

/**
 * What a screen reader is told the key IS, right now.
 *
 * Beside `walkieKeyState` because the two answer the same question for two
 * different senses, and they must never disagree — the eye reads the ring and
 * the fill, and this is the whole of what a reader gets instead.
 *
 * The state is IN the name rather than in `aria-pressed`, which is a toggle's
 * word: it announces "not pressed" and promises a latch, when what is here is
 * a key you keep down.
 *
 * When idle it names WHICH key this is. A roster of twenty teammates draws
 * twenty of these, and every one of them used to reach a screen reader as the
 * identical "Hold to talk" — the teammate's name lived in `title`, where only
 * a pointer could find it. A visible label still wins when there is one, so
 * what is heard always contains what is seen.
 */
/**
 * The burst's room went away under an open microphone: still recording, heard
 * by nobody.
 *
 * The engine cannot answer this. Nothing in a burst is tied to the room's
 * connection state — a LiveKit disconnect mid-hold (the SFU kicking a
 * duplicate identity, a network drop it gave up on) leaves `sending` exactly
 * as it was — and `sending.heardLive` only ever says the track reached the
 * room ONCE, never that somebody is hearing it now. So the answer is the
 * engine's burst plus the call plane's seat, and it lives here, once, because
 * the key and the strip must never disagree about it.
 */
export function walkieBurstDropped(
  sending: { openAt: number | null; roomKey: string } | null,
  call: { roomKey: string | null; phase: string },
): boolean {
  if (!sending || sending.openAt === null) return false;
  const seated =
    call.roomKey === sending.roomKey &&
    (call.phase === "connected" || call.phase === "connecting");
  return !seated;
}

export function walkieKeyName(
  state: ReturnType<typeof walkieKeyState>,
  opts: { reason?: string | null; live?: boolean; label?: string; title?: string },
): string {
  if (opts.reason) return opts.reason;
  if (state === "dropped") return "Nobody is hearing this — still recording";
  if (state === "opening") return "Opening the mic — do not talk yet";
  if (state === "live") {
    return opts.live
      ? "Live — they hear you now, release to send"
      : "Recording — they get it when you let go";
  }
  return opts.label ?? opts.title ?? "Hold to talk";
}

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
    // Whether calls are available at all is part of the same answer, and an
    // admin turning the feature off must reach the button without waiting for
    // an unrelated burst to refresh it.
    (st: any) => !!st.callConfig?.enabled,
    (st: any) => st.clientState?.ui?.active_team_id ?? "",
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

  const holding = !!status.sending && status.sending.roomKey === roomKey;
  // Whether the mic is live is TWO questions, and the second one only the call
  // plane can answer: is this client still in the room? A LiveKit disconnect
  // mid-burst (the SFU kicking a duplicate identity, a network drop it gave up
  // on) leaves the engine's `sending` exactly as it was — nothing in the burst
  // is tied to the room's connection state — while the call plane correctly
  // goes idle. Verified in the running app: after killing the room mid-hold the
  // call phase was idle, `sending` was still set, and the button still read
  // "Talking — release to send" with the person's voice reaching nobody.
  //
  // The recording keeps running locally and the burst still lands as a message,
  // so nothing is lost. What was wrong was only the claim, in the present
  // tense, that somebody was hearing it.
  // Read rather than subscribed: the useTrackedStore above already subscribes
  // to exactly these fields, so this render is the one triggered by them
  // changing.
  const call = useInboxStore.getState().call;
  const opened = holding && !!status.sending?.openAt;
  const dropped = opened && walkieBurstDropped(status.sending, call);
  return {
    holding,
    live: opened && !dropped,
    dropped,
    capturing: holding && !!status.sending?.live,
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

/**
 * How loudly somebody is talking, written straight onto an element as the CSS
 * custom property `--level` (0 to 1), for a meter to draw itself from.
 *
 * NOT React state, and that is the whole point. The level moves every animation
 * frame, so a `useState` behind it would re-render this component sixty times a
 * second and every component under it with it — the exact jank the engine kept
 * the level off `WalkieStatus` to avoid. A custom property crosses the same
 * distance with no render at all: the subscription writes one string, and CSS
 * redraws the ring.
 *
 * It is a REF CALLBACK rather than a ref plus an effect, which is the smaller
 * shape for the same job: React runs it when the element arrives and runs the
 * returned cleanup when it leaves or when `active`/`identity` change, so the
 * subscription's life is exactly the element's.
 *
 * `identity` picks whose voice: absent is this client's own microphone while
 * the key is down, a LiveKit participant identity is the teammate being heard.
 */
export function useWalkieLevelVar<T extends HTMLElement>(active: boolean, identity?: string) {
  return useCallback(
    (el: T | null) => {
      if (!el) return;
      el.style.setProperty("--level", "0");
      if (!active) return;
      // The engine already debounces: it wakes subscribers only when a level
      // moved by more than a couple of percent, and stops its loop when nobody
      // is talking. So this writes as often as the number really changes.
      const write = () => el.style.setProperty("--level", getWalkieLevel(identity).toFixed(3));
      write();
      const off = subscribeWalkieLevel(write);
      return () => {
        off();
        el.style.setProperty("--level", "0");
      };
    },
    [active, identity],
  );
}

/**
 * The gesture as DOM props, spread onto whatever element carries it.
 *
 * A HOLD IS A HOLD ON THE KEYBOARD TOO. This used to be pointer events alone,
 * and `onClick` cancelled itself — so Enter and Space did nothing on any of the
 * four surfaces. The chord is only armed while the matching DM is the open,
 * present tab, which left the hover card's mic and the receiver strip's "Hold
 * to reply" with no keyboard path at all, on any page. Space and Enter are how
 * a keyboard presses a button, so they press this one: down opens the mic, up
 * closes it, exactly like a thumb.
 *
 * The click is still cancelled. A button fires one synthetically on Space, and
 * a click that keyed the mic would key it with nothing left to release it.
 * Auto-repeat needs no guard beyond the one `press` already has, but `e.repeat`
 * says the intent plainly.
 */
const HOLD_KEYS = new Set([" ", "Spacebar", "Enter"]);

/** Whether a key event is the keyboard's version of a thumb on the key.
 *  Exported so a surface that WRAPS these handlers — the people wall, whose
 *  face is both a hold and a click — asks the same question rather than
 *  keeping its own copy of the set and drifting from it. */
export function isWalkieHoldKey(key: string): boolean {
  return HOLD_KEYS.has(key);
}

export function pttHoldProps(ptt: PushToTalk) {
  return {
    // A pointer arriving on a push-to-talk key means "might talk". Opening the
    // microphone now takes the device acquisition out of the press, so the first
    // burst of a session is as instant as the second. It CANNOT prompt — the
    // engine only proceeds where permission is already granted — so nobody is
    // ever asked for a microphone by moving a mouse.
    //
    // Deliberately the KEY and not the conversation. Warming whenever a DM is
    // open would turn the browser's recording indicator on for reading a
    // message, which is a real thing to do to somebody for a burst they may
    // never speak. Pointing at the mic is the first gesture that says otherwise.
    // A keyboard-only hold therefore pays for getUserMedia at press time — tens
    // of milliseconds on an already-granted device, against the seconds the room
    // join used to cost.
    onPointerEnter: () => void warmMic(),
    // The keyboard's version of a pointer arriving. Tabbing onto a
    // push-to-talk key is as deliberate as pointing at one, and it was the
    // gap: the pointer path paid for the device before the press and the
    // keyboard path paid for it inside the press, so a keyboard-only hold
    // was reliably the slowest way to start a burst. Same engine call, same
    // guarantee — `warmMic` returns unless permission is already granted, so
    // no Tab key can raise a microphone prompt.
    onFocus: () => void warmMic(),
    onPointerDown: (e: PointerEvent) => {
      // Left button only, and never the gesture that opens a context menu.
      if (e.button !== 0) return;
      e.preventDefault();
      ptt.press();
    },
    onPointerUp: ptt.release,
    onPointerLeave: ptt.release,
    onPointerCancel: ptt.release,
    onKeyDown: (e: ReactKeyboardEvent) => {
      if (!HOLD_KEYS.has(e.key) || e.repeat) return;
      // Space would scroll the page out from under the person mid-sentence.
      e.preventDefault();
      ptt.press();
    },
    onKeyUp: (e: ReactKeyboardEvent) => {
      if (!HOLD_KEYS.has(e.key)) return;
      ptt.release();
    },
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
  opts: { lingerRoom?: string | null; guest?: boolean; upgraded?: boolean } = {},
): boolean {
  const lingerRoom = opts.lingerRoom !== undefined ? opts.lingerRoom : (lastTarget?.roomKey ?? null);
  // SOMEBODY STEPPED IN ON PURPOSE. This outranks every branch below, including
  // a key that is still down: the founder's rule is that a hold stays a strip
  // until the other side explicitly joins, and this is that moment arriving.
  //
  // It replaces the mute, which used to carry this meaning everywhere below —
  // an open microphone meant a person had joined. Hot auto-listen ended that
  // reading: every listener's mic is open now, so a burst played to three
  // people would have read as three conversations and put the full call dock
  // over all three of their screens for a sentence.
  if (opts.upgraded !== undefined ? opts.upgraded : status.joinedLive === call.roomKey) {
    return false;
  }
  // The walkie walked into a call that was already running with this person's
  // mic open. It is a guest there, and a guest does not take the room's controls
  // away from it — not while talking, not while listening, and not through the
  // linger afterwards, which is still happening inside that same huddle.
  if (opts.guest !== undefined ? opts.guest : guest) return false;
  // Being handed back is still being owned. Leaving is asynchronous — the call
  // plane keeps reporting a live seat for a few ticks after the walkie is done
  // with the room — and during those ticks the answer here has to stay yes, or
  // the ordinary dock appears for an instant on a room that is in the middle of
  // disappearing. When it finally does, the phase goes idle and the surface is
  // "none", which is what the person should see.
  if (status.releasing && status.releasing === call.roomKey) return true;
  if (status.sending) return status.sending.roomKey === call.roomKey;
  if (status.incoming) return status.incoming.roomKey === call.roomKey;
  // Lingering: THIS room is being held open in case anybody answers. Nobody
  // has, or the test above would have taken the room back.
  return !!status.lingerUntil && !!call.roomKey && call.roomKey === lingerRoom;
}

/**
 * Whether the full call stage is open, after something happened.
 *
 * The dock holds this as its own state and hands every change through here, so
 * that the two ways it moves are one rule in one place — the person's own
 * gestures (the expand button, the collapse button) set it directly and are not
 * this function's business.
 *
 * THE STAGE BELONGS TO THE CALL THAT WAS EXPANDED, and to no call after it.
 * Nothing used to put it back: the dock is mounted for the life of the page and
 * merely draws nothing when idle, so one expanded huddle left the flag true
 * forever, and the next call — or the next walkie burst — opened full screen by
 * itself, a second or two in, when the room connected. That is the founder's
 * "it kind of switches to the full call unexpectedly", reproduced with two
 * identities and screenshotted (ct-45974, ct-46031).
 *
 * AND NEVER OVER A BURST. Remote video arriving earns the stage in a huddle and
 * does not in three seconds of somebody's voice — and opening it there does
 * lasting damage, because the flag would outlive the burst and take the surface
 * from every later one.
 */
export function nextStageOpen(
  open: boolean,
  ev: { phase: string; walkieOwns?: boolean; notice?: boolean; newRemoteVideo?: boolean },
): boolean {
  if (ev.phase === "idle") return false;
  if (ev.walkieOwns) return open;
  return open || !!ev.notice || !!ev.newRemoteVideo;
}

/**
 * Has anybody ELSE in this room stepped into the burst on purpose?
 *
 * The far side's half of the upgrade. Their gesture stamps their seat
 * (call_members.walkie_joined_at) and the stamp rides the roster both sides
 * already subscribe to, so no new query and no new channel carries it — the
 * dock's own occupancy list is the wire.
 *
 * MY OWN stamp is excluded on purpose. This side already knows what it pressed,
 * synchronously, through the engine's `joinedLive`; reading my own row back
 * would only be a slower way to learn it, and it would make the rule depend on
 * a round trip that the local-first path is there to avoid.
 */
export function otherJoinedLive(
  roster: { user_id?: unknown; walkie_joined_at?: number }[],
  myUserId: string | null | undefined,
): boolean {
  const me = String(myUserId ?? "");
  return roster.some((m) => !!m?.walkie_joined_at && String(m.user_id ?? "") !== me);
}

/** The four things the call dock can be. */
export type DockSurface = "none" | "walkie" | "stage" | "dock";

/**
 * Which surface the dock shows, out of the walkie's state and the call's.
 *
 * Here rather than inline in the component because the answer is a rule about
 * the walkie, not a rendering detail — and because the rule was wrong in a way
 * only a test would have caught. The stage used to be able to outrank the
 * walkie: the branch read `walkieOwnsCall(...) && !expanded`, and `expanded` is
 * the dock's own `useState` that nothing put back when a call ended. So one
 * expanded huddle, at any point in the session, made every later hold of the
 * key open the full call stage over the person's conversation about a second
 * into the burst — the room join is what they saw as "after a few seconds".
 * Reproduced with two identities, screenshotted, ct-46031.
 *
 * WHOEVER OWNS THE ROOM OWNS THE SURFACE, and nothing local overrides it. The
 * order below is the whole rule: a burst that outlived its room, then no call
 * at all, then the walkie, and only then the two shapes of the ordinary dock.
 *
 * THE UPGRADE IS A CHANGE OF OWNER, not a fifth surface. When somebody presses
 * Join live the room stops being a burst for everyone in it, `walkieOwnsCall`
 * answers false from that moment, and the ordinary dock takes the room the way
 * it takes any other — which is why there is no branch for it here. Unmuting
 * is NOT that signal any more and must never be read as one: auto-listen opens
 * every listener's microphone, so the mute says who can be heard and nothing
 * at all about whether a conversation started (ct-46032).
 */
export function callDockSurface(
  status: WalkieStatus,
  call: { roomKey: string | null; phase: string; muted: boolean },
  opts: { expanded: boolean; lingerRoom?: string | null; guest?: boolean; upgraded?: boolean },
): DockSurface {
  // A BURST OUTLIVES THE ROOM IT WAS SPOKEN INTO. When the room falls over
  // under an open microphone the call plane goes idle, but the recorder, the
  // meter and the recognizer are still running and the burst still lands as a
  // message. `walkieOwnsCall` cannot answer here — its sending branch compares
  // the burst's room against the call's, and the call no longer has one.
  if (status.sending && call.phase === "idle") return "walkie";
  if (call.phase === "idle") return "none";
  if (walkieOwnsCall(status, call, opts)) return "walkie";
  return opts.expanded ? "stage" : "dock";
}
