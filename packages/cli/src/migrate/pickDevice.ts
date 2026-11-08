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

/** A machine someone else runs, as `devices.listAgentBoxes` answers it. */
export interface TeamMachine extends PickableDevice { runner_name?: string | null; is_bot?: boolean; bot_name?: string | null }

/** Whose machine a needle names when it names none of yours, or null. */
export function teammateMachineLine(team: TeamMachine[], needle: string, what: string): string | null {
  const hit = matchDevices(team, needle);
  if (hit.length !== 1) return null;
  const d = hit[0];
  const whose = d.is_bot ? `a team agent box${d.bot_name ? ` (${d.bot_name})` : ""}` : `${d.runner_name ?? "a teammate"}'s machine`;
  return `${what} "${needle}" is ${whose}, ${d.label || d.hostname || d.device_id.slice(0, 8)}, not one of yours: ${what} takes a machine of yours (cast devices ls)`;
}

/**
 * pickDevice over your own machines, and on a miss, a check of the team's
 * machines so a teammate's machine reads as theirs rather than as missing.
 * `teamMachines` runs only on a miss.
 */
export async function pickOwnDevice<D extends PickableDevice & { online?: boolean }>(devices: D[], needle: string, what: string, teamMachines: () => Promise<TeamMachine[]>): Promise<D> {
  if (matchDevices(devices, needle).length === 0) {
    const line = teammateMachineLine(await teamMachines().catch(() => []), needle, what);
    if (line) { console.error(line); process.exit(1); }
  }
  return pickDevice(devices, needle, what);
}
