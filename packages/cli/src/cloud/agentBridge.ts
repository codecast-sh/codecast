/**
 * The opt-in SSH agent bridge: `cast hosts forward-agent <id>` makes the
 * laptop daemon hold ONE ssh connection to the host with agent forwarding
 * on, so a process on the box can sign with the laptop's keys while the
 * bridge is up. The fallback for a repo the host's own device key cannot be
 * granted on (a second repo when a deploy key is already bound, an origin
 * outside GitHub) — not the default, because every key in the laptop's agent
 * is usable by any process running as the host user while it is up.
 *
 * The bridge is its OWN connection (ControlMaster=no, ControlPath=none): the
 * shared control socket that sshBase() multiplexes transfers through is
 * evicted by ensureUp's `-O exit` on every prepare, so a bridge riding it
 * would die with every wake; and a dedicated connection is exactly one TCP
 * session, which is what the host's idle watchdog subtracts per live bridge.
 *
 * The remote side checks the forwarded socket itself — ExitOnForwardFailure
 * covers port and tunnel forwardings only — and exits 3 when sshd did not
 * forward one (AllowAgentForwarding off). Then it links the socket to a
 * stable path the host daemon exports as SSH_AUTH_SOCK and blocks on stdin
 * with `cat`, under argv0 `cast-agent-bridge`: `cat` exits the moment the
 * connection (or the laptop child's stdin) closes, so no sleeper outlives a
 * disconnect, and the argv0 is what the watchdog's anchored pgrep matches.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CloudHost } from "../browser/cloudHost.js";
import { isRemoteDevice } from "../remote/device.js";
import type { RemoteHost } from "../remote/session-move.js";

/** Where the host daemon and every session on the box find the forwarded agent. */
export const HOST_AGENT_SOCK_REL = ".codecast/ssh-agent.sock";
export const HOST_AGENT_SOCK = path.join(os.homedir(), HOST_AGENT_SOCK_REL);

/** The remote side's exit code when sshd forwarded no agent socket. */
export const AGENT_BRIDGE_REFUSED_EXIT = 3;

/** The idle watchdog version that knows to subtract a live bridge from the ssh count. */
export const AGENT_BRIDGE_MIN_WATCHDOG = 2;

export const AGENT_BRIDGE_ARGV0 = "cast-agent-bridge";

export const AGENT_BRIDGE_REMOTE =
  `[ -S "$SSH_AUTH_SOCK" ] || exit ${AGENT_BRIDGE_REFUSED_EXIT}; ` +
  `mkdir -p ~/.codecast; ln -sfn "$SSH_AUTH_SOCK" ~/${HOST_AGENT_SOCK_REL}; ` +
  `(exec -a ${AGENT_BRIDGE_ARGV0} cat >/dev/null); rm -f ~/${HOST_AGENT_SOCK_REL}`;

/** The ssh argv for one bridge connection (the laptop keeps its stdin open). */
export function agentBridgeArgs(host: RemoteHost): string[] {
  return [
    "-i", host.keyPath,
    "-o", "IdentitiesOnly=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=20",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=3",
    "-o", "ControlMaster=no",
    "-o", "ControlPath=none",
    "-o", "ForwardAgent=yes",
    "-T",
    `${host.user}@${host.address}`,
    AGENT_BRIDGE_REMOTE,
  ];
}

/**
 * Should the laptop daemon hold a bridge to this host right now? Only when
 * the human turned it on, the host answers (never a wake), this laptop has an
 * agent to forward, and the host's watchdog is new enough not to be kept
 * awake by the bridge's own connection.
 */
export function shouldRunBridge(cloud: CloudHost, reachable: boolean, laptopAgentSock: string | undefined): boolean {
  return cloud.forwardAgent === true && reachable && !!laptopAgentSock && (cloud.watchdogVersion ?? 0) >= AGENT_BRIDGE_MIN_WATCHDOG;
}

/** The laptop daemon's bridge maintenance cadence. */
export const AGENT_BRIDGE_TICK_MS = 60 * 1000;
/** The longest wait between attempts to reopen a bridge that keeps dying. */
export const AGENT_BRIDGE_MAX_BACKOFF_MS = 5 * 60 * 1000;
/** A bridge that lived this long was working: its exit starts the backoff over. */
export const AGENT_BRIDGE_HEALTHY_MS = 2 * AGENT_BRIDGE_TICK_MS;

export interface BridgeBackoff { failures: number; notBefore: number }

/**
 * The backoff after a bridge exited on its own: consecutive fast failures
 * double the wait from one tick up to the cap (a host whose remote side
 * cannot even mkdir gets one inbound ssh per five minutes, not per minute —
 * its idle watchdog counts inbound ssh as activity); a bridge that lived
 * past AGENT_BRIDGE_HEALTHY_MS was working, so its exit counts as the first
 * failure again.
 */
export function nextBridgeBackoff(prev: BridgeBackoff | undefined, livedMs: number, now = Date.now()): BridgeBackoff {
  const failures = livedMs >= AGENT_BRIDGE_HEALTHY_MS ? 1 : (prev?.failures ?? 0) + 1;
  const wait = Math.min(AGENT_BRIDGE_MAX_BACKOFF_MS, AGENT_BRIDGE_TICK_MS * 2 ** (failures - 1));
  return { failures, notBefore: now + wait };
}

/**
 * The `SSH_AUTH_SOCK='…'` token for a session launch prefix on the host, or
 * "" when there is no live bridge. stat (not lstat): the path is a symlink
 * the bridge left, and only its target says whether an agent is listening.
 */
export function hostAgentSocketEnv(sockPath = HOST_AGENT_SOCK): string {
  if (!isRemoteDevice()) return "";
  try {
    if (!fs.statSync(sockPath).isSocket()) return "";
  } catch {
    return "";
  }
  return `SSH_AUTH_SOCK='${sockPath.replace(/'/g, "'\\''")}'`;
}
