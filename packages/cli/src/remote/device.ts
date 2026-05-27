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

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const MACHINE_KEY_FILE = path.join(os.homedir(), ".codecast", ".machine_key");

let cachedDeviceId: string | null = null;

/**
 * Stable, opaque device id (16 hex chars) derived from the machine key.
 * Falls back to a hostname/platform/home hash if the key file is absent
 * (mirrors tokenEncryption's legacyMachineId so we never throw here).
 */
export function deviceId(): string {
  if (cachedDeviceId) return cachedDeviceId;
  let seed: Buffer | string;
  try {
    seed = fs.readFileSync(MACHINE_KEY_FILE);
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

/** Human-readable label, e.g. "macOS - Ashots-MacBook". */
export function deviceLabel(): string {
  const platform = process.platform;
  const name =
    platform === "darwin" ? "macOS" : platform === "win32" ? "Windows" : "Linux";
  return `${name} - ${os.hostname()}`;
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
