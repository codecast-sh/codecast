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
import * as path from "node:path";
import {
  createUpdater,
  isBelowMinimum,
  type DownloadOptions,
  type Updater,
  type UpdaterConfig,
} from "@platform/cli-kit/update";
import { execFileSync, spawnSync } from "./proc.js";
import { DARWIN_SIGNING_TEAM, RELEASE_BASE_URL, RELEASE_MANIFEST_SIGNING } from "./releaseTrust.js";
import { getVersion } from "./cliVersion.js";
import { defaultConfigDir } from "./config/configDir.js";
import { isManagedInstall } from "./managedInstall.js";

export * from "./snippetVersions.js";
export { getVersion };

const VERSION = getVersion();
const CONFIG_DIR = defaultConfigDir();

export { DARWIN_SIGNING_TEAM, RELEASE_BASE_URL, RELEASE_MANIFEST_SIGNING };

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

/** performUpdate's error when it skipped the round because another process
 *  is updating this install (updateRetry.ts exclusiveUpdate). */
export const UPDATE_IN_PROGRESS = "update_in_progress";

/**
 * Whether a machine below its floor waits instead of installing: it already
 * runs the release latest.json names (or a newer one). An install would put
 * the same binary back and restart the daemon, which finds itself still below
 * the floor and does it again on every check (a floor set above every
 * published release, ct-102483). It waits until latest.json moves. `latest`
 * null (unread): install, and the install says why it failed.
 */
export function forcedUpdateWaits(current: string, latest: string | null): boolean {
  return latest !== null && !isBelowMinimum(current, latest);
}

export const UPDATE_DEFER_RETRY_MS = 60_000;
export const UPDATE_DEFER_RETRIES = 5;

/**
 * Run the daemon's self update to an outcome: null when it installed, else
 * the failure the device row shows. Another process installing this install
 * (`cast update`, a command's background check) defers it, and the row stays
 * "installing" while it is tried again a minute later: that process may
 * install a release whose daemon build matches this one's, which restarts
 * nothing, so no later beat would answer the row. After UPDATE_DEFER_RETRIES
 * deferrals in a row it fails, saying why.
 */
export async function selfUpdateOutcome(
  perform: () => Promise<{ success: boolean; error?: string }>,
  opts: { at?: number; onDeferred?: (n: number) => void; wait?: (ms: number) => Promise<void> } = {},
): Promise<{ state: "failed"; error: string; at?: number } | null> {
  const wait = opts.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let deferred = 0; ; deferred++) {
    const result = await perform();
    if (result.success) return null;
    if (result.error !== UPDATE_IN_PROGRESS) return { state: "failed", error: String(result.error ?? "unknown error").slice(-500), at: opts.at };
    if (deferred >= UPDATE_DEFER_RETRIES) {
      const minutes = Math.round((UPDATE_DEFER_RETRIES * UPDATE_DEFER_RETRY_MS) / 60_000);
      return { state: "failed", error: `another updater (cast update, or a command's update check) held this install's update lock for ${minutes} minutes; press Retry, or run cast update on the machine`, at: opts.at };
    }
    opts.onDeferred?.(deferred + 1);
    await wait(UPDATE_DEFER_RETRY_MS);
  }
}

export async function performUpdate(): Promise<{ success: boolean; error?: string }> {
  // A root-owned binary (Codecast.pkg from an MDM) is not this user's to
  // replace; the organization ships the next version (managedInstall.ts).
  if (!isDevMode() && isManagedInstall()) {
    console.error(MANAGED_UPDATE_NOTE);
    return { success: false, error: "managed_install" };
  }
  if (isDevMode()) return { success: false, error: "dev_mode" };
  // Loaded here, off the boot graph: only an update needs it.
  const { exclusiveUpdate, updateWithRetry } = await import("./updateRetry.js");
  const result = await exclusiveUpdate(path.join(CONFIG_DIR, "update.lock"), () => updateWithRetry(() => updater.performUpdate()));
  // Callers print their own "Update failed" line without the reason, so name it
  // here. Dev mode is a refusal, not a failure, and stays quiet; so is a round
  // skipped because another updater is installing.
  if (!result.success && result.error && result.error !== "dev_mode" && result.error !== UPDATE_IN_PROGRESS) {
    console.error("Update failed:", result.error);
  }
  return { success: result.success, error: result.error };
}

export function ensureCastAlias(): void {
  updater.ensureAlias();
}

/** The "Run 'cast update'" notice, for a person at a terminal only: an agent's shell has no terminal, the daemon updates on its own, and an agent would only pass the command on to its person. */
export function showUpdateNotice(availableVersion: string, terminal = !!process.stderr.isTTY): void {
  if (!terminal) return;
  updater.showUpdateNotice(availableVersion);
}
