// The team machines on the viewer's teams (teamHosts.list) — store-fed. Mount
// it where a surface shows them; components read the teamMachines key.
import { useCallback } from "react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../store/inboxStore";
import { useConvexSync } from "./useConvexSync";
import { useQueryNoThrow } from "./useQueryNoThrow";

const api = _api as any;

export function useSyncTeamMachines(enabled = true): { ready: boolean } {
  const { data } = useQueryNoThrow(api.teamHosts.list, enabled ? {} : "skip");
  const setTeamMachines = useInboxStore((s) => s.setTeamMachines);
  useConvexSync(data, useCallback((rows: any) => { if (Array.isArray(rows)) setTeamMachines(rows); }, [setTeamMachines]));
  return { ready: data !== undefined };
}
