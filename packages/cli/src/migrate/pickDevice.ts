/** The subset of a `devices.listDevices` row that device selection reads. */
export interface PickableDevice {
  device_id: string;
  label?: string | null;
  hostname?: string | null;
  is_remote?: boolean;
}

/**
 * Devices a `--to` / `--from` argument names: a device id prefix, a label or
 * hostname substring, or `cloud` for every cloud host. Case-insensitive. An exact
 * label or hostname wins over substring matches, so `--to mac` still reaches a
 * device labelled exactly "mac" when "macbook" exists.
 */
export function matchDevices<D extends PickableDevice>(devices: D[], needle: string): D[] {
  const n = needle.toLowerCase();
  const matches = devices.filter((d) =>
    d.device_id.toLowerCase().startsWith(n) ||
    String(d.label ?? "").toLowerCase().includes(n) ||
    String(d.hostname ?? "").toLowerCase().includes(n) ||
    (n === "cloud" && d.is_remote));
  if (matches.length < 2) return matches;
  const exact = matches.filter((d) => String(d.label ?? "").toLowerCase() === n || String(d.hostname ?? "").toLowerCase() === n);
  return exact.length === 1 ? exact : matches;
}
