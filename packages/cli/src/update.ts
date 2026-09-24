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
import pkg from "../package.json";
import { defaultConfigDir } from "./config/configDir.js";

export * from "./snippetVersions.js";

const VERSION = pkg.version;
const CONFIG_DIR = defaultConfigDir();

export const RELEASE_BASE_URL = "https://dl.codecast.sh";

/** The Apple team every darwin release is signed by (CI and the laptop path). */
export const DARWIN_SIGNING_TEAM = "WRG9THCK9Q";

/**
 * Public keys that may vouch for latest.json, by key id. Empty until a release
 * signing key exists: with no keys the updater checks nothing and asks for
 * nothing, which is exactly how every client in the field behaves today. The
 * rollout (pin a key here, then sign in CI, then flip `required`) is written
 * up in docs/architecture/release-signing.md.
 */
export const RELEASE_MANIFEST_SIGNING: ManifestSigningPolicy = { keys: {}, required: false };

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
  const teamOf = (binary: string): string | null => {
    const r = spawn("/usr/bin/codesign", ["-dv", "--", binary], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 30000 });
    if (r.status !== 0) return null;
    return /^TeamIdentifier=(\S+)$/m.exec(`${r.stdout ?? ""}\n${r.stderr ?? ""}`)?.[1] ?? null;
  };
  return async (binary: string): Promise<{ ok: boolean; reason?: string }> => {
    if (platform !== "darwin") return { ok: true };
    if (teamOf(execPath) !== DARWIN_SIGNING_TEAM) return { ok: true };
    const verify = spawn("/usr/bin/codesign", ["--verify", "--strict", "--", binary], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 60000 });
    if (verify.status !== 0) return { ok: false, reason: "invalid" };
    if (teamOf(binary) !== DARWIN_SIGNING_TEAM) return { ok: false, reason: "wrong_team" };
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

export function getVersion(): string {
  return VERSION;
}

export async function checkForUpdates(force = false): Promise<string | null> {
  return updater.checkForUpdates(force);
}

export function isDevMode(): boolean {
  return updater.isDevMode();
}

export function updateRecentlyFailed(version: string): boolean {
  return updater.updateRecentlyFailed(version);
}

export function recordUpdateFailure(version: string): void {
  updater.recordUpdateFailure(version);
}

export async function performUpdate(): Promise<{ success: boolean; error?: string }> {
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
