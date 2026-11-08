/**
 * The simulator settings agents reached past `cast sim` for, as simctl
 * arguments: the status bar (`simctl status_bar`), privacy grants
 * (`simctl privacy`) and screen recording (`simctl io recordVideo`). Pure
 * builders, so the command layer (cli.ts) only runs them.
 */

/** A status bar as App Store screenshots show it: 9:41, full bars, full battery. */
export const CLEAN_STATUS_BAR = {
  time: "9:41",
  dataNetwork: "wifi",
  wifiMode: "active",
  wifiBars: "3",
  cellularMode: "active",
  cellularBars: "4",
  batteryState: "charged",
  batteryLevel: "100",
} as const;

export interface StatusBarOptions {
  time?: string;
  battery?: string;
  network?: string;
  wifi?: string;
  cell?: string;
  carrier?: string;
}

const NETWORKS = ["hide", "wifi", "3g", "4g", "lte", "lte-a", "lte+", "5g", "5g+", "5g-uwb", "5g-uc"];

function inRange(v: string, max: number): boolean {
  return /^\d+$/.test(v) && Number(v) <= max;
}

/** `simctl status_bar <udid> override …` for the clean bar with the given
 *  values on top, or the problem with a value. */
export function statusBarArgs(udid: string, o: StatusBarOptions): { args: string[] } | { error: string } {
  if (o.battery !== undefined && !inRange(o.battery, 100)) return { error: `--battery is 0-100, not '${o.battery}'` };
  if (o.wifi !== undefined && !inRange(o.wifi, 3)) return { error: `--wifi is 0-3 bars, not '${o.wifi}'` };
  if (o.cell !== undefined && !inRange(o.cell, 4)) return { error: `--cell is 0-4 bars, not '${o.cell}'` };
  if (o.network !== undefined && !NETWORKS.includes(o.network)) return { error: `--network is one of ${NETWORKS.join(", ")}` };
  const v: Record<string, string> = {
    ...CLEAN_STATUS_BAR,
    ...(o.time !== undefined ? { time: o.time } : {}),
    ...(o.battery !== undefined ? { batteryLevel: o.battery, batteryState: o.battery === "100" ? "charged" : "discharging" } : {}),
    ...(o.network !== undefined ? { dataNetwork: o.network } : {}),
    ...(o.wifi !== undefined ? { wifiBars: o.wifi } : {}),
    ...(o.cell !== undefined ? { cellularBars: o.cell } : {}),
    ...(o.carrier !== undefined ? { operatorName: o.carrier } : {}),
  };
  return { args: ["status_bar", udid, "override", ...Object.entries(v).flatMap(([k, val]) => [`--${k}`, val])] };
}

/** What `simctl privacy` can grant. The camera is not among them: the
 *  simulator has no camera to grant. */
export const PRIVACY_SERVICES = [
  "all", "calendar", "contacts-limited", "contacts", "location", "location-always", "photos-add", "photos",
  "media-library", "microphone", "motion", "reminders", "siri",
];

/** The names agents write, in simctl's spelling. */
const SERVICE_ALIASES: Record<string, string> = { photo: "photos", mic: "microphone", contact: "contacts", calendars: "calendar", music: "media-library" };

/** The services as simctl names them, or the first unknown one. */
export function privacyServices(names: string[]): { services: string[] } | { error: string } {
  const services: string[] = [];
  for (const raw of names) {
    const name = SERVICE_ALIASES[raw.toLowerCase()] ?? raw.toLowerCase();
    if (!PRIVACY_SERVICES.includes(name)) {
      return { error: name === "camera" ? "the simulator has no camera, so there is no camera permission to grant" : `no privacy service '${raw}'` };
    }
    services.push(name);
  }
  return { services };
}
