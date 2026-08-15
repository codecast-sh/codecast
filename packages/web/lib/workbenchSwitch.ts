import { useInboxStore, type SavedViewRow } from "../store/inboxStore";
import { surfaceForPath, type SurfaceKind } from "../store/workspace";
import type { WorkbenchSnapshot } from "../store/workbench";

// The inbox canonicalizes its URL to /conversation/<id> while a session is
// open; both are the same surface, and hopping between them would close the
// conversation you are reading.
function sameSurface(a: SurfaceKind, b: SurfaceKind): boolean {
  if (a === b) return true;
  const conv = (s: SurfaceKind) => s === "inbox" || s === "conversation";
  return conv(a) && conv(b);
}

/**
 * The saved workbenches, in rail order: yours first, then teammates' shared
 * ones, alphabetical within each. ⌥1–⌥4 index into this same order, so the
 * key you learn from the rail's hint is the key that works.
 */
export function sortedWorkbenches(s: {
  savedViews: Record<string, SavedViewRow>;
  clientState: { ui?: { active_team_id?: string } };
}): SavedViewRow[] {
  const teamId = s.clientState.ui?.active_team_id;
  return (Object.values(s.savedViews ?? {}) as SavedViewRow[])
    .filter((v) => v.page === "workspace" && (!v.team_id || v.team_id === teamId))
    .sort((a, b) => Number(!!b.is_mine) - Number(!!a.is_mine) || (a.name || "").localeCompare(b.name || ""));
}

/**
 * Switch to a workbench: restore the chrome atomically (store action), and go
 * to the arrangement's surface — unless you are already on it, in which case
 * the page (and whatever conversation or detail it shows) stays put.
 */
export function switchToWorkbench(
  snap: WorkbenchSnapshot,
  nav: { push: (path: string) => void },
  pathname?: string | null,
  id?: string,
) {
  useInboxStore.getState().applyWorkbench(snap, id);
  if (snap.path && !sameSurface(surfaceForPath(snap.path), surfaceForPath(pathname ?? ""))) {
    nav.push(snap.path);
  }
}
