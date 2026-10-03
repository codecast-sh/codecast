// The new-session folder list, scoped to the machine the session will run on.
// One implementation for every new-session picker (web's ProjectSwitcher, the
// mobile sheet), so the phone and the desktop offer the same folders and both
// paint them on the first frame from the store.
import { useCallback, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../store/inboxStore";
import { useConvexSync } from "./useConvexSync";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { useRecentProjectsFeed } from "./useRecentProjectsFeed";
import { mergeRecentProjectPaths, recentProjectPathsFromSessionKeys, recentProjectSessionKey, type RecentProject } from "../lib/recentProjectPaths";
import { resolveScopedProjects, type MachineCandidate } from "../lib/machinePicker";

const NO_KEYS: string[] = [];

/**
 * Ladder: live scoped answer → that machine's cached answer → the union
 * narrowed to that machine's roots → nothing (roster not loaded yet). With no
 * machine scope, the union: my ranked folders (live, else cached) plus any
 * folder my loaded sessions ran in.
 */
export function useScopedRecentProjects(opts: {
  scopedDeviceId: string | null | undefined;
  routedDevice?: Pick<MachineCandidate, "local_project_roots"> | null;
  /** False while the picker is mounted but hidden: skips the per-change scan
   *  of loaded sessions, which the first visible render then does at once. */
  active?: boolean;
}): RecentProject[] {
  const { scopedDeviceId, routedDevice, active = true } = opts;
  // No-throw: a backend timeout degrades to the cached list instead of
  // dropping the picker into its ErrorBoundary.
  const freshProjects = useRecentProjectsFeed();
  const cachedProjects = useInboxStore((s) => s.recentProjects);
  const currentUserId = useInboxStore((s) => (s.currentUser?._id ? String(s.currentUser._id) : null));
  // Stable primitive keys, not session objects (replaced on heartbeats).
  const loadedSessionProjectKeys = useInboxStore(useShallow((s) =>
    active ? Object.values(s.sessions).map(recentProjectSessionKey) : NO_KEYS,
  ));
  const ownSessionProjects = useMemo(
    () => recentProjectPathsFromSessionKeys(loadedSessionProjectKeys, currentUserId),
    [loadedSessionProjectKeys, currentUserId],
  );

  // The scoped answer feeds a per-machine cache so every later open paints
  // that machine's last list at once; it never feeds the union cache.
  const { data: scopedProjects } = useQueryNoThrow(
    api.users.getRecentProjectPaths,
    scopedDeviceId ? { limit: 50, device_id: scopedDeviceId } : "skip",
  );
  const cachedScopedProjects = useInboxStore((s) => (scopedDeviceId ? s.recentProjectsByDevice[scopedDeviceId] : undefined));
  const setRecentProjectsForDevice = useInboxStore((s) => s.setRecentProjectsForDevice);
  const syncScopedProjects = useCallback(
    (projects: RecentProject[]) => {
      if (scopedDeviceId) setRecentProjectsForDevice(scopedDeviceId, projects);
    },
    [scopedDeviceId, setRecentProjectsForDevice],
  );
  useConvexSync(scopedProjects as RecentProject[] | undefined, syncScopedProjects);

  const unionProjects = useMemo<RecentProject[]>(
    () => mergeRecentProjectPaths(freshProjects ?? cachedProjects, ownSessionProjects),
    [freshProjects, cachedProjects, ownSessionProjects],
  );
  return useMemo<RecentProject[]>(
    () => resolveScopedProjects({
      scopedDeviceId,
      scoped: scopedProjects as RecentProject[] | undefined,
      cached: cachedScopedProjects,
      union: unionProjects,
      routedDevice,
    }),
    [scopedDeviceId, scopedProjects, cachedScopedProjects, unionProjects, routedDevice],
  );
}
