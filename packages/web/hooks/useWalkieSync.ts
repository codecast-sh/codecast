// The walkie's ear, mounted once app-wide beside useCallSync.
//
// Chat messages only sync for the channel on screen, but a walkie burst is
// heard before it is read — so this is the one standing subscription that knows
// a teammate is talking into a DM room right now (chat.listLiveVoiceBursts,
// deliberately without the transcript so a burst's own words do not re-push it
// to every watcher on every sentence).
//
// The DOOR — the walkie pref, the snooze, the busy flag, whether a person is at
// this machine and whether this is the window that speaks for the app — lives
// in lib/calls/walkieDoor. It moved out of this hook when "at the machine"
// stopped being a question about this window: the answer now spans every window
// of the app and, on the desktop, the operating system's own idle clock. This
// hook reads it and hands it to the engine, which applies it (lib/calls/walkie).
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useConvex, useConvexAuth } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore, useTrackedStore } from "../store/inboxStore";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { useConvexSync } from "./useConvexSync";
import { useMountEffect } from "./useMountEffect";
import { memberDisplayName } from "../lib/liveEntities";
import {
  bindWalkie,
  getWalkieStatus,
  markWalkieUpgraded,
  noteBurstUnheard,
  observeWalkie,
  refreshWalkie,
  walkieJoinedRoom,
  type LiveBurstRow,
} from "../lib/calls/walkie";
import { otherJoinedLive, senderHearingFrom, useWalkieStatus } from "./useWalkie";
import { machineDoorNow, subscribeMachineDoor, walkieDoorOpen } from "../lib/calls/walkieDoor";
import { readJoinPrefs } from "../lib/calls/joinPrefs";
import { setCamera } from "../lib/calls/callManager";
import { soundWalkieJoined } from "../lib/sounds";
import { announceJoin, theyJoinedText } from "../lib/calls/joinAnnounce";
import { useNowWhen } from "./useCoarseNow";

const api = _api as any;

export function useWalkieSync(): void {
  const convex = useConvex();
  const { isAuthenticated } = useConvexAuth();
  useMountEffect(() => {
    bindWalkie(convex);
  });

  // IS A PERSON AT THIS MACHINE, AND IS THIS THE WINDOW THAT SPEAKS FOR THE APP.
  // Two facts about the world outside this window, gathered in one place and
  // read here as one value (lib/calls/walkieDoor).
  const machine = useSyncExternalStore(subscribeMachineDoor, machineDoorNow, machineDoorNow);

  // The DM rooms worth watching. Subscribed as a signature of exactly those
  // ids — the rail re-pushes on every message in every channel, and none of
  // that moves this list.
  const s = useTrackedStore([
    (st: any) =>
      (st.chatRail ?? [])
        .map((r: any) => (st.chatChannels?.[r.channel_id]?.kind === "dm" ? r.channel_id : ""))
        .filter(Boolean)
        .sort()
        .join("|"),
    (st: any) => st.currentUser?.walkie_pref ?? "",
    (st: any) => st.currentUser?.walkie_snoozed_until ?? 0,
    (st: any) => st.currentUser?.status ?? "",
    (st: any) => !!st.callConfig?.enabled,
    // The engine's answer depends on where the call plane is: a huddle the
    // person joined elsewhere takes push-to-talk away, and a room they left
    // gives it back.
    (st: any) => `${st.call?.roomKey ?? ""}:${st.call?.phase ?? ""}`,
  ]);

  const channelIds = useMemo(() => {
    const ids = new Set<string>();
    for (const row of s.chatRail ?? []) {
      if (s.chatChannels?.[row.channel_id]?.kind === "dm") ids.add(String(row.channel_id));
    }
    return [...ids].sort();
  }, [s.chatRail, s.chatChannels]);

  const callsOn = !!s.callConfig?.enabled;
  const callSig = `${s.call?.roomKey ?? ""}:${s.call?.phase ?? ""}`;
  const { data: bursts } = useQueryNoThrow(
    api.chat.listLiveVoiceBursts,
    isAuthenticated && callsOn && channelIds.length > 0 ? { channel_ids: channelIds } : "skip",
  );

  // The snooze runs out on a clock rather than on an event, so the door has to
  // be re-decided as time passes: without this the hour would end and nothing
  // would notice until the next burst happened to push. Coarse on purpose —
  // this is an hour-long shutter, and a minute of slack at its edge costs
  // nobody anything, while a per-second clock would re-push the whole report.
  const snoozedUntil = Number(s.currentUser?.walkie_snoozed_until ?? 0);
  const now = useNowWhen((n) => (snoozedUntil > n ? "shut" : "open"), 30_000);
  const snoozed = snoozedUntil > now;

  const doorOpen = walkieDoorOpen({
    callsOn,
    atMachine: machine.atMachine,
    leader: machine.leader,
    snoozed,
    pref: s.currentUser?.walkie_pref,
    status: s.currentUser?.status,
  });

  // One object, changing exactly when the engine's answer could change: a new
  // burst, one ending, or the door opening or closing under the person's feet.
  const report = useMemo(() => {
    const members = useInboxStore.getState().teamMembers ?? [];
    const rows: LiveBurstRow[] = (bursts ?? []).map((b: any) => ({
      messageId: String(b.message_id),
      channelId: String(b.channel_id),
      roomKey: b.room_key,
      fromUserId: String(b.user_id),
      fromName: memberDisplayName(
        members.find((m: any) => String(m._id) === String(b.user_id)),
        "A teammate",
      ),
      createdAt: b.created_at,
    }));
    return { bursts: rows, doorOpen };
  }, [bursts, doorOpen]);

  useConvexSync(report, useCallback((r: { bursts: LiveBurstRow[]; doorOpen: boolean }) => {
    observeWalkie(r);
  }, []));
  // The other half of the engine's answer: where the call plane is. Leaving a
  // huddle gives push-to-talk back, and joining one takes it away, neither of
  // which moves the burst list.
  useConvexSync(callSig, useCallback(() => refreshWalkie(), []));

  useWalkieUpgrade();
  useWalkieAwayTick();
}

