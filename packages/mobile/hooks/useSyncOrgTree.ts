import { useInboxStore } from "@codecast/web/store/inboxStore";
import { useSyncOrgTreeFull } from "@codecast/web/hooks/useSyncOrgTree";
import type { OrgTree } from "@codecast/web/components/org/orgTypes";

// The org tree for the active workspace, fed into the shared store. The phone
// switches teams through users.active_team_id alone, so the feeder takes that
// pointer; unset means the personal workspace, and an unloaded user waits.
export function useSyncOrgTree() {
  // The persisted user record names the pointer and the viewer on the first
  // frame, so the cached tree paints before getCurrentUser answers.
  const meId = useInboxStore((s) => (s.currentUser?._id ? String(s.currentUser._id) : null));
  const teamId = useInboxStore((s) => (s.currentUser as any)?.active_team_id as string | undefined);
  const state = useSyncOrgTreeFull(meId ? (teamId ?? null) : undefined);
  const tree = useInboxStore((s) => s.orgTree) as OrgTree | null;
  return { tree, meId, ...state };
}
