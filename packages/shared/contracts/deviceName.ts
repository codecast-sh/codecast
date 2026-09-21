/**
 * How a device is named in every chip, badge and picker. Web and mobile share
 * this so the same machine never reads differently on two screens.
 *
 * A laptop's hostname is a name a human chose, so it stands on its own once the
 * "macOS - " prefix and the ".local" suffix are gone. A cloud box's hostname is
 * not: AWS stamps every instance with its private IP, as in
 * "ip-172-31-29-242.us-east-2.compute.internal", which no chip should show.
 * Those read by kind ("AWS Mac") instead. The owner avatar next to the chip
 * already says whose machine it is, so the kind is enough to tell it apart
 * from a laptop.
 */
import { deviceWakesOnUse } from "./cloudPlacement";

export type DeviceNameSource = {
  label: string;
  platform: string;
  is_remote?: boolean;
};

const OS_PREFIX = /^(macOS|Linux|Windows)\s*-\s*/i;

/** AWS derives "ip-A-B-C-D" from the private IPv4; nobody picked that name. */
const AWS_AUTO_HOSTNAME = /^ip-\d{1,3}(?:-\d{1,3}){3}(?:\.|$)/i;
const MAC_UUID_HOSTNAME = /^[0-9a-f]{8}-[0-9a-f]{4}(?:-[0-9a-f]{4}){0,2}(?:-[0-9a-f]{12})?$/i;

/** Grok cloud workers stamp the instance id into the hostname. Same class: not a name a person chose. */
const GROK_BOT_VM_HOSTNAME = /^grok-bot-vm[-_]/i;

/** A third-party agent-runtime host stamps this hostname; also not a name a person chose. */
const HTCH_RUNTIME_HOSTNAME = /^htch-runtime(?:[-_]|$)/i;

function hostnameFromLabel(label: string): string {
  return label.replace(OS_PREFIX, "");
}

/**
 * True when the hostname was assigned by the cloud, not chosen by a person.
 * Those boxes are remotes even if the daemon never set `is_remote` (a Linux
 * VM that heartbeats without CODECAST_REMOTE_DEVICE=1 still looks like this).
 */
export function isCloudAssignedHostname(label: string): boolean {
  const host = hostnameFromLabel(label);
  return AWS_AUTO_HOSTNAME.test(host) || GROK_BOT_VM_HOSTNAME.test(host) || HTCH_RUNTIME_HOSTNAME.test(host);
}

/**
 * A machine the viewer does not sit at: flagged remote, or a cloud-assigned
 * hostname that never got the flag. The global header chip must not speak
 * for these; the session that runs on the box may.
 */
export function isRemoteHost(d: { is_remote?: boolean | null; label?: string | null }): boolean {
  if (d.is_remote) return true;
  return !!d.label && isCloudAssignedHostname(d.label);
}

export function deviceKindLabel(d: DeviceNameSource): string {
  if (d.is_remote) return "Remote";
  if (/linux/i.test(d.platform)) return "Linux";
  // process.platform is "win32" — match that (or a friendly "Windows"), NOT a
  // bare "win", which the "win" inside "darwin" would falsely trip.
  if (/win32|windows/i.test(d.platform)) return "Windows";
  return "Mac";
}

/** A clean display name: cloud boxes by kind, hostname for a laptop/desktop. */
export function deviceDisplayName(d: DeviceNameSource | undefined | null): string {
  if (!d) return "Unknown device";
  // The same predicate that decides "this machine boots when work arrives",
  // so the name and the placement rule cannot diverge.
  if (deviceWakesOnUse(d) && /linux/i.test(d.platform)) return "Cloud Linux";
  const host = hostnameFromLabel(d.label);
  if (d.is_remote && (!host.trim() || isCloudAssignedHostname(d.label) || MAC_UUID_HOSTNAME.test(host.replace(/\.local$/i, "")))) return deviceWakesOnUse(d) ? "Cloud Mac" : "Remote Mac";
  if (AWS_AUTO_HOSTNAME.test(host)) return `AWS ${deviceKindLabel(d)}`;
  // "MacBook-Pro-4.local" → "MacBook-Pro-4"
  const stripped = host.replace(/\.local$/i, "").replace(/\.([a-z0-9-]+\.)*(compute\.)?internal$/i, "");
  return stripped || d.label;
}
