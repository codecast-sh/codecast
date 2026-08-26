// The walkie's ear, mounted once app-wide beside useCallSync.
//
// Chat messages only sync for the channel on screen, but a walkie burst is
// heard before it is read — so this is the one standing subscription that knows
// a teammate is talking into a DM room right now (chat.listLiveVoiceBursts,
// deliberately without the transcript so a burst's own words do not re-push it
// to every watcher on every sentence).
//
// The DOOR is decided here and nowhere else: the walkie pref, the manual busy
// flag, and whether the person is actually at this machine. The engine applies
// it (lib/calls/walkie), which keeps the policy readable in one place and the
// media plane out of React.
import { useCallback, useEffect, useMemo, useState } from "react";
import { useConvex, useConvexAuth } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore, useTrackedStore } from "../store/inboxStore";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { useConvexSync } from "./useConvexSync";
import { useMountEffect } from "./useMountEffect";
import { useEventListener } from "./useEventListener";
import { memberDisplayName } from "../lib/liveEntities";
import {
  bindWalkie,
  getWalkieStatus,
  markWalkieUpgraded,
  observeWalkie,
  refreshWalkie,
  type LiveBurstRow,
} from "../lib/calls/walkie";
import { lastWalkieTarget, otherJoinedLive, useWalkieStatus } from "./useWalkie";
import { readJoinPrefs } from "../lib/calls/joinPrefs";
import { setCamera } from "../lib/calls/callManager";
import { soundCallJoin } from "../lib/sounds";
import { useNowWhen } from "./useCoarseNow";

const api = _api as any;

/** True while this window is the one in front of the person. A burst plays out
 *  loud, so "at the machine" is the honest bar — a laptop with the lid down or
 *  a tab buried behind others is a room the voice should not fill. */
function atTheMachine(): boolean {
  if (typeof document === "undefined") return false;
  return document.visibilityState === "visible";
}

export function useWalkieSync(): void {
  const convex = useConvex();
  const { isAuthenticated } = useConvexAuth();
  useMountEffect(() => {
    bindWalkie(convex);
  });

  const [present, setPresent] = useState(atTheMachine);
  const observePresence = useCallback(() => setPresent(atTheMachine()), []);
  useEventListener("visibilitychange", observePresence, document);
  useEventListener("focus", observePresence);

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

  // The pref is open by default: a teammate's voice reaching you is the point
  // of the feature, and "off" is the deliberate act. The snooze is the same
  // door for an hour — pressed to stop the voice that is playing right now,
  // not to change what the product is.
  const doorOpen =
    callsOn &&
    present &&
    !snoozed &&
    s.currentUser?.walkie_pref !== "off" &&
    s.currentUser?.status !== "busy";

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
 *   THE SURFACE. Telling the engine is what does it — `walkieOwnsCall` answers
 *   false from here, so the strip becomes the dock on this screen the same way
 *   it already did on theirs. It also stops the linger handing the seat back
 *   under a call that has only just started.
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
  // Only a room the WALKIE is in. A stamp on an ordinary huddle is somebody
  // who upgraded a burst into it before this client walked in, and it says
  // nothing about the room this client is sitting in now.
  const mine = walkieRoomOf(status) === roomKey && !!roomKey;
  const upgraded = mine && otherJoinedLive(roster, s.currentUser?._id);

  useEffect(() => {
    if (!upgraded || !roomKey) return;
    if (getWalkieStatus().joinedLive === roomKey) return;
    markWalkieUpgraded(roomKey);
    soundCallJoin();
    if (readJoinPrefs().cameraOn && !useInboxStore.getState().call.camera) {
      void setCamera(true);
    }
  }, [upgraded, roomKey]);
}

/** The room the walkie considers its own, for the watcher above: the one being
 *  talked into, the one being heard, or the one still held open after a burst. */
function walkieRoomOf(status: { sending: any; incoming: any; lingerUntil: number | null }): string | null {
  return status.sending?.roomKey ?? status.incoming?.roomKey ?? (status.lingerUntil ? lastWalkieTarget()?.roomKey ?? null : null);
}
