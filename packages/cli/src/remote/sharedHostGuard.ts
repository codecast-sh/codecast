/**
 * The host-side refusal that keeps laptop logins out of other people's homes
 * on a shared host (docs/architecture/shared-hosts.md). The box's admin is its
 * only sudoer, so their home is as private as a private host's and their own
 * laptop's logins go there as on any host; every other user's home is
 * readable by the admin, so nothing is pushed into it. It lives on the host,
 * so it holds whichever laptop pushes and whichever path pushes:
 * provisioning, a wake, `cast hosts sync-auth`, a session move, the daemon's
 * periodic refresh. No imports: session-move.ts and browser/sharedHost.ts
 * both read it.
 */

/** The host-side record that a host is shared. */
export const SHARED_HOST_MARKER = "/etc/codecast/shared-host";

/** The exit status a refused push ends with, distinct from the agent auth receiver's own 3 (another user's logins). */
export const SHARED_HOST_REFUSED_STATUS = 4;

export const SHARED_HOST_REFUSAL =
  "this is a shared host and this user is not its admin: no laptop logins go here, each person signs in on the host with their own accounts";

/** Prefix for a remote command (SHARED_HOST_REFUSAL holds no single quote, so it quotes as is) that receives a credential on stdin: on a shared host, as anyone but the marker's admin, drain it, say why, exit 4. */
export const SHARED_HOST_PUSH_GUARD =
  `if [ -e ${SHARED_HOST_MARKER} ] && ! grep -qx "admin=$(id -un)" ${SHARED_HOST_MARKER}; then cat >/dev/null; echo '${SHARED_HOST_REFUSAL}' >&2; exit ${SHARED_HOST_REFUSED_STATUS}; fi; `;
