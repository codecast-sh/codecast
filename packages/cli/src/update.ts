// Codecast's self update: one `Updater` from @platform/cli-kit/update plus the
// policy that is ours — where state lives, how a binary is downloaded, which
// keys may vouch for the manifest, what the darwin code signature must say,
// and the command a human types to update. The machine (version comparison,
// channel selection, manifest fetch and validation, checksum verify, the swap
// and the alias) is the package's; nothing about it is codecast specific.
//
// Every function below keeps the signature it had when this file held the
// implementation, so callers (index.ts, daemon.ts, desktopUpdate.ts) are
// unchanged. The per-snippet version labels moved to ./snippetVersions.ts and
// are re-exported here for the same reason.

import * as fs from "node:fs";
import {
  createUpdater,
  type DownloadOptions,
  type ManifestSigningPolicy,
  type Updater,
  type UpdaterConfig,
} from "@platform/cli-kit/update";
import { execFileSync, spawnSync } from "./proc.js";
import { getVersion } from "./cliVersion.js";
import { defaultConfigDir } from "./config/configDir.js";
import { isManagedInstall } from "./managedInstall.js";

export * from "./snippetVersions.js";
export { getVersion };

const VERSION = getVersion();
const CONFIG_DIR = defaultConfigDir();

export const RELEASE_BASE_URL = "https://dl.codecast.sh";

/** The Apple team every darwin release is signed by (CI and the laptop path). */
export const DARWIN_SIGNING_TEAM = "WRG9THCK9Q";

/**
 * Public keys that may vouch for latest.json, by key id. CI signs every
 * release with cli-release-2026 (custody in docs/architecture/release-signing.md).
 * While `required` is false a missing signature is still accepted, so an
 * unsigned publish keeps working; a signature that does not match is refused.
 */
export const RELEASE_MANIFEST_SIGNING: ManifestSigningPolicy = {
  keys: { "cli-release-2026": "4f1kzY89/uJGGB+hvoONtVag56qy1gOkVxhMzLdEc5M=" },
  required: false,
};

type ExecFileSync = typeof execFileSync;
type SpawnSync = typeof spawnSync;

/**
 * Download with curl, which streams to disk and works under launchd where
 * fetch is unreliable. argv only, never a shell: the URL is one argument
 * whatever it contains. curl itself is held to https on every hop and to the
 * byte bound, and the URL it finally read from must be the release origin.
 */
export function makeCurlDownload(exec: ExecFileSync = execFileSync) {
  return async (url: string, dest: string, { maxBytes, origin }: DownloadOptions): Promise<void> => {
    if (!url.startsWith("https://")) throw new Error("download_not_https");
    let effective: string;
    try {
      effective = String(
        exec(
          "curl",
          [
            "-fsSL",
            "--proto", "=https",
            "--proto-redir", "=https",
            "--max-redirs", "3",
            "--max-filesize", String(maxBytes),
            "-o", dest,
            "-w", "%{url_effective}",
            url,
          ],
          { timeout: 180000, stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" },
        ),
      ).trim();
    } catch (err) {
      const status = (err as { status?: number | null })?.status;
      throw new Error(`download_curl_${status ?? "failed"}`);
    }
    let landed: URL | null = null;
    try { landed = new URL(effective); } catch {}
    if (!landed || landed.protocol !== "https:" || landed.origin !== origin) {
      try { fs.unlinkSync(dest); } catch {}
      throw new Error("download_redirect_refused");
    }
  };
}

/**
 * On darwin, the downloaded binary must carry a valid signature by our team
 * before it replaces the running one. The check holds only when the running
 * binary is itself signed by that team: a dev build or an install that predates
 * signing has nothing to hold the new one to, and keeps updating as before.
 * Once a client is signed, an unsigned or foreign-signed release is refused;
 * a release built with CODECAST_SKIP_SIGN=1 no longer reaches those clients.
 */
export function makeDarwinSignatureCheck(opts: { spawn?: SpawnSync; platform?: string; execPath?: string } = {}) {
  const spawn = opts.spawn ?? spawnSync;
  const platform = opts.platform ?? process.platform;
  const execPath = opts.execPath ?? process.execPath;
  // undefined when codesign cannot read the file at all; null when it is
  // signed without a team.
  const teamOf = (binary: string): string | null | undefined => {
    const r = spawn("/usr/bin/codesign", ["-dv", "--", binary], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 30000 });
    if (r.status !== 0) return undefined;
    return /^TeamIdentifier=(\S+)$/m.exec(`${r.stdout ?? ""}\n${r.stderr ?? ""}`)?.[1] ?? null;
  };
  return async (binary: string): Promise<{ ok: boolean; reason?: string }> => {
    if (platform !== "darwin") return { ok: true };
    if (teamOf(execPath) !== DARWIN_SIGNING_TEAM) return { ok: true };
    const verify = spawn("/usr/bin/codesign", ["--verify", "--strict", "--", binary], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 60000 });
    if (verify.status !== 0) return { ok: false, reason: "invalid" };
    // A file that passed --verify and then cannot be read changed under the
    // check (another updater moved it), which is not a foreign signature.
    const team = teamOf(binary);
    if (team === undefined) return { ok: false, reason: "unreadable" };
    if (team !== DARWIN_SIGNING_TEAM) return { ok: false, reason: "wrong_team" };
    return { ok: true };
  };
}

