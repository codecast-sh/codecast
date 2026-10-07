"use client";
// The org screen's map column (docs/architecture/org-staffing.md S41): the
// map with its filter bar, or the read-state block when there is no tree to
// draw. Opened beside a conversation (`?beside=`), the bar carries the
// Following toggle: the newest pointer the agent writes in that thread
// (orgChartPointer) re-points the map's proposal and focus until the person
// holds it still.
import { useRef, useState } from "react";
import { Radio } from "lucide-react";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { cn } from "../../lib/utils";
import { MapToolbar, OrgMap, type OrgMapProps } from "./OrgMap";
import { OrgReadStateBlock } from "./OrgReadStateBlock";
import { useThreadChartPointer } from "./orgChartLink";
import type { ChartPointer } from "./orgChartPointer";
import type { OrgTreeReadState } from "./orgReadState";

export type OrgMapColumnProps = Pick<OrgMapProps, "tree" | "goals" | "health" | "proposal" | "filter" | "onFilter" | "asProposed" | "onAsProposed" | "highlightChangeId" | "focusTarget" | "onOpenSession"> & {
  readState: OrgTreeReadState;
  onRetry: () => void;
  /** The conversation this pane sits beside, whose pointers it may follow. */
  beside: string | null;
  /** Apply a pointer the followed thread wrote. */
  onPointer: (pointer: ChartPointer) => void;
};

export function OrgMapColumn({ readState, onRetry, beside, onPointer, tree, goals, health, proposal, filter, onFilter, asProposed, onAsProposed, highlightChangeId, focusTarget, onOpenSession }: OrgMapColumnProps) {
  const [following, setFollowing] = useState(true);
  // The thread's newest pointer moves the map; the one that was there when
  // the pane opened does not, so opening on an older proposal's card holds.
  const thread = useThreadChartPointer(beside);
  const applied = useRef(thread?.key ?? null);
  useWatchEffect(() => {
    if (!beside || !following || !thread || applied.current === thread.key) return;
    applied.current = thread.key;
    onPointer({ proposal: thread.proposal, focus: thread.focus, lens: thread.lens });
  }, [beside, following, thread?.key]);
  const toggleFollow = () => {
    const next = !following;
    setFollowing(next);
    if (next && thread) { applied.current = thread.key; onPointer({ proposal: thread.proposal, focus: thread.focus, lens: thread.lens }); }
  };
  return (
    <div data-org-map-column className="relative h-full min-h-0 flex flex-col">
      {readState.kind === "ok" || readState.kind === "stale" || readState.kind === "empty" ? (
        <>
          <MapToolbar filter={filter} onFilter={onFilter} asProposed={asProposed} onAsProposed={onAsProposed} hasProposal={!!proposal}>
            {beside && (
              <button
                type="button"
                onClick={toggleFollow}
                aria-pressed={following}
                title={following ? "The map moves to what the conversation points at. Click to hold it still." : "Let the conversation move the map again"}
                className={cn("ml-auto inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2 text-[11.5px] font-medium transition-colors", following ? "bg-sol-bg-highlight" : "hover:bg-sol-bg-highlight/60")}
                style={{ borderColor: following ? "color-mix(in srgb, var(--sol-violet) 45%, transparent)" : "color-mix(in srgb, var(--sol-border) 30%, transparent)", color: following ? "var(--sol-text)" : "var(--sol-text-muted)" }}
                data-chart-follow={following ? "on" : "off"}
              >
                <Radio className="h-3 w-3" style={following ? { color: "var(--sol-violet)" } : undefined} /> {following ? "Following" : "Follow"}
              </button>
            )}
          </MapToolbar>
          <div className="relative min-h-0 flex-1">
            <OrgMap tree={tree} goals={goals} health={health} proposal={proposal} filter={filter} onFilter={onFilter} asProposed={asProposed} onAsProposed={onAsProposed} highlightChangeId={highlightChangeId} focusTarget={focusTarget} onOpenSession={onOpenSession} toolbar={false} />
          </div>
        </>
      ) : (
        <OrgReadStateBlock kind={readState.kind} message={readState.kind === "error" ? readState.message : undefined} onRetry={readState.kind === "error" ? onRetry : undefined} />
      )}
    </div>
  );
}
