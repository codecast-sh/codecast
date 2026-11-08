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

/**
 * The one device a CLI flag names (`cast migrate --to`, `cast trigger add
 * --device`). Exits listing the candidates when it names none or several.
 */
export function pickDevice<D extends PickableDevice & { online?: boolean }>(devices: D[], needle: string, what: string): D {
  const matches = matchDevices(devices, needle);
  if (matches.length === 1) return matches[0];
  console.error(matches.length === 0 ? `no device matches ${what} "${needle}"` : `${what} "${needle}" matches ${matches.length} devices; be more specific:`);
  for (const d of matches.length ? matches : devices) console.error(`  ${d.device_id.slice(0, 8)}  ${d.label ?? d.hostname ?? ""}${d.is_remote ? " (cloud)" : ""}${d.online ? "" : "  offline"}`);
  process.exit(1);
}
