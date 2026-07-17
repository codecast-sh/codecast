/**
 * Device identity for codecast.
 *
 * Every machine running codecast has a stable device_id. We derive it from
 * the existing ~/.codecast/.machine_key (already created for token
 * encryption) rather than introducing a new identity file — same lifetime,
 * same 0600 secrecy, survives hostname renames.
 *
 * One failure mode of a file-derived identity: Migration Assistant (or any
 * disk copy of ~/.codecast) duplicates the key, so two machines compute the
 * SAME device_id and every conversation-ownership guard passes on both —
 * duplicate replies and split-brain transcripts. Two independent guards catch
 * this: machineKey.ts rotates the key itself when its hardware sidecar
 * mismatches (splitting identity at the root, token decryption kept via the
 * prev-key chain), and .device_binding.json records the hardware UUID the
 * device id belongs to — on a mismatch the clone mints its own id; the
 * original machine keeps the identity, so nothing in Convex moves.
 *
 * The remote Mac is "just another device": once it has a device_id and a
 * daemon, a session owned by that device is indistinguishable from a local
 * session except for which machine runs it.
 */

import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getMachineKey, hardwareId } from "../machineKey.js";

const DEVICE_BINDING_FILE = path.join(os.homedir(), ".codecast", ".device_binding.json");
const CONFIG_FILE = path.join(os.homedir(), ".codecast", "config.json");

let cachedDeviceId: string | null = null;
let cachedHostname: string | null = null;
let cachedLabel: string | null = null;

/** Which hardware a device identity belongs to. Persisted as .device_binding.json. */
export interface DeviceBinding {
  hw: string;
  id: string;
}

/**
 * Pure identity policy (no I/O), so every branch is testable.
 *
 * - No hardware UUID available → trust whatever identity exists (binding or
 *   legacy derivation); don't write a binding we can't verify later.
 * - No binding yet → first run on this code: adopt the legacy id as-is and
 *   record the hardware it lives on. Nothing changes for existing machines.
 * - Binding matches this hardware → normal restart, keep the id.
 * - Binding names OTHER hardware → ~/.codecast was disk-copied here
 *   (Migration Assistant). Mint a fresh id for this machine; the source
 *   machine keeps the original identity and its conversation ownership.
 *
 * Known gap, accepted: the binding file is the only record that a machine is
 * a clone. Delete it (while .machine_key survives) and the next start
 * re-adopts the shared legacy id — the pre-fix behavior. There is no other
 * durable local place to keep that record, and grandfathering existing ids
 * requires adopting when no binding exists.
 */
export function resolveDeviceIdentity(deps: {
  hardwareUUID: string;
  legacyId: string;
  binding: DeviceBinding | null;
  deriveCloneId: (hw: string) => string;
}): { id: string; persist: DeviceBinding | null } {
  const { hardwareUUID: hw, legacyId, binding, deriveCloneId } = deps;
  if (!hw) return { id: binding?.id ?? legacyId, persist: null };
  if (!binding) return { id: legacyId, persist: { hw, id: legacyId } };
  if (binding.hw === hw) return { id: binding.id, persist: null };
  const id = deriveCloneId(hw);
  return { id, persist: { hw, id } };
}

/**
 * Stable, opaque device id (16 hex chars) derived from the machine key
 * (machineKey.ts — hardware-bound, rotates when the key file was cloned onto
 * different hardware, e.g. by Migration Assistant) and additionally bound to
 * this hardware via .device_binding.json (see resolveDeviceIdentity). Falls
 * back to a hostname/platform/home hash if the key can't be read or created
 * (mirrors tokenEncryption's legacyMachineId so we never throw here).
 */
