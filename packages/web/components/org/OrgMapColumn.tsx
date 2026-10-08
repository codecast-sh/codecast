"use client";
// The company pane's Map lens (docs/architecture/org-staffing.md S41, cohesive
// build spec §4.4): the map. The pane (CompanyPane) holds the one read-state
// gate for both lenses, so this draws only when there is a company. Its corner (As proposed, and Following when the pane sits beside a
// conversation) rides the pane's header row, beside the filter it shares
// with the document. Following: the newest pointer the agent writes in that
// thread (orgChartPointer) re-points the map's proposal and focus until the
// person holds it still.
import { Radio } from "lucide-react";
import { cn } from "../../lib/utils";
import { MapCorner, OrgMap, type OrgMapProps } from "./OrgMap";

export type OrgMapColumnProps = Pick<OrgMapProps, "tree" | "goals" | "health" | "proposal" | "filter" | "asProposed" | "onAsProposed" | "week" | "highlightChangeId" | "focusTarget" | "onOpenSession" | "ring" | "panelWidth" | "onOpenObject" | "onOpenChange" | "onTalk">;

/** The map's corner: As proposed while a proposal is open, This week on the
 *  People filter, and Following beside a thread. */
export function OrgMapCorner({ asProposed, onAsProposed, hasProposal, week, follow }: Pick<OrgMapProps, "asProposed" | "onAsProposed"> & { hasProposal: boolean; week?: { on: boolean; onToggle: (on: boolean) => void } | null; follow: { following: boolean; toggle: () => void } | null }) {
  return (
    <MapCorner asProposed={asProposed} onAsProposed={onAsProposed} hasProposal={hasProposal} week={week}>
      {follow && (
        <button
          type="button"
          onClick={follow.toggle}
          aria-pressed={follow.following}
          title={follow.following ? "The map moves to what the conversation points at. Click to hold it still." : "Let the conversation move the map again"}
          className={cn("inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2 text-[11.5px] font-medium transition-colors", follow.following ? "bg-sol-bg-highlight" : "hover:bg-sol-bg-highlight/60")}
          style={{ borderColor: follow.following ? "color-mix(in srgb, var(--sol-violet) 45%, transparent)" : "color-mix(in srgb, var(--sol-border) 30%, transparent)", color: follow.following ? "var(--sol-text)" : "var(--sol-text-muted)" }}
          data-chart-follow={follow.following ? "on" : "off"}
        >
          <Radio className="h-3 w-3" style={follow.following ? { color: "var(--sol-violet)" } : undefined} /> {follow.following ? "Following" : "Follow"}
        </button>
      )}
    </MapCorner>
  );
}

export function OrgMapColumn(map: OrgMapColumnProps) {
  return (
    <div data-org-map-column className="relative h-full min-h-0 flex flex-col">
      <div className="relative min-h-0 flex-1">
        <OrgMap {...map} toolbar={false} />
      </div>
    </div>
  );
}
