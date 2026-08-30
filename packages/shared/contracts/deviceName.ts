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
export type DeviceNameSource = {
  label: string;
  platform: string;
  is_remote?: boolean;
};

const OS_PREFIX = /^(macOS|Linux|Windows)\s*-\s*/i;

/** AWS derives "ip-A-B-C-D" from the private IPv4; nobody picked that name. */
const AWS_AUTO_HOSTNAME = /^ip-\d{1,3}(?:-\d{1,3}){3}(?:\.|$)/i;

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
  if (d.is_remote && /linux/i.test(d.platform)) return "Cloud Linux";
  if (d.is_remote) return "Remote Mac";
  const host = d.label.replace(OS_PREFIX, "");
  if (AWS_AUTO_HOSTNAME.test(host)) return `AWS ${deviceKindLabel(d)}`;
  // "MacBook-Pro-4.local" → "MacBook-Pro-4"
  const stripped = host.replace(/\.local$/i, "").replace(/\.([a-z0-9-]+\.)*(compute\.)?internal$/i, "");
  return stripped || d.label;
}
