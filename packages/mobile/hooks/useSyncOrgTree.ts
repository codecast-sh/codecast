import { useInboxStore } from "@codecast/web/store/inboxStore";
import { useSyncOrgTreeFull } from "@codecast/web/hooks/useSyncOrgTree";
import type { OrgTree } from "@codecast/web/components/org/orgTypes";

// The org tree for the active workspace (the store's workspace mirror, as on
// web), fed into the shared store.
export function useSyncOrgTree() {
  // The persisted user record names the viewer on the first frame, so the
  // cached tree paints before getCurrentUser answers.
  const meId = useInboxStore((s) => (s.currentUser?._id ? String(s.currentUser._id) : null));
  const state = useSyncOrgTreeFull();
  const tree = useInboxStore((s) => s.orgTree) as OrgTree | null;
  return { tree, meId, ...state };
}