/**
 * MY BURST IS LANDING AS A MESSAGE.
 *
 * The other half of "X hears you": when the roster says nobody is there, the
 * strip says so in words and this says so in a sound, off the same derivation,
 * so the two can never disagree.
 *
 * It waits for `heardLive`. Before the track reaches the room "nobody is
 * hearing this" is a fact about MY connection rather than about them, and the
 * strip already has its own sentence for that ("Recording — X gets it"). After
 * it, the room is open and empty, which is the thing worth a tick.
 *
 * Subscribed as the SEATS alone. The door decides between "away" and "busy" in
 * the words and changes nothing here — both are the same sound, because from
 * the sender's side they are the same outcome — so this watcher does not wake
 * for a teammate toggling a pref. `noteBurstUnheard` holds the once-per-hold
 * guard; the value below only keeps the callback from running on every push.
 */
function useWalkieAwayTick(): void {
  const status = useWalkieStatus();
  const sending = status.sending;
  const room = sending?.heardLive ? sending.roomKey : null;
  const s = useTrackedStore([
    (st: any) => String(st.currentUser?._id ?? ""),
    (st: any) =>
      ((room && st.callOccupancy?.[room]) || [])
        .map((m: any) => String(m.user_id))
        .sort()
        .join("|"),
  ]);
  const unheard =
    room && senderHearingFrom(s, room, Date.now()).state !== "hears"
      ? `${sending!.clientId}:${room}`
      : undefined;

  useConvexSync(unheard, useCallback(() => noteBurstUnheard(), []));
}

/**
 * THE OTHER SIDE JOINED LIVE.
 *
 * The sender's half of the upgrade, and the only half that has to be watched
 * for: this client's own Join live is a click it already knows about, but the
 * far side's is news, and it arrives as a stamp on a roster row
 * (call_members.walkie_joined_at, through the occupancy the dock already
 * subscribes to for the room it is in).
 *
 * Three things happen on that one edge, and they are the difference between a
 * state change and a moment somebody feels:
 *
 *   THE SURFACE. Telling the engine is what does it — the live room becomes a
 *   call from here, so the strip becomes the dock on this screen the same way
 *   it already did on theirs. It also stops the seat's clock, which must never
 *   hand back a call that has only just started.
 *   THE CAMERA. They are in a call they chose by talking, so their own saved
 *   camera setting applies now, exactly as it would have on a join button. The
 *   microphone is already hot and stays that way.
 *   THE CUE. The join sound the ordinary path plays on connect, which never
 *   fires here because nobody connects — the room was already up.
 */
