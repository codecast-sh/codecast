// What is live right now (spec 4.2): one tile per surface with a release
// signal in the last 30 days. Each tile names its version (or short sha for a
// deploy), when it shipped, and how many stories wait behind it. A surface the
// repository builds but never reports a deploy for says "no signal yet",
// never a guessed version. Clicking a tile filters the page to its areas.
import { memo, useRef } from "react";
import type { LiveRow } from "../../hooks/useSyncChanges";
import { formatDateSmart } from "../../lib/utils";
import { HoverCard } from "../ui/HoverCard";
import { areaColor, areaFill, RISK_HATCH } from "./areaColor";
import { ShipCard } from "./ReleaseStamp";
import { Tip } from "./StoryParts";
import { useAreaColors } from "./storyContext";

export type LiveTile =
  | { kind: "ship"; row: LiveRow; risk: string | null }
  | { kind: "silent"; surface: string };

/** Whether `value` changed while the component was mounted, and is still the changed value. */
function useChangedSinceMount(value: string | null): boolean {
  const seen = useRef(value);
  const changed = useRef<string | null>(null);
  if (seen.current !== value) {
    changed.current = value;
    seen.current = value;
  }
  return value !== null && changed.current === value;
}

function Tile({ tile, active, onPick }: { tile: LiveTile; active: boolean; onPick: (surface: string) => void }) {
  const surface = tile.kind === "ship" ? tile.row.surface : tile.surface;
  const ship = tile.kind === "ship" ? tile.row : null;
  const label = ship ? ship.version ?? ship.sha.slice(0, 7) : null;
  // A new ship while the page is open rolls its version in and pulses the border once.
  const fresh = useChangedSinceMount(label);
  const colors = useAreaColors();
  const body = (
    <button
      type="button"
      onClick={() => onPick(surface)}
      aria-pressed={active}
      className="relative block w-full overflow-hidden rounded-md border border-sol-border/25 bg-sol-card px-3 pb-2.5 pt-3 text-left shadow-sm transition-colors hover:border-sol-border/50"
      style={active ? { background: areaFill(surface, 10, colors), borderColor: areaColor(surface, colors) } : undefined}
    >
      <span
        aria-hidden
        key={label ?? "silent"}
        className={`absolute inset-x-0 top-0 h-[2px] ${fresh ? "chg-pulse" : ""}`}
        style={{ background: ship ? areaColor(surface, colors) : "var(--sol-border)" }}
      />
      <span className="chg-ui block text-[12px] text-sol-text/70">{surface}</span>
      {ship && label ? (
        <>
          <span className="block h-7 overflow-hidden font-mono text-[20px] font-medium leading-7 tabular-nums text-sol-text">
            <span key={label} className={fresh ? "chg-roll" : ""}>{label}</span>
          </span>
          <span className="block font-mono text-[10px] tabular-nums text-sol-text/50">
            {ship.kind === "deploy" ? "deployed " : ""}{formatDateSmart(ship.at)}
          </span>
          <span className="mt-0.5 block font-mono text-[10px] tabular-nums text-sol-text/60">
            {ship.waiting > 0 ? `${ship.waiting}${ship.waiting_exact ? "" : "+"} waiting` : "up to date"}
          </span>
        </>
      ) : (
        <>
          <span className="block h-7 font-mono text-[13px] leading-7 text-sol-text/40">no signal yet</span>
          <span className="block font-mono text-[10px] text-sol-text/40">deploys not recorded</span>
        </>
      )}
      {tile.kind === "ship" && tile.risk && (
        <>
          <span className="sr-only">Risk: {tile.risk}</span>
          <Tip text={<span className="whitespace-pre-line">{tile.risk}</span>}>
            <span aria-hidden className="absolute right-0 top-0 h-3.5 w-3.5" style={{ background: RISK_HATCH }} />
          </Tip>
        </>
      )}
    </button>
  );
  if (!ship) return body;
  return (
    <HoverCard card={<ShipCard ship={ship} />} className="w-72" triggerClassName="block min-w-0" side="bottom" focusable>
      {body}
    </HoverCard>
  );
}

export const LiveStrip = memo(function LiveStrip({ tiles, activeSurface, onPick, stripRef, animate }: {
  tiles: readonly LiveTile[];
  activeSurface?: string;
  onPick: (surface: string) => void;
  stripRef?: React.Ref<HTMLDivElement>;
  /** The first paint's rise, third in reading order (spec 5.4). */
  animate?: boolean;
}) {
  if (!tiles.some((t) => t.kind === "ship")) return null;
  return (
    <div
      ref={stripRef}
      className={`grid scroll-mt-4 gap-2 ${animate ? "chg-rise" : ""}`}
      style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", ["--i" as any]: 2 }}
      aria-label="What is live"
    >
      {tiles.map((t) => {
        const surface = t.kind === "ship" ? t.row.surface : t.surface;
        return <Tile key={surface} tile={t} active={activeSurface === surface} onPick={onPick} />;
      })}
    </div>
  );
});
