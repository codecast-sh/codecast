import { useCallback } from "react";
import { useConvexAuth } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../store/inboxStore";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { useConvexSync } from "./useConvexSync";
import { applyLiveRoomsPush } from "../lib/calls/liveRoomsPush";

/** The call feeds every platform needs, into the store:
 *    callConfig  is calling configured at all (gates every affordance)
 *    myCalls     invites ringing at/from me + my room membership
 *    callRooms + liveRooms  every huddle running in my teams, its lock and
 *                recording flags, and who is in it
 *  Web's useCallSync mounts this beside its media-plane effects; the phone's
 *  sync bridge mounts it alone. Each query ENRICHES surfaces that render fine
 *  without it, so they go through useQueryNoThrow. Returns whether calling is
 *  configured. */
export function useCallBaseFeeds(): { enabled: boolean } {
  const { isAuthenticated } = useConvexAuth();
  const { data: config } = useQueryNoThrow(api.calls.getCallConfig, isAuthenticated ? {} : "skip");
  useConvexSync(config, useCallback((d: any) => {
    useInboxStore.getState().syncTable("callConfig", d);
  }, []));

  const enabled = !!config?.enabled;
  const { data: myCalls } = useQueryNoThrow(api.calls.getMyCalls, enabled ? {} : "skip");
  useConvexSync(myCalls, useCallback((d: any) => {
    useInboxStore.getState().syncTable("myCalls", d);
  }, []));

  // Every huddle running anywhere in my teams: what makes an open room
  // findable (Live now, Happening now) and carries the lock state. Ephemeral
  // like the rest of the call slice: never persisted, re-derived each load.
  const { data: liveRooms } = useQueryNoThrow(api.calls.getLiveRooms, enabled ? {} : "skip");
  useConvexSync(liveRooms, applyLiveRoomsPush);
  return { enabled };
}