export function deviceId(): string {
  if (cachedDeviceId) return cachedDeviceId;
  let seed: Buffer | string;
  try {
    seed = getMachineKey().secret;
  } catch {
    seed = `${os.hostname()}:${os.platform()}:${os.homedir()}`;
  }
  const derive = (domain: string, extra = "") =>
    crypto
      .createHash("sha256")
      .update(seed)
      .update(extra)
      .update(domain) // domain-separate from token encryption
      .digest("hex")
      .slice(0, 16);
  const { id, persist } = resolveDeviceIdentity({
    hardwareUUID: hardwareId(),
    legacyId: derive("codecast-device-id-v1"),
    binding: readDeviceBinding(),
    deriveCloneId: (hw) => derive("codecast-device-id-v2", hw),
  });
  if (persist) writeDeviceBinding(persist);
  cachedDeviceId = id;
  return id;
}

function readDeviceBinding(): DeviceBinding | null {
  try {
    const b = JSON.parse(fs.readFileSync(DEVICE_BINDING_FILE, "utf8"));
    if (typeof b?.hw === "string" && typeof b?.id === "string" && b.hw && b.id) {
      return { hw: b.hw, id: b.id };
    }
  } catch {}
  return null;
}

function writeDeviceBinding(binding: DeviceBinding): void {
  try {
    fs.writeFileSync(DEVICE_BINDING_FILE, JSON.stringify(binding), { mode: 0o600 });
    fs.chmodSync(DEVICE_BINDING_FILE, 0o600); // mode option only applies at creation
  } catch {} // identity must never throw; worst case we re-adopt next start
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

/**
 * Human-readable label, e.g. "macOS - Ashots-MacBook", or an explicit name when
 * one is set.
 *
 * The derived form is right for a personal machine whose hostname is already a
 * name a human chose. It is wrong for a provisioned box: a Scaleway Mac's
 * hostname is its UUID, so it shows up everywhere as
 * "macOS - 36563bd2-ab96-4045-8aec-894b84a2f66c" — in the device chip, in
 * `cast remote hosts`, and in the reorientation notice a moved agent reads.
 * An explicit label replaces the whole string (not just the hostname half), so
 * a named machine reads as "Cloud Mac" rather than "macOS - Cloud Mac".
 *
 * Precedence: CODECAST_DEVICE_LABEL (one-off runs, launchd plists) then
 * config.json `device_label` (durable, survives restarts and reboots).
 * Cached like the hostname, so a change applies on the next daemon start.
 */
export function deviceLabel(): string {
  if (cachedLabel) return cachedLabel;
  cachedLabel = resolveDeviceLabel({
    platform: process.platform,
    override: process.env.CODECAST_DEVICE_LABEL ?? readConfiguredLabel(),
    hostname: stableHostname,
  });
  return cachedLabel;
}

/** Longest label we'll accept. Long enough for "MacBook Pro (work, Berlin)", short
 * enough that a device chip and a notice sentence stay readable. */
const MAX_LABEL_LENGTH = 64;

/**
 * Pure label policy (no I/O), mirroring resolveStableHostname so every branch is
 * testable.
 *
 * The override is sanitized rather than trusted: this label is interpolated into
 * the prose a moved agent reads ("This session now runs on <label>"), so a
 * newline in it could forge an extra line of that notice. Collapsing whitespace
 * and capping the length keeps a hand-edited config from becoming a way to write
 * arbitrary lines into an agent's context. A blank/whitespace-only override
 * falls through to the derived name rather than yielding an empty label.
 */
export function resolveDeviceLabel(deps: {
  platform: NodeJS.Platform;
  override?: string;
  hostname: () => string;
}): string {
  const override = sanitizeLabel(deps.override);
  if (override) return override;
  const name =
    deps.platform === "darwin" ? "macOS" : deps.platform === "win32" ? "Windows" : "Linux";
  return `${name} - ${deps.hostname()}`;
}

/** Collapse all whitespace (incl. newlines) to single spaces, trim, cap length. */
export function sanitizeLabel(raw: string | undefined): string {
  return (raw ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_LABEL_LENGTH);
}

/** `device_label` from ~/.codecast/config.json, or "" when unset/unreadable. */
function readConfiguredLabel(): string {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
    return typeof cfg?.device_label === "string" ? cfg.device_label : "";
  } catch {
    return "";
  }
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
