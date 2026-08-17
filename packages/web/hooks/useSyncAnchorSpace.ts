// The anchor space — store-fed, one row per scope_type.
import { useCallback } from "react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../store/inboxStore";
import { useSyncCollection } from "./useSyncCollection";

const api = _api as any;

/** Feeder + reader. `space` is undefined while cold, null when the server
 *  says there is nothing (unauthed), else the payload. */
export function useAnchorSpace(scope: "team" | "user"): { space: any; ready: boolean } {
  const select = useCallback(
    // null (unauthed) still lands as a row so the reader can tell "answered
    // null" from "not answered": _id is the scope, payload spread on top.
    (data: any) => [{ _id: scope, ...(data ?? { anchor: null, unauthed: true }) }],
    [scope],
  );
  const { ready } = useSyncCollection("anchorSpaces", api.anchors.getAnchorSpace, { scope_type: scope }, { select });
  const row = useInboxStore((s) => (s.anchorSpaces as any)[scope]);
  return { space: row ?? (ready ? null : undefined), ready };
}
