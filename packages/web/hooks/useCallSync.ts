import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useConvex, useConvexAuth } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore, useTrackedStore } from "../store/inboxStore";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { useConvexSync } from "./useConvexSync";
import { autoScribe, bindConvex, isDeliberateRoom } from "../lib/calls/callManager";
import { getScribeStatus, stopScribe, subscribeScribe } from "../lib/calls/transcription";
import { decideAutoScribe } from "../lib/calls/autoScribe";
import { channelRoomKey, sessionRoomKey } from "@codecast/shared/contracts";
import { channelRowRoomKey } from "../lib/chatViews";
import { soundRoomKnock } from "../lib/sounds";

import { useWatchEffect } from "./useWatchEffect";
// The huddles data pump, mounted once app-wide (DashboardLayout, beside
// useChatToasts). Renders nothing; binds the Convex client into callManager
// and syncs three store fields:
//   callConfig     is calling even configured (gates every affordance)
//   myCalls        invites ringing at/from me + my room membership
//   callOccupancy  live rosters for the rooms currently on screen
//   liveRooms      every huddle running in my teams (open rooms + lock state)
//   roomKnocks     who is waiting at the door of the room I'm seated in
// All of these queries ENRICH surfaces that render fine without them, so they go
// through useQueryNoThrow — a deploy gap must never ErrorBoundary the shell.
export function useCallSync(): void {
  const convex = useConvex();
  const { isAuthenticated } = useConvexAuth();
  useWatchEffect(() => {
    bindConvex(convex);
  }, [convex]);

  const { data: config } = useQueryNoThrow(api.calls.getCallConfig, isAuthenticated ? {} : "skip");
  useConvexSync(config, useCallback((d: any) => {
    useInboxStore.getState().syncTable("callConfig", d);
  }, []));

  const enabled = !!config?.enabled;
  const { data: myCalls } = useQueryNoThrow(api.calls.getMyCalls, enabled ? {} : "skip");
  useConvexSync(myCalls, useCallback((d: any) => {
    useInboxStore.getState().syncTable("myCalls", d);
  }, []));

  // Occupancy for what's on screen: every teammate's current room (the strip
  // hue + hover card) plus the visible session's room (header chip). Channel
  // rails pass their own keys through the same query via OccupancyChip.
  const s = useTrackedStore([
    (st: any) => st.teamMembers.map((m: any) => m.in_room_key).filter(Boolean).sort().join("|"),
    (st: any) => st.currentSessionId,
    (st: any) => st.call.roomKey,
    (st: any) => st.call.phase,
    (st: any) =>
      (st.chatRail ?? [])
        .map((r: any) => {
          const ch = st.chatChannels?.[r.channel_id];
          return `${r.channel_id}:${ch?.kind ?? ""}:${ch?.dm_key ?? ""}:${(r.member_ids ?? []).join(",")}`;
        })
        .join("|"),
    (st: any) => st.currentUser?._id,
  ]);
  const roomKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const m of s.teamMembers) if (m?.in_room_key) keys.add(m.in_room_key);
    const current = s.currentSessionId && s.getConvexId(s.currentSessionId);
    if (current) keys.add(sessionRoomKey(current));
    // Chat rooms — the rail is the team's few channels, bounded. A DM or
    // group thread huddles in the room of its member set, a channel in its
    // own. channelRowRoomKey derives the roster exactly the way the chips'
    // view layer does (dm_key first), so the keys fetched here are the keys
    // the chips subscribe to.
    const viewer = String(s.currentUser?._id ?? "");
    for (const r of s.chatRail ?? []) {
      const ch = r?.channel_id && s.chatChannels?.[r.channel_id];
      if (!ch) continue;
      keys.add(channelRowRoomKey(ch, r, viewer, s.teamMembers));
    }
    // The room I'M in, always — the dock's roster must not depend on a
    // teammate's heartbeat having landed in the strip.
    if (s.call.roomKey) keys.add(s.call.roomKey);
    return [...keys].sort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.teamMembers, s.currentSessionId, s.call.roomKey, s.chatRail, s.chatChannels, s.currentUser?._id]);

  const { data: occupancy } = useQueryNoThrow(
    api.calls.getRoomOccupancy,
    enabled && roomKeys.length > 0 ? { room_keys: roomKeys } : "skip",
  );
  useConvexSync(occupancy, useCallback((d: any) => {
    useInboxStore.getState().syncTable("callOccupancy", d);
  }, []));

  // Every huddle running anywhere in my teams — occupancy above answers "who
  // is in THESE rooms", this answers "which rooms exist at all", which is what
  // makes an open room findable (sidebar Live now, /calls Happening now) and
  // carries the lock state the dock renders. Ephemeral like the rest of the
  // call slice: never persisted, re-derived on every load.
  const { data: liveRooms } = useQueryNoThrow(api.calls.getLiveRooms, enabled ? {} : "skip");
  useConvexSync(liveRooms, useCallback((d: any) => {
    useInboxStore.getState().syncTable("liveRooms", d);
  }, []));

  // Who is waiting at MY door. Readable only from inside the room, so it is
  // subscribed only while seated; leaving the room falls back to the stable
  // empty list, which clears the knocks the dock was showing.
  const seatedRoomKey = s.call.phase === "connected" ? s.call.roomKey : null;
  const { data: knocks } = useQueryNoThrow(
    api.calls.getRoomKnocks,
    enabled && seatedRoomKey ? { room_key: seatedRoomKey } : "skip",
  );
  // Every huddle transcribes. While seated, watch who is running the room's
  // transcript and ask to scribe when nobody is (or when the scribe's seat is
  // gone); yield a run that was adopted away from us. The server arbitrates
  // (transcripts.start), so two clients asking at once cannot both win.
  const { data: liveTranscript } = useQueryNoThrow(
    api.transcripts.getLive,
    enabled && seatedRoomKey ? { room_key: seatedRoomKey, tail: 1 } : "skip",
  );
  const scribeActive = useSyncExternalStore(subscribeScribe, () => getScribeStatus().active, () => false);
  const roster = useTrackedStore([
    (st: any) => (seatedRoomKey ? (st.callOccupancy[seatedRoomKey] ?? []) : []).map((m: any) => String(m.user_id)).sort().join("|"),
    (st: any) => !!(st.liveRooms as any[]).find((r) => r.room_key === seatedRoomKey)?.transcribe_off,
  ]);
  const rosterSig = seatedRoomKey
    ? (roster.callOccupancy[seatedRoomKey] ?? []).map((m: any) => String(m.user_id)).sort().join("|")
    : "";
  const transcribeOff = !!(roster.liveRooms as any[]).find((r) => r.room_key === seatedRoomKey)?.transcribe_off;
  const meId = s.currentUser?._id ? String(s.currentUser._id) : null;
  const liveStartedBy = liveTranscript === undefined ? undefined : liveTranscript ? String(liveTranscript.started_by) : null;
  useWatchEffect(() => {
    const verdict = decideAutoScribe({
      roomKey: seatedRoomKey,
      connected: !!seatedRoomKey,
      deliberate: isDeliberateRoom(seatedRoomKey),
      transcribeOff,
      rosterIds: rosterSig ? rosterSig.split("|") : [],
      meId,
      live: liveStartedBy === undefined ? undefined : liveStartedBy === null ? null : { startedBy: liveStartedBy },
      scribeActive,
    });
    if (verdict === "start" && seatedRoomKey) autoScribe(seatedRoomKey);
    else if (verdict === "yield") void stopScribe({ keepLive: true });
  }, [seatedRoomKey, transcribeOff, rosterSig, meId, liveStartedBy, scribeActive]);

  useConvexSync(seatedRoomKey ? knocks : NO_KNOCKS, useCallback((d: any) => {
    // The sound belongs to the knock ARRIVING, not to a surface being
    // mounted: someone at the door must be audible whether or not the dock
    // is on screen.
    // Keyed by person AND time: a re-knock refreshes one row rather than
    // adding a second, so a knocker's second attempt differs from their first
    // only in created_at. The person alone would announce them once, ever.
    const key = (k: any) => `${k.from_user}:${k.created_at}`;
    const fresh = (d as any[]).some((k) => !heardKnocks.has(key(k)));
    heardKnocks = new Set((d as any[]).map(key));
    if (fresh) soundRoomKnock();
    useInboxStore.getState().syncTable("roomKnocks", d);
  }, []));
}

// Stable empty list: passing a fresh [] would re-apply on every render.
const NO_KNOCKS: any[] = [];
// Knockers already announced, so a heartbeat re-push doesn't knock twice.
let heardKnocks = new Set<string>();

export { channelRoomKey, sessionRoomKey };
