"use client";
// The map (docs/architecture/org-staffing.md S40): one picture of the company
// with its mission, goals, projects, people and roles on it, read like a map.
// Four filters on the same nodes (Everything, Goals, Projects, People), chosen
// in the company pane's row the document shares, and two overlays in the
// map's own corner: "As proposed" (the open proposal drawn in place, in the
// quiet violet mark every proposal wears) and, on People, "This week" (each
// role card carries its week, work in against work closed, and the reporting
// lines carry the work flowing down them; cohesive build spec D12). Read only: a person answers a
// proposal on its cards in the conversation beside the map, never here. A
// click on a card opens its sheet (cohesive build spec D15) and the open
// sheet's card stays ringed. The page that mounts it owns every piece of
// state and passes it in; the map keeps nothing but its own selection.
import { useCallback, useMemo, useState } from "react";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import type { InitiativeRow } from "@codecast/shared/contracts/initiative";
import { useSyncOrgHealth } from "../../hooks/useSyncOrgHealth";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { cn } from "../../lib/utils";
import { OrgGraph, type OrgGraphObject, type OrgGraphProps, type OrgLens } from "./OrgGraph";
import type { GoalProject } from "./goalsLayout";
import { roleNodeId, type OrgFocusTarget, type OrgLayoutView } from "./orgLayout";
import { GHOST } from "./orgMeta";
import { FLOW_TONE } from "./orgFlowViz";
import { flowDays, flowMap, roleFlows } from "./orgFlow";
import { HealthNote } from "./healthParts";
import type { OrgHealth, OrgProposalChange } from "./orgStaffingTypes";
import type { OrgTree } from "./orgTypes";

/** What the company pane shows, on the map and in the document alike. */
export type MapFilter = "everything" | "goals" | "projects" | "people";

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
  /** The "As proposed" overlay. Shown only while a proposal is open. */
  asProposed: boolean;
  onAsProposed: (on: boolean) => void;
  /** "This week" (D12): on the People filter each role carries its week and the lines the work flowing down them. */
  week?: boolean;
  /** A proposal card hovered or focused in the conversation: its node is lit, and panned to when off screen. */
  highlightChangeId?: string | null;
  /** Something to pan to on an ask (a link in the thread): a change or a node; `seq` re-pans on a repeat. */
  focusTarget?: OrgFocusTarget | null;
  onSelectNode?: (nodeId: string | null) => void;
  /** A double click on a role seat opens its standing conversation. */
  onOpenSession?: (conversationId: string) => void;
  /** The slim bar with the overlay toggle; false when the page draws its own. */
  toolbar?: boolean;
  className?: string;
  /** The object whose sheet is open: ringed, and kept in the canvas the sheet leaves. */
  ring?: OrgGraphObject | null;
  /** How much of the canvas' right edge a sheet covers. */
  panelWidth?: number;
  /** A click on a card opens its object; the company card closes the sheets (null). False: nothing to open, the card is selected. */
  onOpenObject?: OrgGraphProps["onOpenObject"];
  /** A click on a proposal's ghost: the page scrolls the conversation to its card. */
  onOpenChange?: (changeId: string) => void;
  /** A double click on a role: talk to it. */
  onTalk?: (o: OrgGraphObject) => void;
};

/** The Projects filter draws the goals outline with the goals stepped back. */
const LENS_OF: Record<MapFilter, OrgLens> = { everything: "everything", goals: "goals", projects: "goals", people: "people" };
const NO_CLUSTERS: ReadonlySet<string> = new Set();
/** The week's picture is the reporting structure alone: every role card is its week, with no session rows. */
const WEEK_VIEW: OrgLayoutView = { collapsed: new Set(), expanded: {}, structureOnly: true };
/** A week is counted in days, so the clock that re-reads it can be slow. */
const WEEK_CLOCK_MS = 5 * 60_000;
const noop = () => {};
const never = () => false;
let seq = 0;

/** The map's own corner: the "As proposed" toggle, "This week" on the People
 *  filter, and what a page adds beside them (Following). The filter lives in
 *  the company pane's row. */
