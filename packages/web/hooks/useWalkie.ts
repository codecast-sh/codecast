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
  walkieHoldsRoom,
  warmMic,
  type WalkieStatus,
} from "../lib/calls/walkie";
import { useInboxStore, useTrackedStore } from "../store/inboxStore";
import { teamHasFeature } from "../lib/teamFeatures";
import { PRESENCE_BUCKET_MS } from "@codecast/convex/convex/presenceState";
import { describeRoom } from "../lib/calls/roomLabels";
import { memberDisplayName } from "../lib/liveEntities";
import { useShortcutAction, useShortcutContext } from "../shortcuts";
import { useEventListener } from "./useEventListener";
import { useMountEffect } from "./useMountEffect";
import { useNowWhen } from "./useCoarseNow";
import { usePagePresence } from "./usePagePresence";

export function useWalkieStatus(): WalkieStatus {
  return useSyncExternalStore(subscribeWalkie, getWalkieStatus, getWalkieStatus);
}

// One subscription to the engine, for the two facts no single component owns.
//
// THE CONVERSATION THE WALKIE LAST USED. The engine names the room it is in;
// this names the DM behind it, so the strip can keep offering the answer after
// the burst that opened it has landed.
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
 * THE FACTS ONE PUSH-TO-TALK KEY DRAWS, for one room, as a string.
 *
 * Pure and exported so a test can prove both halves of the promise: it moves
 * when this key's own answer moves, and it holds still through everything
 * else. A key is only ever four things — my key is down in THIS room, the
 * microphone is open, the words are reaching the room, and whether the gesture
 * is available at all — and nothing else in the engine changes what it says.
 */
export function walkieKeySig(s: WalkieStatus, roomKey: string | undefined): string {
  const mine = roomKey && s.sending?.roomKey === roomKey ? s.sending : null;
  return [
    mine ? "1" : "0",
    mine?.live ? "1" : "0",
    mine && mine.openAt !== null ? "1" : "0",
    s.unavailable ?? "",
  ].join("|");
}

/** Wake this component when THIS key's answer changes, and at no other time.
 *  A string snapshot, so identity is value: the cache every other signature
 *  hook needs is what `String` already gives us.
 *
 *  Exported for its own render test — it IS the subscription, so mounting it is
 *  the honest way to count what a bar of faces costs. */
