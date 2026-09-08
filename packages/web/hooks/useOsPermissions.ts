import { useCallback, useState, useSyncExternalStore } from "react";
import {
  peekComputerPermissions,
  peekOsPermissions,
  refreshComputerPermissions,
  refreshOsPermissions,
  subscribeComputerPermissions,
  subscribeOsPermissions,
  UNKNOWN_COMPUTER_PERMISSIONS,
  UNKNOWN_PERMISSIONS,
  type AppPermissionKind,
  type ComputerPermissionMap,
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

export function useOsPermission(kind: AppPermissionKind) {
  const { permissions, refresh } = useOsPermissions();
  return { readiness: permissions[kind], refresh };
}

const getServerComputerSnapshot = () => UNKNOWN_COMPUTER_PERMISSIONS;

// The codecast computer grants. Mounting this is what asks for them, because
// the read launches the helper and takes seconds — so mount it only where the
// rows are actually on screen. `checking` is true for the first read alone;
// later reads (a return to the window) replace an answer that is already
// drawn.
export function useComputerPermissions(): { permissions: ComputerPermissionMap; checking: boolean } {
  const permissions = useSyncExternalStore(subscribeComputerPermissions, peekComputerPermissions, getServerComputerSnapshot);
  const [checking, setChecking] = useState(true);
  useMountEffect(() => {
    refreshComputerPermissions().finally(() => setChecking(false));
  });
  return { permissions, checking };
}
