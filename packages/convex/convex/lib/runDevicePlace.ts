// Where a run placed on a named machine works (`cast flow run --device`,
// ct-98920): the whole run (its runner, its worktree, every station) goes to
// one of the caller's own machines, in that machine's checkout of the same
// repository. The repository is named by its origin; the target's checkout is
// the one its git plane (or its line slot) reports for that origin, so a path
// on the laptop (/Users/me/code/repo) becomes the box's (/home/me/code/repo).
// Only the caller's own machines, and only while online: an offline one is
// refused with why, never swapped for another.
import { deviceDisplayName, normalizeGitOrigin } from "@codecast/shared/contracts";
import { compareVersions } from "@codecast/shared/contracts/orgTemplateManifest";
import { isDeviceOnline } from "../ccAccountsShared";

/** The first cast whose `workflow run-daemon` fetches a placed run's change (cli workflow/placedChange.ts). An older
 *  daemon would run the placed run in its plain checkout, without the change, so it takes none. */
export const PLACED_RUN_MIN_CLI = "1.1.255";

type PlaceDevice = {
  device_id: string;
  label?: string | null;
  display_name?: string | null;
  hostname?: string | null;
  last_seen: number;
  cli_version?: string | null;
  version?: string | null;
  git_plane?: ReadonlyArray<{ root: string; origin?: string | null }> | null;
  line_slots?: ReadonlyArray<{ root: string; origin?: string | null }> | null;
};

/** A machine's name as people read it; a row with no label yet reads by its id. */
export const placeName = (row: PlaceDevice): string => (row.label ? deviceDisplayName(row as any) : row.display_name?.trim() || row.device_id.slice(0, 8));

export type DevicePlace = { device: string; project_path: string; row: PlaceDevice } | { refusal: string };

/**
 * The run's place on `target` (a device id of the caller's), given the caller's own devices, the folder the run was
 * asked from and that folder's origin. The asking machine keeps its folder; any other takes its checkout of the origin.
 */
export function placeRunOnDevice(o: {
  devices: ReadonlyArray<PlaceDevice>;
  target: string;
  asker?: string | null;
  project_path?: string | null;
  origin?: string | null;
  now: number;
}): DevicePlace {
  const row = o.devices.find((d) => d.device_id === o.target);
  if (!row) return { refusal: `${o.target} is not one of your machines (cast devices ls lists them)` };
  const name = placeName(row);
  if (!isDeviceOnline(row, o.now)) return { refusal: `${name} is offline, so the run cannot start there: bring its daemon back, or run with --device here` };
  if (o.asker && o.asker === o.target && o.project_path) return { device: row.device_id, project_path: o.project_path, row };
  const cli = row.cli_version || row.version;
  if (!cli || !/^\d+\.\d+\.\d+$/.test(cli) || compareVersions(cli, PLACED_RUN_MIN_CLI) < 0) {
    return { refusal: `${name} runs cast ${cli || "of an unknown version"}, and a run placed there needs ${PLACED_RUN_MIN_CLI} or later: update it (cast update there, or its Update button in Settings), then run this again` };
  }
  const origin = o.origin ? normalizeGitOrigin(o.origin) : null;
  if (!origin) return { refusal: `the run's folder names no git origin, so ${name} cannot find its checkout of it` };
  const same = (c: { origin?: string | null }) => !!c.origin && normalizeGitOrigin(c.origin) === origin;
  // A line slot is a checkout the machine offers for runs; any checkout its git plane reports will do after it.
  const checkout = (row.line_slots ?? []).find(same) ?? (row.git_plane ?? []).find(same);
  if (!checkout) return { refusal: `${name} has no checkout of ${origin}: clone it there, then run this again` };
  return { device: row.device_id, project_path: checkout.root.replace(/\/+$/, "") || "/", row };
}
