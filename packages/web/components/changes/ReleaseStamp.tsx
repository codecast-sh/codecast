// The page's signature mark (spec 4.5): where a release lands between two
// stories of its surface, a perforated line through a centred mono pill. Its
// hover card lists the stories the release carried.
import type { StoryRow } from "../../hooks/useSyncChanges";
import { HoverCard } from "../ui/HoverCard";
import { RELEASE_COLOR } from "./areaColor";
import { clockOf } from "./StoryParts";
import type { Ship } from "./editionModel";

export const shipLabel = (s: Pick<Ship, "surface" | "version" | "sha">) => `${s.surface} ${s.version ?? s.sha.slice(0, 7)}`;

/** The stories a ship carried: their release names it. */
export function carriedBy(ship: Pick<Ship, "surface" | "sha">, stories: readonly StoryRow[]): StoryRow[] {
  return stories.filter((s) => s.release && s.release.surface === ship.surface && s.release.sha === ship.sha);
}

export function ShipCard({ ship, carried }: { ship: Ship; carried: readonly StoryRow[] }) {
  return (
    <div className="space-y-1.5 p-3">
      <p className="font-mono text-[11px] text-sol-text">
        {shipLabel(ship)} <span className="text-sol-text/50">at {clockOf(ship.at)}, {ship.sha.slice(0, 7)}</span>
      </p>
      {carried.length ? (
        <ul className="space-y-0.5">
          {carried.slice(0, 10).map((s) => (
            <li key={s.story_key} className="chg-ui truncate text-[12px] text-sol-text/80">{s.headline}</li>
          ))}
          {carried.length > 10 && <li className="font-mono text-[10px] text-sol-text/45">{carried.length - 10} more</li>}
        </ul>
      ) : (
        <p className="chg-ui text-[12px] text-sol-text/55">No story on this page names it as its release.</p>
      )}
    </div>
  );
}

/** The pill is a button, so the keyboard reaches the card that lists what the release carried. */
export function ReleaseStamp({ ship, stories }: { ship: Ship; stories: readonly StoryRow[] }) {
  return (
    <div className="flex items-center gap-2 py-1.5">
      <span aria-hidden className="chg-perf" />
      <HoverCard card={<ShipCard ship={ship} carried={carriedBy(ship, stories)} />} align="center" className="w-72" focusable>
        <button
          type="button"
          aria-label={`${shipLabel(ship)} shipped at ${clockOf(ship.at)}`}
          className="cursor-default rounded-full border px-2 py-[1px] font-mono text-[10px] tabular-nums text-sol-text/75"
          style={{ borderColor: RELEASE_COLOR }}
        >
          {shipLabel(ship)}, {clockOf(ship.at)}
        </button>
      </HoverCard>
      <span aria-hidden className="chg-perf" />
    </div>
  );
}
