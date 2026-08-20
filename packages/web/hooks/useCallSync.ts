import { useCallback, useEffect, useMemo } from "react";
import { useConvex, useConvexAuth } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore, useTrackedStore } from "../store/inboxStore";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { useConvexSync } from "./useConvexSync";
import { bindConvex } from "../lib/calls/callManager";
import { channelRoomKey, sessionRoomKey } from "@codecast/shared/contracts";
import { channelRowRoomKey } from "../lib/chatViews";

// The huddles data pump, mounted once app-wide (DashboardLayout, beside
// useChatToasts). Renders nothing; binds the Convex client into callManager
// and syncs three store fields:
//   callConfig     is calling even configured (gates every affordance)
//   myCalls        invites ringing at/from me + my room membership
//   callOccupancy  live rosters for the rooms currently on screen
// All three queries ENRICH surfaces that render fine without them, so they go
// through useQueryNoThrow — a deploy gap must never ErrorBoundary the shell.
export function useCallSync(): void {
  const convex = useConvex();
  const { isAuthenticated } = useConvexAuth();
  useEffect(() => {
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
}

export { channelRoomKey, sessionRoomKey };
