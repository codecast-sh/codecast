/**
 * Bring a host's cast up to this laptop's: `cast hosts update` and the host
 * prep every cloud wake runs (cloud/prepare.ts readyHostHome) both go through
 * here.
 *
 * A host built from this checkout never updates itself (its updater stands
 * down in dev mode), so without this a host stays on the build it was
 * provisioned with while every host-side fix lands only on the laptop: a cloud
 * host sat on 1.1.160 for four days and nine releases (2026-10-04).
 */
import { compareVersions } from "../browser/engine.js";
import { cliSourceVersion, hasHostBuildSource, installLinuxCast, restartHostDaemon } from "../browser/provisionLinux.js";
import { remoteExec } from "../browser/remote.js";
import { getVersion } from "../cliVersion.js";
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

/** The version this laptop installs on a host: the checkout's, else the running release. */
export function laptopCastVersion(): string {
  return hasHostBuildSource() ? cliSourceVersion() : getVersion();
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
export function updateHostCast(host: RemoteHost, platform: HostCastPlatform, opts: { restart: boolean; force?: boolean }, log: (message: string) => void): HostCastUpdate {
  if (platform === "darwin") {
    const version = installMacCast(host, log);
    if (!opts.restart) return { version };
    remoteExec(host, `sudo -n launchctl kickstart -k system/${macServiceLabel(host.user)}`, 60_000);
    return { version, restart: { pid: "launchd" } };
  }
  const { version } = installLinuxCast(host, log);
  if (!opts.restart) return { version };
  try {
    return { version, restart: restartHostDaemon(host, { force: opts.force }) };
  } catch (err) {
    if (opts.force) throw err;
    return { version, restart: { refused: err instanceof Error ? err.message : String(err) } };
  }
}

/**
 * The prep step: update the host only when this laptop's cast is strictly
 * newer. Never a downgrade (a worktree at an older commit must not roll the
 * host back), and never on an equal version (worktrees at one version would
 * take turns replacing each other's build). Non-fatal: a host that cannot be
 * updated keeps its build and the placement goes on.
 */
export function castForPrepare(host: RemoteHost, platform: HostCastPlatform, log: (message: string) => void, deps: { read?: typeof readHostCastVersion; update?: typeof updateHostCast; laptop?: () => string } = {}): string {
  const laptop = (deps.laptop ?? laptopCastVersion)();
  const current = (deps.read ?? readHostCastVersion)(host, platform);
  if (current && compareVersions(laptop, current) <= 0) return `cast ${current} on the host`;
  log(`host cast ${current ?? "missing"} is behind this laptop's ${laptop}; updating it…`);
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
