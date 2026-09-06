export type FleetCounts = { live: number; hibernated: number; at: number };

export function countTrackedFleet(tracked: Iterable<string>, parked: ReadonlySet<string>, now: number): FleetCounts {
  let live = 0;
  let hibernated = 0;
  for (const id of tracked) {
    if (parked.has(id)) hibernated++;
    else live++;
  }
  return { live, hibernated, at: now };
}

export function fleetCountText(counts: Partial<FleetCounts> | null | undefined, key: "live" | "hibernated", now = Date.now()): string {
  const value = counts?.[key];
  if (!counts?.at || now - counts.at > 90_000 || typeof value !== "number" || !Number.isInteger(value) || value < 0) return "unknown";
  return String(value);
}
