/**
 * Cloud placement: ONE predicate deciding whether a launch aimed at the cloud
 * host needs a laptop to prepare the host first, shared by the web composer
 * (createSessionFromStub / handleSwitch) and the Convex chokepoint
 * (enqueueStartSession). Two copies of this rule disagreed once — the web
 * asked "does the target see the path?" while the server asked "is the path
 * under a host root?" — and the web's answer failed with "not on this
 * machine". Pure data in, verdict out; no runtime imports.
 */

/**
 * A machine that boots itself when work arrives: the cloud Linux class, an EC2
 * box whose idle state is "stopped". A remote Mac cannot stop (so "offline"
 * means gone) and a laptop can only be opened by a human. The same rule
 * deviceName.ts uses to call a machine "Cloud Linux", so the name and the
 * behaviour cannot diverge.
 */
export function deviceWakesOnUse(d: { is_remote?: boolean; platform?: string }): boolean {
  return d.is_remote === true && /linux/i.test(d.platform ?? "");
}

/** True if `p` is at or below a known project root (`root` or a child of it). */
export function pathUnderRoot(p: string, root: string): boolean {
  return p === root || p.startsWith(root.endsWith("/") ? root : root + "/");
}

/**
 * False only when the path lives in a directory namespace the device's platform
 * provably does not have — `/Users/...` on Linux, `/home/...` on a Mac. Anything
 * shared (`/opt`, `/tmp`, `/srv`, unknown platforms, relative paths) stays true:
 * this exists to stop an obviously-impossible route, not to guess at checkouts.
 */
export function platformCanOpenPath(platform: string | undefined, p: string): boolean {
  if (!platform) return true;
  if (platform === "win32") return /^[A-Za-z]:[\\/]/.test(p) || !p.startsWith("/");
  if (!p.startsWith("/")) return true;
  if (platform === "darwin") return !p.startsWith("/home/") && !p.startsWith("/root/");
  if (platform === "linux") return !p.startsWith("/Users/");
  return true;
}

export type PlacementDevice = { platform?: string; local_project_roots?: string[] };

export type CloudPlacement = "park" | "native" | "ambiguous";

/**
 * Does a launch aimed at `target` (a wake-on-use host) need preparation?
 *
 *   native    — the host already holds the folder (some target root covers a
 *               path), or no local machine could open it at all (a `/home`
 *               path on a Mac-only account): a plain start on the host. An
 *               account with NO local device gets no such shortcut: only a
 *               host-root path is native there, anything else parks.
 *   park      — the host cannot open the path (a `/Users` folder on Linux),
 *               or a local machine's roots cover it: the folder lives on a
 *               laptop, so the laptop prepares the host and places the row.
 *   ambiguous — nobody claims the path (`/opt/x` with a Linux laptop around).
 *               The web maps this to park (the user picked the host from a
 *               laptop folder list and sends an explicit cloud_device_id); the
 *               server chokepoint leaves the launch untouched.
 *
 * Empty `paths` is ambiguous: a pathless eager row carries no evidence.
 */
export function cloudPlacementFor(opts: {
  target: PlacementDevice;
  locals: PlacementDevice[];
  paths: Array<string | null | undefined>;
}): CloudPlacement {
  const paths = opts.paths.filter((p): p is string => !!p);
  if (paths.length === 0) return "ambiguous";
  const targetRoots = opts.target.local_project_roots ?? [];
  if (paths.some((p) => targetRoots.some((r) => pathUnderRoot(p, r)))) return "native";
  // Only with a laptop to compare against: with NO local device the rule
  // would be vacuously true and a stale `/Users` recent would start as a
  // plain session on the host (remapped into its main checkout). Falling
  // through parks it instead, and the server then says plainly that no
  // laptop can prepare the host.
  if (opts.locals.length > 0
    && paths.every((p) => opts.locals.every((d) => !platformCanOpenPath(d.platform, p)))) return "native";
  if (paths.some((p) => !platformCanOpenPath(opts.target.platform, p))) return "park";
  if (paths.some((p) => opts.locals.some((d) => (d.local_project_roots ?? []).some((r) => pathUnderRoot(p, r))))) {
    return "park";
  }
  return "ambiguous";
}