export function useWalkieKeySig(roomKey: string | undefined): string {
  const read = useCallback(() => walkieKeySig(getWalkieStatus(), roomKey), [roomKey]);
  return useSyncExternalStore(subscribeWalkie, read, read);
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
  // ONE ROOM'S WORTH OF THE ENGINE, and never the whole snapshot.
  //
  // The avatar bar mounts six of these for the life of the app, and the wall
  // mounts one per teammate. `useWalkieStatus` wakes on any field of the
  // status moving — a partial transcript arriving, the recognizer going down,
  // an error clearing, a room changing what it is — so one person talking
  // re-rendered every face on screen several times a second, for a key whose
  // answer had not moved at all.
  //
  // The signature below is exactly what this hook branches on for THIS room,
  // as a string, so `useSyncExternalStore` compares it by value and a face
  // whose room nobody is talking into holds still through every push.
  useWalkieKeySig(roomKey);
  const status = getWalkieStatus();
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
 * THE DOOR, for the two toggles that let a person set it.
 *
 * One hook rather than two copies of `walkie_pref !== "off"`, because there is
 * now a second way the door can be shut and a toggle that reads only the pref
 * says "open" through the whole hour a snooze is running. A control that
 * contradicts the thing it controls is worse than no control.
 *
 * Turning it back ON lifts the snooze with it. Otherwise the strip's Snooze
 * button would be a shutter with no handle: a person who changed their mind
 * inside the hour could flip the toggle, watch it say open, and still hear
 * nothing.
 */
export function useWalkieDoor(): {
  open: boolean;
  /** Shut by the hour rather than by the pref — worth saying out loud, because
   *  it is temporary and the pref is not. */
  snoozed: boolean;
  setOpen: (open: boolean) => void;
} {
  const pref = useInboxStore((s: any) => s.currentUser?.walkie_pref ?? "team");
  const snoozedUntil = Number(useInboxStore((s: any) => s.currentUser?.walkie_snoozed_until ?? 0));
  const now = useNowWhen((n) => (snoozedUntil > n ? "shut" : "open"), 30_000);
  const snoozed = snoozedUntil > now;
  const setOpen = useCallback(
    (open: boolean) => {
      const st = useInboxStore.getState() as any;
      st.setWalkiePref(open ? "team" : "off");
      if (open && snoozedUntil > Date.now()) st.snoozeWalkie(0);
    },
    [snoozedUntil],
  );
  return { open: pref !== "off" && !snoozed, snoozed, setOpen };
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
 * synchronously, through the engine's live room; reading my own row back would
 * only be a slower way to learn it, and it would make the rule depend on a
 * round trip that the local-first path is there to avoid.
 *
 * AND SO IS A STAMP THAT PREDATES THIS SEAT. `walkie_joined_at` is written when
 * somebody joins and it outlives a browser that dies without leaving, so a room
 * whose last occupant crashed mid-call keeps its stamp for good. Read without
 * `since`, the next burst into that room would be a call from its first tick:
 * the sender's mic never closes on release, a join is announced that nobody
 * made, and the strip hands itself to the call dock over a burst. `since` is
 * when THIS client entered the room, so anything older is a leftover.
 */
export function otherJoinedLive(
  roster: { user_id?: unknown; walkie_joined_at?: number }[],
  myUserId: string | null | undefined,
  since = 0,
): boolean {
  const me = String(myUserId ?? "");
  // THE STAMP ARRIVES BUCKETED, and `since` is a raw local clock. The server
  // floors every roster timestamp to the minute (calls.projectMember through
  // bucketTs) so a room's occupancy pushes byte-identical results while people
  // mute and unmute in it. So a join made forty seconds after this client sat
  // down reports as the top of that minute — EARLIER than `since` — and
  // comparing the two directly threw away every genuinely fresh join for up to
  // a minute, which is the entire life of a burst. Measured with two browsers:
  // the sender never saw the join, never became a call, and was muted on
  // release, which is the whole of A1 silently undone.
  //
  // So the comparison happens in the wire's own units. That caps this rule's
  // resolution at a minute, which is all the stamp can carry: a leftover from
  // the same minute this client walked in still counts as news. The cases it
  // exists for — a browser that died an hour ago, a room somebody left
  // yesterday — are minutes to days old and still rejected.
  const floor = since > 0 ? Math.floor(since / PRESENCE_BUCKET_MS) * PRESENCE_BUCKET_MS : 0;
  return roster.some(
    (m) =>
      !!m?.walkie_joined_at &&
      Number(m.walkie_joined_at) >= floor &&
      String(m.user_id ?? "") !== me,
  );
}

/**
 * WHAT THE SENDER IS TOLD ABOUT THE PERSON THEY ARE TALKING TO.
 *
 * The strip used to say "Live to Jordan" the moment this client's own track
 * reached the SFU, which is a fact about MY seat and says nothing whatever
 * about Jordan's. It read as "Jordan is hearing this" and was false every time
 * Jordan was away from the machine, had the door shut, or was busy — the exact
 * cases the walkie exists to survive, because the burst still lands as a
 * message in the DM either way.
 *
 * So the claim is read off the ROOM instead: the live roster both sides already
 * subscribe to (calls.getRoomOccupancy, the same list the occupancy chip and
 * the upgrade watcher use). A seat in the room is somebody with the audio
 * playing; no seat is somebody who will read it instead.
 *
 * NEVER OFF MY OWN SEAT. That is the whole point, so when neither identity is
 * resolved there is no way to tell my row from theirs and the answer is the
 * cautious one — the message still arrives, and saying so is never wrong.
 *
 * `heardLive` is untouched and still means what it meant: my track reached the
 * room. It is the internal fact the engine needs; it is not a sentence about
 * another person.
 */
export type SenderHearing = { state: "hears" | "away" | "busy"; text: string };

export function senderHearing(
  roster: { user_id?: unknown }[],
  me: string | null | undefined,
  other: {
    /** Their user id, when the room names them (a DM does). */
    userId?: string | null;
    name: string;
    /** The manual status, and the walkie's own door — the pref and the snooze
     *  their client reads to decide whether a burst plays out loud. Shut, the
     *  burst is a message rather than a voice, and the sender should hear that
     *  from the strip rather than from the silence. */
    status?: string | null;
    pref?: string | null;
    snoozed?: boolean;
  },
): SenderHearing {
  const meId = String(me ?? "");
  const otherId = other.userId ? String(other.userId) : "";
  const seated =
    !!(otherId || meId) &&
    roster.some((m) => {
      const id = String(m?.user_id ?? "");
      if (!id) return false;
      return otherId ? id === otherId : id !== meId;
    });
  if (seated) return { state: "hears", text: `${other.name} hears you` };
  // Busy and away are the same outcome — a message instead of a voice — and
  // two different sentences, because one of them is a person who chose it and
  // the other is a person who is not there.
  const busy = other.status === "busy" || other.pref === "off" || !!other.snoozed;
  return busy
    ? { state: "busy", text: `${other.name} is busy — they get the message` }
    : { state: "away", text: `${other.name} is away — they get the message` };
}

/**
 * The same answer, derived from the store for a room.
 *
 * One derivation with two readers, and that is the point rather than a
 * convenience: the strip renders `.text` and the away tick fires on `.state`
 * (hooks/useWalkieSync). Two copies of this lookup would eventually disagree,
 * and the shape of that bug is a sentence saying one thing while a sound says
 * the other.
 *
 * `now` is passed in because the snooze runs out on a clock: a surface reads
 * it off `useNowWhen`, a callback off `Date.now()`, and neither wants a timer
 * hidden in here.
 */
export function senderHearingFrom(
  state: any,
  roomKey: string,
  now: number,
): SenderHearing & { otherId: string } {
  const { label, otherIds } = describeRoom(roomKey, state);
  const otherId = otherIds?.[0] ? String(otherIds[0]) : "";
  const member = otherId
    ? (state.teamMembers ?? []).find((m: any) => String(m?._id) === otherId)
    : null;
  const out = senderHearing(
    (state.callOccupancy?.[roomKey] as { user_id?: unknown }[]) ?? [],
    state.currentUser?._id,
    {
      userId: otherId,
      name: memberDisplayName(member, label),
      status: member?.status,
      pref: member?.walkie_pref,
      snoozed: Number(member?.walkie_snoozed_until ?? 0) > now,
    },
  );
  return { ...out, otherId };
}

/**
 * WHAT THE STRIP IS SAYING, as facts and one sentence.
 *
 * Every claim on this surface is about somebody's microphone, and every one of
 * them can be false in a way the person only discovers from a silence. So the
 * decisions live here, once, beside the two other rules that read the same
 * world (`senderHearingFrom`, `callDockSurface`) — the component draws them and
 * decides nothing.
 *
 * `tx` and `rx` are separate booleans rather than one tone because they are
 * separate facts and both can be true: two people pressing at once is one room
 * with a voice going each way, and the face carries a warm ring and a cool one
 * at the same time.
 */
export type WalkieStrip = {
  headline: string;
  /** This client is talking. */
  tx: boolean;
  /** A teammate's burst is playing here. */
  rx: boolean;
  /** The microphone is open and this client never opened it — the hot listen,
   *  the one thing on this surface nobody may meet by accident. */
  hotMic: boolean;
  /** There is no microphone to open: refused, blocked, or absent. This seat
   *  hears the room and publishes nothing, and saying so is the difference
   *  between a walkie that looks broken and one that is honest. */
  micDenied: boolean;
  /** The room went away under an open microphone: still recording, heard by
   *  nobody. */
  dropped: boolean;
  /** The recognizer is down, so the words come after the recording rather than
   *  during it. Not a failed burst. */
  quiet: boolean;
};

export function walkieStripState(
  status: WalkieStatus,
  state: {
    call: { roomKey: string | null; phase: string; muted: boolean; micDenied?: boolean };
    [key: string]: any;
  },
  ctx: { name: string; now: number },
): WalkieStrip {
  const { sending, incoming } = status;
  const call = state.call;
  const name = ctx.name;
  const micDenied = !!call.micDenied;
  const dropped = walkieBurstDropped(sending, call);
  const tx = !!sending;
  const rx = !!incoming;
  // MY MICROPHONE IS OPEN AND I DID NOT OPEN IT. Not while my own key is down —
  // a mic I am holding open is not a surprise — and not once I have muted,
  // where the line would be a lie. A refused microphone sets `muted`, so a seat
  // with no device never claims to be heard.
  const hotMic = !tx && !call.muted && call.phase === "connected";
  return {
    headline: stripHeadline({ status, state, name, now: ctx.now, dropped, micDenied }),
    tx,
    rx,
    hotMic,
    micDenied,
    dropped,
    quiet: tx && status.asr === "unavailable",
  };
}

/**
 * The one sentence, in the order the claims stop being true.
 *
 * A burst is kept from the moment the microphone opens and heard from the
 * moment the track reaches the room, and those are seconds apart on a cold
 * room, so each half gets its own sentence and neither of them is a failure.
 * It never says "Live to X": that claim was made off this client's own seat and
 * was false every time X was away, busy or had the door shut — the roster is
 * the only thing that knows, and `senderHearingFrom` is what asks it.
 */
function stripHeadline(input: {
  status: WalkieStatus;
  state: any;
  name: string;
  /** The snooze runs out on a clock, and `senderHearingFrom` needs to know
   *  which side of it we are on. Passed in so no timer hides in here. */
  now: number;
  dropped: boolean;
  micDenied: boolean;
}): string {
  const { status, state, name, now, dropped, micDenied } = input;
  const { sending, incoming } = status;
  if (sending) {
    if (!sending.live) return `Opening the mic for ${name}`;
    if (dropped) return `Nobody is hearing this — ${name} still gets it`;
    // BOTH KEYS ARE DOWN. Two voices in one room is worth saying plainly: the
    // alternative was a strip claiming only my own half while a second person
    // was already talking into it.
    if (incoming) return `You and ${name} are both talking`;
    if (sending.heardLive) return senderHearingFrom(state, sending.roomKey, now).text;
    return `Recording — ${name} gets it`;
  }
  // A SEAT WITH NO MICROPHONE. The burst plays, the words arrive, and nothing
  // this person says can leave — so the strip says exactly that rather than
  // "Riley is talking", which reads as a conversation and is half of one.
  if (micDenied) return `You can hear ${name} — your mic is off (permission denied)`;
  if (incoming) return `${name} is talking`;
  return `Still open with ${name}`;
}

/** The four things the call dock can be. */
export type DockSurface = "none" | "walkie" | "stage" | "dock";

/**
 * WHICH SURFACE THE DOCK SHOWS. A lookup, not a rule stack.
 *
 * The walkie holds one room and knows what it is, so the answer is that fact
 * read out: a burst or a listen draws the strip, and everything else is the
 * ordinary call dock — expanded into the stage if the person expanded it.
 *
 * A burst OUTLIVES the room it was spoken into: when the room falls over under
 * an open microphone the call plane goes idle, but the recorder, the meter and
 * the recognizer are still running and the message still lands. That is why the
 * strip is asked for first and why `walkieHoldsRoom` tolerates a call with no
 * room. A call plane sitting in some OTHER room is the opposite case — the
 * person walked into a huddle — and that room keeps its own dock.
 */
export function callDockSurface(
  status: WalkieStatus,
  call: { roomKey: string | null; phase: string },
  opts: { expanded: boolean },
): DockSurface {
  if (walkieHoldsRoom(status, call.roomKey)) return "walkie";
  if (call.phase === "idle") return "none";
  return opts.expanded ? "stage" : "dock";
}
