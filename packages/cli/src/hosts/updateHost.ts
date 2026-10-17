/**
 * Keep a host's cast current: `cast hosts update` and the host prep every
 * cloud wake runs (cloud/prepare.ts readyHostHome) both go through here.
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
import { latestReleaseVersion, type HostCastSource } from "./installRelease.js";
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
export function updateHostCast(host: RemoteHost, platform: HostCastPlatform, opts: { restart: boolean; force?: boolean; source?: HostCastSource }, log: (message: string) => void): HostCastUpdate {
  const source = opts.source ?? "release";
  if (platform === "darwin") {
    const version = installMacCast(host, log, source);
    if (!opts.restart) return { version };
    // Stop the daemon itself, then have launchd start the service again. A
    // `kickstart -k` takes the job down whole and ended every session on the
    // Mac with it (2026-10-16); a plain stop leaves their panes running.
    remoteExec(host, `${MAC_HOST_PATH}; cast stop; sudo -n launchctl kickstart system/${macServiceLabel(host.user)}`, 60_000);
    return { version, restart: { pid: "launchd" } };
  }
  const { version } = installLinuxCast(host, log, source);
  if (!opts.restart) return { version };
  try {
    return { version, restart: restartHostDaemon(host, { force: opts.force }) };
  } catch (err) {
    if (opts.force) throw err;
    return { version, restart: { refused: err instanceof Error ? err.message : String(err) } };
  }
}

/**
 * The prep step: put the latest release on the host only when the host is
 * strictly behind it. Never a downgrade (a host trying a newer checkout build
 * keeps it), and nothing when the release cannot be read. Non-fatal: a host
 * that cannot be updated keeps its build and the placement goes on.
 */
export function castForPrepare(host: RemoteHost, platform: HostCastPlatform, log: (message: string) => void, deps: { read?: typeof readHostCastVersion; update?: typeof updateHostCast; latest?: () => string | null } = {}): string {
  const current = (deps.read ?? readHostCastVersion)(host, platform);
  const latest = (deps.latest ?? (() => hostCastTarget("release")))();
  if (!latest) return `cast ${current ?? "missing"} on the host (the latest release could not be read)`;
  if (current && compareVersions(latest, current) <= 0) return `cast ${current} on the host`;
  log(`host cast ${current ?? "missing"} is behind the ${latest} release; updating it…`);
  try {
    // A Mac restart ends the sessions it runs, so only Linux, whose restart refuses that, moves its daemon here.
    const up = (deps.update ?? updateHostCast)(host, platform, { restart: platform === "linux" }, log);
    const line = !up.restart
      ? `host cast updated to ${up.version}; its daemon moves over on its next restart`
      : "refused" in up.restart
        ? `host cast updated to ${up.version}; its daemon keeps the old build until its sessions can stop (cast hosts update --force)`
        : `host cast updated to ${up.version} and its daemon restarted onto it`;
    log(line);
    return line;
  } catch (err) {
    const line = `host cast update failed, keeping ${current ?? "none"}: ${err instanceof Error ? err.message : String(err)}`;
    log(line);
    return line;
  }
}
