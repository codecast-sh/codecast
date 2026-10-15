/**
 * The host-side refusal that keeps every laptop's logins off a shared host
 * (docs/architecture/shared-hosts.md). It lives on the host, so it holds
 * whichever laptop pushes and whichever path pushes: provisioning, a wake,
 * `cast hosts sync-auth`, a session move, the daemon's periodic refresh.
 * No imports: session-move.ts and browser/sharedHost.ts both read it.
 */

/** The host-side record that a host is shared. */
export const SHARED_HOST_MARKER = "/etc/codecast/shared-host";

/** The exit status a refused push ends with, distinct from the agent auth receiver's own 3 (another user's logins). */
export const SHARED_HOST_REFUSED_STATUS = 4;

export const SHARED_HOST_REFUSAL =
  "this is a shared host: no laptop logins go there, each person signs in on the host with their own accounts";

/** Prefix for a remote command (SHARED_HOST_REFUSAL holds no single quote, so it quotes as is) that receives a credential on stdin: drain it, say why, exit 4. */
export const SHARED_HOST_PUSH_GUARD =
  `if [ -e ${SHARED_HOST_MARKER} ]; then cat >/dev/null; echo '${SHARED_HOST_REFUSAL}' >&2; exit ${SHARED_HOST_REFUSED_STATUS}; fi; `;
