/**
 * Naming a machine on the command line: a device id prefix, or a substring of
 * its label or hostname. Shared by `cast devices` and `cast migrate`, so every
 * verb that takes a machine reads a name the same way.
 */
import { deviceDisplayName } from "@codecast/shared/contracts";

export interface NamedDevice {
  device_id: string;
  label?: string | null;
  hostname?: string | null;
  platform?: string;
  is_remote?: boolean;
  online?: boolean;
  /** A name a person set. Matched on its own and as the name the list prints. */
  display_name?: string | null;
  cloud_host?: { name?: string | null } | null;
}

function shownName(d: NamedDevice): string {
  return deviceDisplayName({
    label: d.label ?? "",
    platform: d.platform ?? "",
    is_remote: d.is_remote,
    display_name: d.display_name,
    cloud_host: d.cloud_host,
  });
}

/** Every device the needle names. An exact id, label, or shown name wins
 *  outright, so a name that is a substring of another ("Mac-mini" vs
 *  "Mac-mini 2") stays reachable. */
export function matchDevices<T extends NamedDevice>(devices: T[], needle: string): T[] {
  const n = needle.trim().toLowerCase();
  if (!n) return [];
  const exact = devices.filter((d) =>
    d.device_id.toLowerCase() === n ||
    String(d.label ?? "").toLowerCase() === n ||
    String(d.display_name ?? "").trim().toLowerCase() === n ||
    shownName(d).toLowerCase() === n);
  if (exact.length) return exact;
  return devices.filter((d) =>
    d.device_id.toLowerCase().startsWith(n) ||
    String(d.label ?? "").toLowerCase().includes(n) ||
    String(d.display_name ?? "").toLowerCase().includes(n) ||
    String(d.hostname ?? "").toLowerCase().includes(n) ||
    shownName(d).toLowerCase().includes(n) ||
    (n === "cloud" && !!d.is_remote));
}

/** One line naming a device in a list: short id, name, cloud and offline marks. */
export function deviceLine(d: NamedDevice): string {
  return `${d.device_id.slice(0, 8)}  ${deviceDisplayName(d as any)}${d.is_remote ? " (cloud)" : ""}${d.online === false ? "  offline" : ""}`;
}

/** The one device the needle names, or a message naming why not and what does match. */
export function pickDevice<T extends NamedDevice>(devices: T[], needle: string, what = "device"): { device: T } | { error: string } {
  const matches = matchDevices(devices, needle);
  if (matches.length === 1) return { device: matches[0] };
  const head = matches.length === 0
    ? `no ${what} matches "${needle}"`
    : `${what} "${needle}" matches ${matches.length} machines; be more specific:`;
  return { error: [head, ...(matches.length ? matches : devices).map((d) => `  ${deviceLine(d)}`)].join("\n") };
}
