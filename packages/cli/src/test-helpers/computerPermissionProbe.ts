/**
 * Read the helper's own TCC grants from a test or a script (A7, ct-49523).
 *
 * This used to be a second implementation of the probe, because the production
 * one could not be used from here: `resolveCastInvocation()` handed a test or a
 * script a `main.ts` that did not exist and the detached spawn hid the ENOENT
 * (ct-49674), and the poll gave up after 5 seconds while the helper needed
 * longer than that to answer (ct-49671). Both are fixed in the production path,
 * so this is now an adapter: `getPermissionStatus` does the launching, the
 * polling and the reading, and the only thing left here is the shape the
 * verification procedures want and a route they can name.
 *
 * Naming the route is the point of `confirm-route` (design 3.4): the disclaimed
 * spawn must report the HELPER's permission state rather than one inherited
 * from its parent, and the comparison only proves something if both routes run
 * the code that ships.
 */

import { getPermissionStatus, type PermissionProbeRoute } from "../computer/permissions.js";
import { resolveCastInvocation } from "../castInvocation.js";
import type { ComputerPermissionId, ComputerPermissionStatus } from "../computer/types.js";

export type ProbeRoute = PermissionProbeRoute;
export type ProbeResult = Record<ComputerPermissionId, ComputerPermissionStatus | "no-answer">;

/** How to invoke this CLI as a child, for code whose argv[1] is not the CLI. */
export function castLaunch(args: string[]): { cmd: string; args: string[] } {
  const cast = resolveCastInvocation();
  return { cmd: cast.cmd, args: [...cast.prefixArgs, ...args] };
}

/** The disclaimed spawn, the way `defaultHelperLaunch` builds it. */
export function disclaimedHelperLaunch(exe: string, helperArgs: string[]): { cmd: string; args: string[] } {
  return castLaunch(["_disclaimed", "--", exe, ...helperArgs]);
}

export async function probeHelperPermissions(route: ProbeRoute = "disclaimed"): Promise<ProbeResult> {
  try {
    const status = await getPermissionStatus({ route });
    const of = (id: ComputerPermissionId) => status.permissions.find((p) => p.id === id)?.status ?? "not-granted";
    return { accessibility: of("accessibility"), screenshots: of("screenshots") };
  } catch {
    // A probe that never answered, or one that died. The caller reports
    // "no-answer" rather than a grant it did not read; the production error
    // (which now names the exit and the stderr) is what a user would see.
    return { accessibility: "no-answer", screenshots: "no-answer" };
  }
}
