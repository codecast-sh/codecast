// The roots of the retired simple lane and its onboarding, which redirect
// into the main app (lib/laneRedirect.ts). Imports nothing, so the tab shell
// and the router read the same list.

/** The retired simple lane's root. */
export const LANE_ROOT = "/simple";

/** The assistant's old onboarding. */
export const WELCOME_PATH = "/welcome";

/** Every root outside the main app's shell; the tab shell leaves these paths
 *  alone, so the router runs their redirects. */
export const LANE_ROOTS = [LANE_ROOT, WELCOME_PATH] as const;

/** Where one lane conversation lived, as a route pattern. */
export const LANE_CONVERSATION_ROUTE = `${LANE_ROOT}/c/:id`;

/** Whether a pathname is `root` itself or a page under it. */
export function isUnderRoot(pathname: string, root: string): boolean {
  return pathname === root || pathname.startsWith(root + "/");
}
