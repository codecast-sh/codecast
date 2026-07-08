/**
 * Device identity for codecast.
 *
 * Every machine running codecast has a stable device_id. We derive it from
 * the existing ~/.codecast/.machine_key (already created for token
 * encryption) rather than introducing a new identity file — same lifetime,
 * same 0600 secrecy, survives hostname renames.
 *
 * The remote Mac is "just another device": once it has a device_id and a
 * daemon, a session owned by that device is indistinguishable from a local
 * session except for which machine runs it.
 */

import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as os from "node:os";
import { getMachineKey } from "../machineKey.js";

let cachedDeviceId: string | null = null;
let cachedHostname: string | null = null;

/**
 * Stable, opaque device id (16 hex chars) derived from the machine key
 * (machineKey.ts — hardware-bound, rotates when the key file was cloned onto
 * different hardware, e.g. by Migration Assistant). Falls back to a
 * hostname/platform/home hash if the key can't be read or created (mirrors
 * tokenEncryption's legacyMachineId so we never throw here).
 */
export function deviceId(): string {
  if (cachedDeviceId) return cachedDeviceId;
  let seed: Buffer | string;
  try {
    seed = getMachineKey().secret;
  } catch {
    seed = `${os.hostname()}:${os.platform()}:${os.homedir()}`;
  }
  cachedDeviceId = crypto
    .createHash("sha256")
    .update(seed)
    .update("codecast-device-id-v1") // domain-separate from token encryption
    .digest("hex")
    .slice(0, 16);
  return cachedDeviceId;
}

/**
 * True when this process runs on a remote box (the cloud Mac). A remote device
 * only serves conversations explicitly moved to it (owner == this device) — it
 * must never adopt, resume, or spawn sessions on its own. Set in the remote's
 * cron/launch environment by `cast remote` setup.
 */
export function isRemoteDevice(): boolean {
  return process.env.CODECAST_REMOTE_DEVICE === "1";
}

/**
 * The machine's stable name.
 *
 * On macOS, `os.hostname()` returns the *transient* kernel hostname, which the
 * OS silently overwrites with whatever name the network hands out — a DHCP
 * offer or a reverse-DNS lookup of the leased IP. Join a hotspot or share a LAN
 * with a phone that once held your IP and your Mac starts reporting itself as
 * "Xiaomi-12-Lite". The names macOS actually keeps for the machine survive
 * this, so prefer them: the admin-set HostName if present, otherwise the
 * Bonjour LocalHostName (derived from the Computer Name, never DHCP). Only fall
 * back to os.hostname() if scutil is unavailable. Cached — hostname is stable
 * for a process lifetime and the daemon restarts often enough.
 *
 * Linux/Windows keep os.hostname() — they don't adopt DHCP names this way.
 */
function stableHostname(): string {
  if (cachedHostname) return cachedHostname;
  cachedHostname = resolveStableHostname({
    platform: process.platform,
    osHostname: () => os.hostname(),
    scutil: scutilGet,
  });
  return cachedHostname;
}

/**
 * Pure name-resolution policy (no I/O), so every branch is testable. On macOS,
 * prefer the admin-set HostName, then the Bonjour LocalHostName; only the
 * transient os.hostname() is vulnerable to DHCP renaming, so it's the last
 * resort. Other platforms always use os.hostname().
 */
export function resolveStableHostname(deps: {
  platform: NodeJS.Platform;
  osHostname: () => string;
  scutil: (key: "HostName" | "LocalHostName") => string;
}): string {
  if (deps.platform !== "darwin") return deps.osHostname();
  return (
    deps.scutil("HostName") ||
    deps.scutil("LocalHostName") ||
    deps.osHostname()
  );
}

/** One scutil name field, or "" if unset/unavailable (e.g. HostName not set → exit 1). */
function scutilGet(key: "HostName" | "LocalHostName"): string {
  try {
    return execFileSync("/usr/sbin/scutil", ["--get", key], {
      encoding: "utf8",
      timeout: 2000,
      // HostName unset is the common case; scutil prints "HostName: not set"
      // and exits 1. Discard its stderr so that noise never reaches our logs.
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

/** Human-readable label, e.g. "macOS - Ashots-MacBook". */
export function deviceLabel(): string {
  const platform = process.platform;
  const name =
    platform === "darwin" ? "macOS" : platform === "win32" ? "Windows" : "Linux";
  return `${name} - ${stableHostname()}`;
}

/** Platform tag for the devices table. */
export function devicePlatform(): "darwin" | "linux" | "win32" | string {
  return process.platform;
}

export interface DeviceInfo {
  deviceId: string;
  label: string;
  platform: string;
}

export function deviceInfo(): DeviceInfo {
  return { deviceId: deviceId(), label: deviceLabel(), platform: devicePlatform() };
}
