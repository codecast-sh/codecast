import { api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../store/inboxStore";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { useConvexSync } from "./useConvexSync";

/** Feeds `recentProjects` (my folders ranked by use, each tagged with the team
 *  it shares into) and returns the fresh answer, undefined until it lands.
 *  Mount it wherever a new session's folder is chosen, so the choice reads a
 *  current list rather than whatever the cache last held. No-throw: the cached
 *  list is the honest answer when the query fails. */
export function useRecentProjectsFeed() {
  const { data: fresh } = useQueryNoThrow(api.users.getRecentProjectPaths, { limit: 50 });
  const setRecentProjects = useInboxStore((s) => s.setRecentProjects);
  useConvexSync(fresh, setRecentProjects);
  return fresh;
}
