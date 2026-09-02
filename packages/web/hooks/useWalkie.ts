// The walkie's React layer, and no components — so the surfaces that DO render
// one stay Fast Refresh boundaries.
//
// The heart of it is the talk TOGGLE, which every surface shares: click to
// start talking, click again to stop. The DM composer's key, a face's Talk
// button, the receiver card's answer, the keyboard chord — all four are the
// same toggle, so the gesture lives here once and each surface supplies only
// what it looks like and which room it opens.
//
// A talk is one way. The person talking is seen and heard; they hear nobody
// back until the listener joins on purpose. Nothing here ends a talk behind the
// person's back — not a blur, not a surface unmounting — because the person
// chose to talk and only they (or the engine's own cap) say when it stops.
import { useCallback, useSyncExternalStore, type MouseEvent } from "react";
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
  walkieJoinedRoom,
  warmMic,
  type WalkieStatus,
} from "../lib/calls/walkie";
import { useInboxStore, useTrackedStore } from "../store/inboxStore";
import { teamHasFeature } from "../lib/teamFeatures";
import { PRESENCE_BUCKET_MS } from "@codecast/convex/convex/presenceState";
import { describeRoom } from "../lib/calls/roomLabels";
import { memberDisplayName } from "../lib/liveEntities";
import { useShortcutAction, useShortcutContext } from "../shortcuts";
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
  /** The hold outlived the fill and LATCHED: this client is deliberately live
   *  in this key's room (the walkie's own upgrade), hands off the key, until
   *  they End. The mic may still be muted or denied — the call plane's facts
   *  say — but the seat is theirs on purpose. */
  locked: boolean;
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
  ptt: Pick<PushToTalk, "holding" | "capturing" | "dropped" | "locked">,
): "idle" | "opening" | "live" | "dropped" | "locked" {
  if (ptt.dropped) return "dropped";
  if (ptt.capturing) return "live";
  // After the fill latches there is no burst left to capture, so `locked`
  // comes after the burst facts: mid-fill the key still reads as the live
  // hold it is, and the latch takes over the moment the burst lands.
  if (ptt.locked) return "locked";
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
  if (state === "opening") return "Opening the mic — one moment";
  if (state === "live") {
    return opts.live
      ? "Talking — they hear you now. Click to stop"
      : "Talking — they get it as a message. Click to stop";
  }
  if (state === "locked") return "You are on the line, hands free — End hangs up";
  return opts.label ?? opts.title ?? "Talk";
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
    // The latch: this key's room is the one this client stepped into on
    // purpose (the fill completing, or Join live). A fifth fact, because a
    // key that latched has no burst left and every other field goes quiet.
    roomKey && walkieJoinedRoom(s) === roomKey ? "1" : "0",
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
  // A TOGGLE, NOT A HOLD. Click starts the talk, click stops it. Nothing on
  // this side is timed and nothing releases behind the person's back: the
  // window blurring, the surface unmounting (a face menu closing under the
  // pointer) — none of that is the person saying "stop". The engine's own cap
  // is the backstop, and the red button on the card is the door.
  const release = useCallback(() => {
    if (getWalkieStatus().sending?.roomKey !== roomKey) return;
    void endBurst();
  }, [roomKey]);

  const press = useCallback(() => {
    if (getWalkieStatus().sending || walkieBlockedReason(roomKey)) return;
    const channelId = resolveChannelId();
    if (!channelId || !roomKey) return;
    void startBurst(channelId, roomKey);
  }, [roomKey, resolveChannelId]);

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
    // Deliberately live in this key's room — the fill having latched, or Join
    // live pressed; the key cannot tell them apart and should not. The engine
    // keeps the claim honest against the call plane (reconcileLiveRoom).
    locked: !!roomKey && walkieJoinedRoom(status) === roomKey,
    live: opened && !dropped,
    dropped,
    capturing: holding && !!status.sending?.live,
    reason: walkieBlockedReason(roomKey),
    press,
    release,
  };
}

