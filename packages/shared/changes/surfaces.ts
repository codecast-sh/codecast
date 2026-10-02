// Surfaces and the moments they ship (docs/proposals/changes-page.md 7.3). A
// surface is a product that goes out on its own clock; a story is "shipped in"
// the first release after its last commit whose surface covers the story's
// area. Surfaces are detected from signals, never configured.
import { areaOf, isRestamp, parseRelease } from "./classify";
import { onDefaultBranch } from "./dedupe";
import type { ChangeCommit, ReleaseBurst, ShipEvent } from "./types";

/** Default path map. A surface covers the areas of its paths. */
export const SURFACE_PATHS: Record<string, readonly string[]> = {
  cli: ["packages/cli/", "packages/shared/"],
  desktop: ["packages/electron/", "packages/web/", "packages/shared/"],
  backend: ["packages/convex/"],
  web: ["packages/web/", "packages/shared/"],
  extension: ["packages/browser-extension/", "packages/chrome-extension/"],
};

/** The catch-all surface for a team whose releases name no mapped surface; it covers every area. */
export const RELEASE_SURFACE = "release";

const SURFACE_AREAS: Record<string, ReadonlySet<string>> = Object.fromEntries(
  Object.entries(SURFACE_PATHS).map(([s, paths]) => [s, new Set(paths.map((p) => areaOf(`${p}x`)))]),
);

/** Whether a surface ships changes in this area. An unmapped surface covers everything. */
export function surfaceCoversArea(surface: string, area: string): boolean {
  const areas = SURFACE_AREAS[surface];
  return areas ? areas.has(area) : true;
}

/** Surfaces with at least one ship in the window (spec 7.3: one signal in 30 days). */
export function detectSurfaces(ships: readonly ShipEvent[], since: number): string[] {
  return [...new Set(ships.filter((s) => s.at >= since).map((s) => s.surface))].sort();
}

/** Release commits within this gap of the previous one form one burst. */
export const BURST_GAP_MS = 10 * 60 * 1000;

/**
 * Group the default branch's release commits into bursts, and fold each
 * restamp into the burst whose nearest release is within the gap. Returns the
 * bursts, oldest first, and every sha they absorbed, so clustering skips them.
 */
export function releaseBursts(commits: readonly ChangeCommit[], defaultBranch: string): { bursts: ReleaseBurst[]; absorbed: Set<string> } {
  const onMain = commits.filter((c) => onDefaultBranch(c, defaultBranch));
  const releases = onMain
    .map((c) => ({ c, r: parseRelease(c.subject) }))
    .filter((x): x is { c: ChangeCommit; r: NonNullable<ReturnType<typeof parseRelease>> } => !!x.r)
    .sort((a, b) => a.c.timestamp - b.c.timestamp || a.c.sha.localeCompare(b.c.sha));
  const bursts: ReleaseBurst[] = [];
  for (const { c, r } of releases) {
    const ship: ShipEvent = { surface: r.surface, version: r.version, sha: c.sha, at: c.timestamp, kind: "release" };
    const last = bursts[bursts.length - 1];
    if (last && c.timestamp - last.last_at <= BURST_GAP_MS) {
      last.shas.push(c.sha);
      last.releases.push(ship);
      last.last_at = c.timestamp;
    } else {
      bursts.push({ shas: [c.sha], releases: [ship], first_at: c.timestamp, last_at: c.timestamp });
    }
  }
  for (const c of onMain) {
    if (!isRestamp(c.subject)) continue;
    let best: ReleaseBurst | null = null;
    let bestGap = Infinity;
    for (const b of bursts) {
      for (const s of b.releases) {
        const gap = Math.abs(s.at - c.timestamp);
        if (gap <= BURST_GAP_MS && gap < bestGap) {
          best = b;
          bestGap = gap;
        }
      }
    }
    if (!best) continue;
    best.shas.push(c.sha);
    best.first_at = Math.min(best.first_at, c.timestamp);
    best.last_at = Math.max(best.last_at, c.timestamp);
  }
  return { bursts, absorbed: new Set(bursts.flatMap((b) => b.shas)) };
}

/** The first ship after `lastAt` whose surface covers the area, or null. Ties go to the surface name. */
export function assignRelease(area: string, lastAt: number, ships: readonly ShipEvent[]): ShipEvent | null {
  let best: ShipEvent | null = null;
  for (const s of ships) {
    if (s.at < lastAt || !surfaceCoversArea(s.surface, area)) continue;
    if (!best || s.at < best.at || (s.at === best.at && s.surface < best.surface)) best = s;
  }
  return best;
}

/** The latest ship per surface. */
export function latestShips(ships: readonly ShipEvent[]): Record<string, ShipEvent> {
  const out: Record<string, ShipEvent> = {};
  for (const s of ships) if (!out[s.surface] || s.at > out[s.surface].at) out[s.surface] = s;
  return out;
}

/** Stories on the default branch in this surface's areas that landed after the ship: the tile's "N waiting". */
export function waitingStories<S extends { area: string; last_at: number; on_default_branch: boolean }>(stories: readonly S[], ship: ShipEvent): S[] {
  return stories.filter((s) => s.on_default_branch && s.last_at > ship.at && surfaceCoversArea(ship.surface, s.area));
}
