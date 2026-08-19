// The anchor space — store-fed, one row per scope key ("user" | "team:<id>").
import { useCallback } from "react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../store/inboxStore";
import { useSyncCollection } from "./useSyncCollection";

const api = _api as any;

/** The store key for one anchor scope. A team scope is a SPECIFIC team, never
 *  "the active one": a person in several teams has several team anchors. */
export function anchorScopeKey(scope: "team" | "user", teamId?: string | null): string {
  return scope === "team" ? `team:${teamId ?? "active"}` : "user";
}

/** Feeder + reader. `space` is undefined while cold, null when the server
 *  says there is nothing (unauthed), else the payload. */
export function useAnchorSpace(scope: "team" | "user", teamId?: string | null): { space: any; ready: boolean } {
  const key = anchorScopeKey(scope, teamId);
  const select = useCallback(
    // null (unauthed) still lands as a row so the reader can tell "answered
    // null" from "not answered": _id is the scope key, payload spread on top.
    (data: any) => [{ _id: key, ...(data ?? { anchor: null, unauthed: true }) }],
    [key],
  );
  const args = scope === "team" && teamId ? { scope_type: scope, team_id: teamId } : { scope_type: scope };
  const { ready } = useSyncCollection("anchorSpaces", api.anchors.getAnchorSpace, args, { select });
  const row = useInboxStore((s) => (s.anchorSpaces as any)[key]);
  return { space: row ?? (ready ? null : undefined), ready };
}