/** The production updater, with any field overridable for a test. */
export function createCodecastUpdater(overrides: Partial<UpdaterConfig> = {}): Updater {
  return createUpdater({
    // Shown as "Downloading cast v1.2.3..." — the name a human types, which is
    // what they are waiting on.
    productName: "cast",
    binaryName: "codecast",
    aliasName: "cast",
    currentVersion: VERSION,
    releaseBaseUrl: RELEASE_BASE_URL,
    stateDir: CONFIG_DIR,
    updateCommand: "cast update",
    manifestSigning: RELEASE_MANIFEST_SIGNING,
    download: makeCurlDownload(),
    verifyPlatformSignature: makeDarwinSignatureCheck(),
    ...overrides,
  });
}

export const updater = createCodecastUpdater();

export async function checkForUpdates(force = false): Promise<string | null> {
  return updater.checkForUpdates(force);
}

export function isDevMode(): boolean {
  return updater.isDevMode();
}

/** How this binary got here. Every channel ships the same self-swapping
 *  binary (npm/install.js, the Homebrew formula), so the channel alone never
 *  blocks an update; running from source or a folder this user cannot write
 *  does, and the device page disables Update for those. */
export type Distribution = "installer" | "brew" | "npm" | "source";

export function installChannel(
  execPath = process.execPath,
  devMode = isDevMode(),
  writable = (dir: string) => { try { fs.accessSync(dir, fs.constants.W_OK); return true; } catch { return false; } },
  managed: (execPath: string) => boolean = isManagedInstall,
): { distribution: Distribution; can_self_update: boolean } {
  if (devMode) return { distribution: "source", can_self_update: false };
  const distribution: Distribution = /\/Cellar\/|\/homebrew\//i.test(execPath) ? "brew" : /\/node_modules\//.test(execPath) ? "npm" : "installer";
  const dir = execPath.slice(0, Math.max(execPath.lastIndexOf("/"), 1));
  return { distribution, can_self_update: writable(dir) && !managed(execPath) };
}

export function updateRecentlyFailed(version: string): boolean {
  return updater.updateRecentlyFailed(version);
}

export function recordUpdateFailure(version: string): void {
  updater.recordUpdateFailure(version);
}

/** Printed where an update was asked for on a managed install. */
export const MANAGED_UPDATE_NOTE = `cast was installed by your organization (${process.execPath}); it updates when your MDM installs a newer Codecast.pkg.`;

export async function performUpdate(): Promise<{ success: boolean; error?: string }> {
  // A root-owned binary (Codecast.pkg from an MDM) is not this user's to
  // replace; the organization ships the next version (managedInstall.ts).
  if (!isDevMode() && isManagedInstall()) {
    console.error(MANAGED_UPDATE_NOTE);
    return { success: false, error: "managed_install" };
  }
  const result = await updater.performUpdate();
  // Callers print their own "Update failed" line without the reason, so name it
  // here. Dev mode is a refusal, not a failure, and stays quiet.
  if (!result.success && result.error && result.error !== "dev_mode") {
    console.error("Update failed:", result.error);
  }
  return { success: result.success, error: result.error };
}

export function ensureCastAlias(): void {
  updater.ensureAlias();
}

export function showUpdateNotice(availableVersion: string): void {
  updater.showUpdateNotice(availableVersion);
}
