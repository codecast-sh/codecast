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
import { useCallback, useMemo, useState } from "react";
import { useConvex, useConvexAuth } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore, useTrackedStore } from "../store/inboxStore";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { useConvexSync } from "./useConvexSync";
import { useMountEffect } from "./useMountEffect";
import { useEventListener } from "./useEventListener";
import { memberDisplayName } from "../lib/liveEntities";
import { bindWalkie, observeWalkie, refreshWalkie, type LiveBurstRow } from "../lib/calls/walkie";

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

  // The pref is open by default: a teammate's voice reaching you is the point
  // of the feature, and "off" is the deliberate act.
  const doorOpen =
    callsOn && present && s.currentUser?.walkie_pref !== "off" && s.currentUser?.status !== "busy";

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
}
