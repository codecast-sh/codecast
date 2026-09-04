import { useCallback, useSyncExternalStore } from "react";
import {
  peekOsPermissions,
  refreshOsPermissions,
  subscribeOsPermissions,
  UNKNOWN_PERMISSIONS,
  type OsPermissionKind,
  type PermissionMap,
} from "../lib/osPermissions";

import { useMountEffect } from "./useMountEffect";
// React view of the shared OS-permissions store (lib/osPermissions.ts).
const getServerSnapshot = () => UNKNOWN_PERMISSIONS;

export function useOsPermissions(): { permissions: PermissionMap; refresh: () => Promise<void> } {
  const permissions = useSyncExternalStore(subscribeOsPermissions, peekOsPermissions, getServerSnapshot);
  const refresh = useCallback(() => refreshOsPermissions(), []);
  // A consumer mounting while the poll is parked (nothing was actionable at
  // the time) still wants one fresh read.
  useMountEffect(() => {
    refreshOsPermissions();
  });
  return { permissions, refresh };
}

export function useOsPermission(kind: OsPermissionKind) {
  const { permissions, refresh } = useOsPermissions();
  return { readiness: permissions[kind], refresh };
}
