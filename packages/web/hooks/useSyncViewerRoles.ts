// Feeder for `viewerRoles` (roleIcons.viewerRoles): every role the viewer can
// see, across their personal workspace and every team, the one home of a
// role's face and name fields (lib/roleRows). Mounted once by the sync host
// (DashboardLayout's HostFeeders); faces read the store.
import { api } from "@codecast/convex/convex/_generated/api";
import { useSyncCollection } from "./useSyncCollection";

export function useSyncViewerRoles() {
  return useSyncCollection("viewerRoles", api.roleIcons.viewerRoles, {});
}
