"use client";
// The map (docs/architecture/org-staffing.md S40): one picture of the company
// with its mission, goals, projects, people and roles on it, read like a map.
// Three filters on the same nodes (Everything, Goals, People) and one overlay
// ("As proposed": the open proposal drawn in place, in the quiet violet mark
// every proposal wears). Read only: a person answers a proposal on its cards
// in the conversation beside the map, never here. The page that mounts it
// owns every piece of state and passes it in; the map keeps nothing but its
// own selection.
import { useCallback, useMemo, useState } from "react";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { Flag, Map as MapGlyph, Users } from "lucide-react";
import type { InitiativeRow } from "@codecast/shared/contracts/initiative";
import { useSyncOrgHealth } from "../../hooks/useSyncOrgHealth";
import { cn } from "../../lib/utils";
import { OrgGraph, type OrgLens } from "./OrgGraph";
import type { GoalProject } from "./goalsLayout";
import type { OrgFocusTarget, OrgLayoutView } from "./orgLayout";
import { GHOST } from "./orgMeta";
import type { OrgHealth, OrgProposalChange } from "./orgStaffingTypes";
import type { OrgTree } from "./orgTypes";

export type MapFilter = "everything" | "goals" | "people";

export type OrgMapProps = {
  /** The org; null draws the placeholder until it is ready. */
  tree: OrgTree | null;
  /** The goals and projects when they are not the store's (a fixture, a test). */
  goals?: { initiatives: readonly InitiativeRow[]; projects: readonly GoalProject[] };
  /** Role flags on the People filter; omitted, the map subscribes to org.health itself while People is on. */
  health?: OrgHealth | null;
  /** The open proposal with its changes; drawn over the filter while `asProposed`. */
  proposal?: { changes: readonly OrgProposalChange[] } | null;
  filter: MapFilter;
  onFilter: (filter: MapFilter) => void;
  /** The "As proposed" overlay. Shown only while a proposal is open. */
  asProposed: boolean;
  onAsProposed: (on: boolean) => void;
  /** A proposal card hovered or focused in the conversation: its node is lit, and panned to when off screen. */
  highlightChangeId?: string | null;
  /** Something to pan to on an ask (a link in the thread): a change or a node; `seq` re-pans on a repeat. */
  focusTarget?: OrgFocusTarget | null;
  onSelectNode?: (nodeId: string | null) => void;
  /** A double click on a role seat opens its standing conversation. */
  onOpenSession?: (conversationId: string) => void;
  /** The slim bar with the filters and the overlay toggle; false when the page draws its own. */
  toolbar?: boolean;
  className?: string;
};

const MAP_FILTERS: { filter: MapFilter; label: string; title: string; icon: typeof Users }[] = [
  { filter: "everything", label: "Everything", title: "The mission, its goals and projects, and everyone beside them", icon: MapGlyph },
  { filter: "goals", label: "Goals", title: "The goals and the projects that carry them, alone", icon: Flag },
  { filter: "people", label: "People", title: "Who reports to whom", icon: Users },
];

const LENS_OF: Record<MapFilter, OrgLens> = { everything: "everything", goals: "goals", people: "people" };
const NO_CLUSTERS: ReadonlySet<string> = new Set();
const noop = () => {};
const never = () => false;
let seq = 0;

