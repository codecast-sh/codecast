/**
 * Keep a host's cast current: `cast hosts update` and the host prep every
 * cloud wake, placement and migration runs (cloud/prepare.ts readyHostHome)
 * both go through here. The prep holds a host to at least this laptop's
 * version before anything starts there (castForPrepare).
 *
 * A host runs the published release, so forced updates and the Settings
 * Update button reach it like any other client. A build of this checkout
 * (`--from-checkout`) is for trying an unreleased fix: the updater treats it as
 * a dev build and refuses every update, so a host left on one fell behind
 * (1.1.160 for four days and nine releases on 2026-10-04; 1.1.178 kept
 * retrying undeliverable station wakes after 1.1.179 shipped, 2026-10-16).
 */
import { compareVersions } from "../browser/engine.js";
import { cliSourceVersion, hasHostBuildSource, installLinuxCast, restartHostDaemon } from "../browser/provisionLinux.js";
import { HostCastBehind, latestReleaseVersion, releaseFor, type CastRelease, type HostCastSource } from "./installRelease.js";
import { getVersion } from "../cliVersion.js";
import { remoteExec } from "../browser/remote.js";
import type { RemoteHost } from "../remote/session-move.js";
import { installMacCast } from "./updateMac.js";
import { MAC_HOST_PATH, macServiceLabel } from "./provisionMac.js";

export type HostCastPlatform = "linux" | "darwin";

/** Which build a registered host takes. */
export function hostCastPlatform(entry: { platform?: string; provider?: string }): HostCastPlatform {
  return entry.platform === "darwin" || entry.provider === "scaleway-mac" ? "darwin" : "linux";
}

export interface HostCastUpdate {
  version: string;
  /** The daemon's new pid, or why it was left running the old build. */
  restart?: { pid: string } | { refused: string };
}

/** The version an install from this source puts on a host, or null when the release cannot be read. */
export function hostCastTarget(source: HostCastSource): string | null {
  return source === "checkout" && hasHostBuildSource() ? cliSourceVersion() : latestReleaseVersion();
}

/** The host's cast version, or null when it has none or does not answer. */
export function readHostCastVersion(host: RemoteHost, platform: HostCastPlatform): string | null {
  try {
    const path = platform === "darwin" ? MAC_HOST_PATH : 'export PATH="$HOME/.local/bin:/usr/local/bin:$PATH"';
    return remoteExec(host, `${path}; cast --version`, 30_000).match(/\d+\.\d+\.\d+/)?.[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Install this laptop's cast on the host and, when asked, restart its daemon
 * onto it. A Linux restart that would end sessions in the daemon's own tmux
 * server is refused unless forced; the refusal is returned, not thrown.
 */
export function updateHostCast(host: RemoteHost, platform: HostCastPlatform, opts: { restart: boolean; force?: boolean; source?: HostCastSource; release?: CastRelease }, log: (message: string) => void): HostCastUpdate {
  const source = opts.source ?? "release";
  if (platform === "darwin") {
    const version = installMacCast(host, log, source, opts.release);
    if (!opts.restart) return { version };
    // Stop the daemon itself, then have launchd start the service again. A
    // `kickstart -k` takes the job down whole and ended every session on the
    // Mac with it (2026-10-16); a plain stop leaves their panes running.
    remoteExec(host, `${MAC_HOST_PATH}; cast stop; sudo -n launchctl kickstart system/${macServiceLabel(host.user)}`, 60_000);
    return { version, restart: { pid: "launchd" } };
  }
  const { version } = installLinuxCast(host, log, source, opts.release);
  if (!opts.restart) return { version };
  try {
    return { version, restart: restartHostDaemon(host, { force: opts.force }) };
  } catch (err) {
    if (opts.force) throw err;
    return { version, restart: { refused: err instanceof Error ? err.message : String(err) } };
  }
}

/**
 * The prep step, run before anything starts on the host (a placement, a
 * migration): the host runs at least this laptop's cast. A host behind it gets
 * exactly this laptop's release, not latest, since what the laptop asks of the
 * host is what its own version knows; the install is proven by reading the
 * host's version back. A host at or ahead of the laptop is left alone: never a
 * downgrade (a host on a newer release, or trying a newer checkout build,
 * keeps it). Throws when the host's cast cannot be brought to this version.
 * The guarantee is the installed binary: the host daemon moves onto it when
 * it restarts, which happens here on Linux unless live sessions refuse it,
 * and never on a Mac (a restart ends its sessions). The returned line says
 * which.
 */
export function castForPrepare(
  host: RemoteHost,
  platform: HostCastPlatform,
  log: (message: string) => void,
  deps: { read?: typeof readHostCastVersion; update?: typeof updateHostCast; release?: (version: string) => CastRelease; laptop?: () => string } = {},
): string {
  const read = deps.read ?? readHostCastVersion;
  const laptop = (deps.laptop ?? getVersion)();
  const current = read(host, platform);
  if (current && compareVersions(current, laptop) >= 0) {
    return current === laptop ? `cast ${current} on the host` : `cast ${current} on the host, ahead of this laptop's ${laptop}`;
  }
  log(`host cast ${current ?? "missing"} is behind this laptop's ${laptop}; installing ${laptop}…`);
  const fail = (why: string) => new HostCastBehind(`the host runs cast ${current ?? "none"}, behind this laptop's ${laptop}, and ${why}; nothing was started there (cast hosts update to retry)`);
  let release: CastRelease;
  try {
    release = (deps.release ?? releaseFor)(laptop);
  } catch (err) {
    throw fail(`cast ${laptop} could not be fetched: ${err instanceof Error ? err.message : String(err)}`);
  }
  let up: HostCastUpdate;
  try {
    // A Mac restart ends the sessions it runs, so only Linux, whose restart refuses that, moves its daemon here.
    up = (deps.update ?? updateHostCast)(host, platform, { restart: platform === "linux", release }, log);
  } catch (err) {
    throw fail(`installing ${laptop} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const now = read(host, platform);
  if (now !== laptop) throw fail(`after installing ${laptop} it reports ${now ?? "no cast"}`);
  const line = !up.restart
    ? `host cast updated to ${laptop}; its daemon moves over on its next restart`
    : "refused" in up.restart
      ? `host cast updated to ${laptop}; its daemon keeps the old build until its sessions can stop (cast hosts update --force)`
      : `host cast updated to ${laptop} and its daemon restarted onto it`;
  log(line);
  return line;
}