function useWalkieUpgrade(): void {
  const status = useWalkieStatus();
  const s = useTrackedStore([
    (st: any) => st.call.roomKey,
    (st: any) => st.call.phase,
    (st: any) => st.currentUser?._id,
    // A signature of the stamps alone. The roster re-pushes on every mute,
    // camera and heartbeat move in the room; none of those are this question,
    // and an always-mounted watcher must not wake for them.
    (st: any) =>
      (st.call.roomKey ? (st.callOccupancy[st.call.roomKey] ?? []) : [])
        .map((m: any) => (m?.walkie_joined_at ? String(m.user_id) : ""))
        .filter(Boolean)
        .sort()
        .join("|"),
  ]);
  const roomKey: string | null = s.call.roomKey;
  const roster: any[] = (roomKey && s.callOccupancy[roomKey]) || [];
  // Only a room the WALKIE is in. A stamp on an ordinary huddle is somebody who
  // upgraded a burst into it before this client walked in, and it says nothing
  // about the room this client is sitting in now.
  const live = status.liveRoom;
  const mine = !!roomKey && live?.key === roomKey;
  // AND ONLY A STAMP FROM THIS SEAT'S OWN LIFETIME. `walkie_joined_at` outlives
  // a browser that died without leaving, so a room whose last occupant crashed
  // carries a stamp forever — and the next burst into it would read as already
  // upgraded from its first tick: no mute on release, a join announced that
  // nobody made, and the strip handed straight to the call dock. A stamp older
  // than the moment this client entered the room is a leftover, not news.
  const upgraded = mine && otherJoinedLive(roster, s.currentUser?._id, live?.since ?? 0);

  // Fired through the same change-driven hook the rest of this file uses: it
  // runs when its value CHANGES and skips `undefined`, which is exactly one
  // run per room somebody steps into and none at all the rest of the time.
  useConvexSync(
    upgraded && roomKey ? roomKey : undefined,
    useCallback((room: string) => observeWalkieUpgrade(room, joinerName(room)), []),
  );
}

/** Whoever it was that stepped in, named the way every other surface names
 *  them: the live roster first, so a rename since the burst started is
 *  reflected, and the seat's own snapshot of the name behind it. Read from the
 *  store at the moment it fires rather than closed over, so the watcher's
 *  callback stays identity-stable and cannot go stale. */
function joinerName(room: string): string {
  const st = useInboxStore.getState() as any;
  const me = String(st.currentUser?._id ?? "");
  const seat = ((st.callOccupancy?.[room] ?? []) as any[]).find(
    (m) => !!m?.walkie_joined_at && String(m?.user_id ?? "") !== me,
  );
  if (!seat) return "";
  const member = (st.teamMembers ?? []).find((m: any) => String(m?._id) === String(seat.user_id ?? ""));
  return memberDisplayName(member, seat.user_name ?? "");
}

/**
 * The upgrade arriving, applied.
 *
 * Beside the hook rather than inside it because ONCE PER STAMP is the whole
 * contract here and a rule that has to hold exactly once cannot live in a
 * closure nothing can call twice on purpose. The roster re-pushes for every
 * mute, camera and heartbeat in the room; the stamp itself never changes after
 * it lands. So this is guarded on the engine's own answer — the room it
 * already knows it is in — and everything below the guard is a thing a person
 * should feel exactly one time.
 */
export function observeWalkieUpgrade(room: string, name: string): void {
  // Already known — my own Join live, or a re-push of the same roster.
  if (walkieJoinedRoom(getWalkieStatus()) === room) return;
  markWalkieUpgraded(room);
  // The loudest of the six walkie cues, and the only one that climbs three
  // notes: this is the biggest change of state the walkie has. Not
  // soundCallJoin, whose triad says "someone entered a room" rather than "the
  // burst you are speaking just became a call" — the two step on different
  // intervals and over different registers so they cannot trade places.
  soundWalkieJoined();
  // AND IN WORDS. The sound alone is what shipped, and a cue nobody has been
  // taught is not an announcement: the dock says who joined for four seconds,
  // then goes back to being the room's title.
  announceJoin(room, theyJoinedText(name));
  if (readJoinPrefs().cameraOn && !useInboxStore.getState().call.camera) {
    void setCamera(true);
  }
}