/**
 * The keyboard half, mounted by whatever surface has a DM open: one chord that
 * starts the talk and, pressed again, stops it. A registered shortcut, so it
 * is listed in the help panel and guarded against modals like every binding.
 *
 * ON SCREEN, NOT MERELY MOUNTED. The tab shell keeps a chat page mounted behind
 * whatever tab is in front, and a binding armed by a hidden page would start a
 * talk into a conversation the person is not even looking at. Presence is
 * read HERE rather than taken from the caller, so no surface can arm it by
 * forgetting to ask.
 */
export function useTalkShortcut(
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
      // The chord TOGGLES: once to talk, once to stop.
      if (ptt.holding) ptt.release();
      else ptt.press();
    }, [armed, ptt]),
  );
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
/**
 * What a talk key spreads onto its element: ONE click toggles the talk, and a
 * pointer arriving warms the microphone so the first word is not paid for by
 * the device. It CANNOT prompt — the engine only proceeds where permission is
 * already granted — so nobody is asked for a microphone by moving a mouse.
 */
export function talkToggleProps(ptt: PushToTalk) {
  return {
    onPointerEnter: () => void warmMic(),
    onFocus: () => void warmMic(),
    onClick: (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (ptt.holding) ptt.release();
      else ptt.press();
    },
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
/**
 * WHAT STAGE THE WALKIE IS AT, said bluntly.
 *
 * `badge` is the loud word a person reads first (RECORDING, LIVE, ON THE
 * LINE), `hint` is what their hands should do next. Both come from the same
 * facts the headline is built from, in one place, so the corner card, the
 * keys and a screen reader can never disagree about what pressing does.
 */
export type WalkieStage =
  | "opening"
  | "recording"
  | "live"
  | "both"
  | "dropped"
  | "locked"
  | "incoming"
  | "mic-off"
  | "open";

export type WalkieStageWords = { stage: WalkieStage; badge: string; hint: string };

export function walkieStageWords(input: {
  sending: { live: boolean; heardLive: boolean } | null;
  incoming: boolean;
  locked: boolean;
  muted: boolean;
  dropped: boolean;
  micDenied: boolean;
  name: string;
}): WalkieStageWords {
  const { sending, incoming, locked, muted, dropped, micDenied, name } = input;
  const stopHint = "Click STOP when you are done.";
  if (sending) {
    if (dropped) return { stage: "dropped", badge: "NOT HEARD", hint: `Still recording. ${name} gets it as a message. ${stopHint}` };
    if (!sending.live) return { stage: "opening", badge: "OPENING MIC", hint: "One moment. Do not talk yet." };
    if (incoming) return { stage: "both", badge: "BOTH TALKING", hint: stopHint };
    if (sending.heardLive) {
      return { stage: "live", badge: "TALKING", hint: `${name} sees you and hears you. You will not hear them until they JOIN. ${stopHint}` };
    }
    return { stage: "recording", badge: "RECORDING", hint: `Opening the line to ${name}. If they are away they get this as a message. ${stopHint}` };
  }
  if (locked) {
    return muted
      ? { stage: "locked", badge: "ON THE LINE · MUTED", hint: `${name} cannot hear you. Press UNMUTE to talk, END to hang up.` }
      : { stage: "locked", badge: "ON THE LINE", hint: `Hands free. ${name} hears everything you say. Press END to hang up.` };
  }
  if (micDenied) return { stage: "mic-off", badge: "MIC OFF", hint: `You can hear ${name}. Your mic permission is denied, so you cannot answer.` };
  if (incoming) {
    return {
      stage: "incoming",
      badge: "INCOMING",
      hint: `${name} is talking to you. You hear them; they cannot hear you. TALK to answer · JOIN LIVE to talk back and forth · SNOOZE to stop bursts for an hour.`,
    };
  }
  return { stage: "open", badge: "THEY STOPPED", hint: `${name} just talked to you. TALK to answer, or JOIN LIVE to talk back and forth.` };
}

export type WalkieStrip = WalkieStageWords & {
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
  /** This client is deliberately live in the room, hands off the key — the
   *  fill locked, or Join live was pressed. The strip shows a seat, not a
   *  hold: my face, the live headline, and an End. */
  locked: boolean;
  /** The other side is deliberately in too (their roster stamp), or their
   *  voice is playing right now — either way their face belongs on screen. */
  together: boolean;
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
  // The latch: this client's own deliberate seat in the strip's room. Read off
  // the engine's joined room rather than any flag of this surface's own, so
  // the fill locking and the Join live button land in the same state.
  const joined = walkieJoinedRoom(status);
  const locked = !!joined && call.roomKey === joined && call.phase !== "idle";
  // Their face belongs on the card whenever they are IN THE ROOM with me:
  // their voice playing, their deliberate join, or simply their seat — the
  // auto-listen puts them there the moment my voice arrives, and two people
  // in one room is two faces, whoever opened which seat.
  const me = String(state.currentUser?._id ?? "");
  const seats = locked ? ((state.callOccupancy?.[joined!] as any[]) ?? []) : [];
  const together =
    rx ||
    (locked &&
      (seats.some((r) => String(r?.user_id ?? "") !== me) ||
        otherJoinedLive(seats, me, status.liveRoom?.since ?? 0)));
  return {
    ...walkieStageWords({
      sending: sending ? { live: sending.live, heardLive: sending.heardLive } : null,
      incoming: rx,
      locked,
      muted: call.muted !== false,
      dropped,
      micDenied,
      name,
    }),
    headline: stripHeadline({ status, state, name, now: ctx.now, dropped, micDenied }),
    tx,
    rx,
    hotMic: hotMic && !locked,
    micDenied,
    dropped,
    quiet: tx && status.asr === "unavailable",
    locked,
    together,
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
  // LOCKED: a deliberate seat, hands off the key. Muted is said first because
  // it flips what every other sentence here promises; a two-way line when they
  // are in; otherwise the roster answers whether they can actually hear this —
  // never this client's own seat, which was the old "Live to X" lie.
  const joined = walkieJoinedRoom(status);
  if (joined && state.call.roomKey === joined) {
    if (state.call.muted) return `Muted — ${name} can't hear you`;
    if (incoming) return `You and ${name} are live`;
    if (
      otherJoinedLive(
        (state.callOccupancy?.[joined] as any[]) ?? [],
        String(state.currentUser?._id ?? ""),
        status.liveRoom?.since ?? 0,
      )
    ) {
      return `You and ${name} are live`;
    }
    return senderHearingFrom(state, joined, now).text;
  }
  if (incoming) return `${name} is talking`;
  return `Still open with ${name}`;
}

/**
 * THE OTHER PERSON LEFT A TWO-PERSON ROOM. A DM room with one seat in it is a
 * call with nobody on the other end: the card saying "they hear everything you
 * say" would be a lie, and the founder's rule is that a huddle you leave goes
 * away — on BOTH sides. True only once the other side was actually seen in the
 * room (`sawOther`), so a seat still waiting for them to arrive is not ended
 * by its own patience.
 */
export function dmRoomEmptied(input: {
  roomKey: string | null;
  seats: { user_id?: unknown }[];
  me: string;
  sawOther: boolean;
}): boolean {
  const { roomKey, seats, me, sawOther } = input;
  if (!roomKey || !roomKey.startsWith("dm:") || !sawOther) return false;
  return !seats.some((r) => String(r?.user_id ?? "") !== me);
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
  opts: {
    expanded: boolean;
    /** Any video in the room — a camera either way, or a screen. Video is what
     *  earns the card; a voice stays circles. */
    video?: boolean;
  },
): DockSurface {
  if (walkieHoldsRoom(status, call.roomKey)) {
    // MY OWN seat, lingering after my talk ended, is not a card: the person
    // said Stop and the card going with it is what Stop means. The room stays
    // open a moment so an answer can arrive fast. A LISTENER's linger still
    // draws — their card carries Talk and Join live, which is the whole point
    // of keeping the seat.
    if (!status.sending && !status.incoming && status.liveRoom?.mode === "burst") return "none";
    return "walkie";
  }
  if (call.phase === "idle") return "none";
  // A voice room this client stepped into FROM THE WALKIE keeps the walkie's
  // own shape — faces and an End, not a video card for a conversation with no
  // video in it. The fill locking, and Join live, both land here. Video
  // arriving or the person expanding hands the room to the ordinary dock.
  if (!opts.expanded && !opts.video && walkieJoinedRoom(status) === call.roomKey) return "walkie";
  return opts.expanded ? "stage" : "dock";
}
