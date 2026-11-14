// Whether the viewer can move a failed-over role back to the host it left
// (convex roleFailover.moveBack, the same rule): a machine they may start
// sessions on, their own (machineRoster) or a team machine (agentBoxes), and
// one that is no longer past the quiet threshold. Mounted only by the failover
// line, so a heartbeat on the roster re-renders the line, never the page.
import { useMemo } from "react";
import { roleMoveBackState, type MoveBackMachine, type MoveBackState, type RoleFailover } from "@codecast/shared/contracts/roleFailover";
import { useInboxStore } from "../store/inboxStore";
import { useSettingsData } from "./useSyncSettings";
import { useCoarseNow } from "./useCoarseNow";

export function useRoleMoveBack(f: RoleFailover | null | undefined): MoveBackState | null {
  const meId = useInboxStore((s) => (s.currentUser?._id ? String(s.currentUser._id) : null));
  const roster = useInboxStore((s) => s.machineRoster) as Array<{ device_id: string; last_seen: number }>;
  const boxes = (useSettingsData("agentBoxes").data ?? []) as Array<{ device_id: string; owner_user_id: string; last_seen: number }>;
  const now = useCoarseNow(60_000);
  return useMemo(() => {
    if (!f?.to || !meId) return null;
    const machines: MoveBackMachine[] = [
      ...roster.map((d) => ({ device_id: d.device_id, user_id: meId, last_seen: d.last_seen })),
      ...boxes.map((b) => ({ device_id: b.device_id, user_id: String(b.owner_user_id), last_seen: b.last_seen })),
    ];
    return roleMoveBackState(f, machines, now);
  }, [f, meId, roster, boxes, now]);
}
