import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "@codecast/web/store/inboxStore";
import { useSyncOrgTreeFeeder } from "@codecast/web/hooks/useSyncOrgTree";
import type { OrgTree } from "@codecast/web/components/org/orgTypes";

// The org tree for the active workspace, fed into the shared store. The phone
// switches teams through users.active_team_id alone, so the feeder takes that
// pointer; unset means the personal workspace, and an unloaded user waits.
export function useSyncOrgTree() {
  const user = useQuery(api.users.getCurrentUser);
  const state = useSyncOrgTreeFeeder(user ? (user.active_team_id ?? null) : undefined);
  const tree = useInboxStore((s) => s.orgTree) as OrgTree | null;
  return { tree, meId: user?._id ? String(user._id) : null, ...state };
}
