// Codecast's self update: one `Updater` from @platform/cli-kit/update plus the
// policy that is ours — where state lives, how a binary is downloaded, and the
// command a human types to update. The machine (version comparison, channel
// selection, manifest fetch, checksum verify, the swap and the alias) is the
// package's; nothing about it is codecast specific.
//
// Every function below keeps the signature it had when this file held the
// implementation, so callers (index.ts, daemon.ts, desktopUpdate.ts) are
// unchanged. The per-snippet version labels moved to ./snippetVersions.ts and
// are re-exported here for the same reason.

import { createUpdater } from "@platform/cli-kit/update";
import { execSync } from "./proc.js";
import pkg from "../package.json";

export * from "./snippetVersions.js";

const VERSION = pkg.version;
const CONFIG_DIR = process.env.HOME + "/.codecast";

export const updater = createUpdater({
  // Shown as "Downloading cast v1.2.3..." — the name a human types, which is
  // what they are waiting on.
  productName: "cast",
  binaryName: "codecast",
  aliasName: "cast",
  currentVersion: VERSION,
  releaseBaseUrl: "https://dl.codecast.sh",
  stateDir: CONFIG_DIR,
  updateCommand: "cast update",
  // curl streams to disk and works under launchd, where fetch is unreliable.
  download: async (url, dest) => {
    execSync(`curl -fsSL "${url}" -o "${dest}"`, { timeout: 180000, stdio: "ignore" });
  },
});

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
