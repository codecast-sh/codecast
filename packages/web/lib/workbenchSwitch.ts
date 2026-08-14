import { useInboxStore } from "../store/inboxStore";
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
 * Switch to a workbench: restore the chrome atomically (store action), and go
 * to the activity's surface — unless you are already on it, in which case the
 * page (and whatever conversation or detail it shows) stays put.
 */
export function switchToWorkbench(
  snap: WorkbenchSnapshot,
  nav: { push: (path: string) => void },
  pathname?: string | null,
) {
  useInboxStore.getState().applyWorkbench(snap);
  if (snap.path && !sameSurface(surfaceForPath(snap.path), surfaceForPath(pathname ?? ""))) {
    nav.push(snap.path);
  }
}