export function MapCorner({ asProposed, onAsProposed, hasProposal, week, size = "sm", children }: Pick<OrgMapProps, "asProposed" | "onAsProposed"> & { hasProposal: boolean; /** The This week toggle; omitted where the filter is not People. */ week?: { on: boolean; onToggle: (on: boolean) => void } | null; size?: "sm" | "md"; children?: React.ReactNode }) {
  const h = size === "sm" ? "h-7" : "h-[34px]";
  if (!hasProposal && !week && !children) return null;
  return (
    <div className="flex shrink-0 flex-wrap items-center justify-end gap-x-2 gap-y-1.5" data-map-toolbar>
      {week && (
        <button
          type="button"
          onClick={() => week.onToggle(!week.on)}
          aria-pressed={week.on}
          title={week.on ? "Each role shows its week: work that reached it against work it closed. Click to see the roles as they are." : "Show each role's week: work that reached it against work it closed, and the work flowing down each line"}
          className={cn("inline-flex shrink-0 items-center gap-1.5 rounded-md border font-medium transition-colors", h, size === "sm" ? "px-2 text-[11.5px]" : "px-2.5 text-[12.5px]", week.on ? "bg-sol-bg-highlight" : "hover:bg-sol-bg-highlight/60")}
          style={{ borderColor: week.on ? `color-mix(in srgb, ${FLOW_TONE.reached} 45%, transparent)` : "color-mix(in srgb, var(--sol-border) 30%, transparent)", color: week.on ? "var(--sol-text)" : "var(--sol-text-muted)" }}
          data-map-week={week.on ? "on" : "off"}
        >
          <span aria-hidden className="inline-flex h-[9px] items-end gap-[1.5px]">
            <span className="w-[2.5px] h-[9px] rounded-[1px]" style={{ background: FLOW_TONE.reached, opacity: week.on ? 0.9 : 0.55 }} />
            <span className="w-[2.5px] h-[6px] rounded-[1px]" style={{ background: FLOW_TONE.closed, opacity: week.on ? 0.9 : 0.55 }} />
          </span>
          This week
        </button>
      )}
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

export function OrgMap({ tree, goals, health: healthProp, proposal, filter, asProposed, onAsProposed, week = false, highlightChangeId = null, focusTarget = null, onSelectNode, onOpenSession, toolbar = true, className, ring = null, panelWidth = 0, onOpenObject, onOpenChange, onTalk }: OrgMapProps) {
  const [selected, setSelected] = useState<string | null>(null);
  const select = useCallback((id: string | null) => { setSelected(id); onSelectNode?.(id); }, [onSelectNode]);
  // The people filter's flags and its week read org.health; the outline does not ask for it.
  const { health: storeHealth, missing: healthMissing, error: healthError, refresh: refreshHealth } = useSyncOrgHealth(filter === "people" && healthProp === undefined);
  const health = healthProp === undefined ? storeHealth : healthProp;
  const changes = asProposed && proposal ? proposal.changes : undefined;
  // The week draws on the People filter only; elsewhere the toggle is not shown and the flag reads as off.
  const weekOn = week && filter === "people";
  // Sessions are counts and state dots on the cards, never a stack of cards under each.
  const peopleView = useMemo<OrgLayoutView>(() => ({ collapsed: new Set(), expanded: {}, sessionCards: false }), []);
  const view = weekOn ? WEEK_VIEW : peopleView;
  const now = useCoarseNow(WEEK_CLOCK_MS);
  const flows = useMemo(() => (weekOn && tree && health ? roleFlows(tree, health, now) : null), [weekOn, tree, health, now]);
  // The open sheet's role keeps its lines lit and steps the rest back.
  const ringRole = ring?.kind === "role" ? roleNodeId(ring.id) : null;
  const flow = useMemo(() => (flows ? { map: flowMap(flows), focusNodeId: ringRole, roles: Object.fromEntries(flows.map((f) => [f.nodeId, f])), days: flowDays(now) } : undefined), [flows, ringRole, now]);
  // A hover lights the node and pans only when it is off screen; an explicit
  // ask pans always. Whichever changed last wins, so a hover after a link does
  // not drag the map back, a link after a hover still lands, and a hover
  // ending asks for nothing. Set from effects, so a render never carries it.
  const [target, setTarget] = useState<OrgFocusTarget | null>(null);
  useWatchEffect(() => { setTarget(highlightChangeId ? { kind: "change", id: highlightChangeId, seq: ++seq, ifHidden: true } : null); }, [highlightChangeId]);
  useWatchEffect(() => { if (focusTarget) setTarget(focusTarget); }, [focusTarget]);

  return (
    <div className={cn("flex h-full min-h-0 w-full flex-col overflow-hidden", className)} style={{ background: "var(--sol-bg)", color: "var(--sol-text)" }} data-org-map={filter} data-map-filter={filter} data-org-map-proposed={changes ? "on" : "off"} data-org-map-week={weekOn ? "on" : undefined}>
      {toolbar && !!proposal && <div className="flex shrink-0 justify-end border-b px-2.5 py-1.5" style={{ borderColor: "color-mix(in srgb, var(--sol-border) 22%, transparent)" }}><MapCorner asProposed={asProposed} onAsProposed={onAsProposed} hasProposal /></div>}
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
            dimGoals={filter === "projects"}
            flow={flow}
            ring={ring}
            panelWidth={panelWidth}
            onOpenObject={onOpenObject}
            onOpenChange={onOpenChange}
            onTalk={onTalk}
            onOpenInPeople={onOpenObject ? (nodeId) => { if (nodeId.startsWith("person:")) onOpenObject({ kind: "person", id: nodeId.slice("person:".length) }); } : undefined}
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-[12.5px] text-sol-text-dim" data-map-loading>The map appears here when it is ready.</div>
        )}
        {/* A week that could not be read is said, never drawn as a quiet company. */}
        {weekOn && healthProp === undefined && (healthMissing || healthError) && (
          <div className="absolute left-3 top-3 z-10 max-w-[min(420px,calc(100%-24px))] rounded-md px-1 pb-2" style={{ background: "color-mix(in srgb, var(--sol-bg) 88%, transparent)" }} data-map-week-note>
            <HealthNote missing={healthMissing} error={healthError?.message} hasHealth={!!health} onRetry={() => { void refreshHealth(); }} />
          </div>
        )}
      </div>
    </div>
  );
}

export default OrgMap;