/** The filter chips and the "As proposed" toggle: one bar the map and a page may share. */
export function MapToolbar({ filter, onFilter, asProposed, onAsProposed, hasProposal, size = "sm", children }: Pick<OrgMapProps, "filter" | "onFilter" | "asProposed" | "onAsProposed"> & { hasProposal: boolean; size?: "sm" | "md"; children?: React.ReactNode }) {
  const h = size === "sm" ? "h-7" : "h-[34px]";
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1.5 border-b px-2.5 py-1.5" style={{ borderColor: "color-mix(in srgb, var(--sol-border) 22%, transparent)" }} data-map-toolbar>
      <div className={cn("inline-flex shrink-0 items-center rounded-lg border p-[2px]", h)} style={{ borderColor: "color-mix(in srgb, var(--sol-border) 30%, transparent)", background: "var(--sol-card)" }} role="group" aria-label="What the map shows" data-map-filter={filter}>
        {MAP_FILTERS.map(({ filter: f, label, title, icon: Icon }) => (
          <button
            key={f}
            type="button"
            onClick={() => onFilter(f)}
            aria-pressed={filter === f}
            title={title}
            className={cn("inline-flex h-full items-center gap-1.5 rounded-md font-medium transition-colors", size === "sm" ? "px-2 text-[11.5px]" : "px-2.5 text-[12.5px]", filter === f ? "bg-sol-bg-highlight" : "hover:bg-sol-bg-highlight/50")}
            style={{ color: filter === f ? "var(--sol-text)" : "var(--sol-text-muted)" }}
            data-map-filter-pick={f}
          >
            <Icon className="h-3.5 w-3.5" style={filter === f ? { color: f === "people" ? "var(--sol-violet)" : "var(--sol-cyan)" } : undefined} /> {label}
          </button>
        ))}
      </div>
      {hasProposal && (
        <button
          type="button"
          onClick={() => onAsProposed(!asProposed)}
          aria-pressed={asProposed}
          title={asProposed ? "The open proposal is drawn in place, in violet. Click to see the company as it is." : "Draw the open proposal in place"}
          className={cn("inline-flex shrink-0 items-center gap-1.5 rounded-md border font-medium transition-colors", h, size === "sm" ? "px-2 text-[11.5px]" : "px-2.5 text-[12.5px]", asProposed ? "bg-sol-bg-highlight" : "hover:bg-sol-bg-highlight/60")}
          style={{ borderColor: asProposed ? "color-mix(in srgb, var(--sol-violet) 45%, transparent)" : "color-mix(in srgb, var(--sol-border) 30%, transparent)", color: asProposed ? "var(--sol-text)" : "var(--sol-text-muted)" }}
          data-map-proposed={asProposed ? "on" : "off"}
        >
          <span aria-hidden className="h-[9px] w-[9px] rounded-[2px]" style={{ background: asProposed ? GHOST.color : "transparent", border: `1px solid ${GHOST.color}`, opacity: asProposed ? 0.85 : 0.6 }} />
          As proposed
        </button>
      )}
      {children}
    </div>
  );
}

export function OrgMap({ tree, goals, health: healthProp, proposal, filter, onFilter, asProposed, onAsProposed, highlightChangeId = null, focusTarget = null, onSelectNode, onOpenSession, toolbar = true, className }: OrgMapProps) {
  const [selected, setSelected] = useState<string | null>(null);
  const select = useCallback((id: string | null) => { setSelected(id); onSelectNode?.(id); }, [onSelectNode]);
  // The people filter's flags read org.health; the outline does not ask for it.
  const { health: storeHealth } = useSyncOrgHealth(filter === "people" && healthProp === undefined);
  const health = healthProp === undefined ? storeHealth : healthProp;
  const changes = asProposed && proposal ? proposal.changes : undefined;
  // Sessions are counts and state dots on the cards, never a stack of cards under each.
  const view = useMemo<OrgLayoutView>(() => ({ collapsed: new Set(), expanded: {}, sessionCards: false }), []);
  // A hover lights the node and pans only when it is off screen; an explicit
  // ask pans always. Whichever changed last wins, so a hover after a link does
  // not drag the map back, a link after a hover still lands, and a hover
  // ending asks for nothing. Set from effects, so a render never carries it.
  const [target, setTarget] = useState<OrgFocusTarget | null>(null);
  useWatchEffect(() => { setTarget(highlightChangeId ? { kind: "change", id: highlightChangeId, seq: ++seq, ifHidden: true } : null); }, [highlightChangeId]);
  useWatchEffect(() => { if (focusTarget) setTarget(focusTarget); }, [focusTarget]);

  return (
    <div className={cn("flex h-full min-h-0 w-full flex-col overflow-hidden", className)} style={{ background: "var(--sol-bg)", color: "var(--sol-text)" }} data-org-map={filter} data-org-map-proposed={changes ? "on" : "off"}>
      {toolbar && <MapToolbar filter={filter} onFilter={onFilter} asProposed={asProposed} onAsProposed={onAsProposed} hasProposal={!!proposal} />}
      <div className="relative min-h-0 flex-1">
        {tree ? (
          <OrgGraph
            tree={tree}
            view={view}
            lens={LENS_OF[filter]}
            goalsData={goals}
            selectedId={selected}
            loadingClusters={NO_CLUSTERS}
            showMiniMap={false}
            onSelect={select}
            onToggleCollapse={noop}
            onExpandCluster={noop}
            onCollapseCluster={noop}
            onReparentRequest={noop}
            onNodeContextMenu={noop}
            onOpenSession={onOpenSession}
            canDrag={never}
            changes={changes}
            health={health}
            focusChangeId={highlightChangeId}
            focusTarget={target}
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-[12.5px] text-sol-text-dim" data-map-loading>The map appears here when it is ready.</div>
        )}
      </div>
    </div>
  );
}

export default OrgMap;
