"use client";
// /org: the company as one chart, read three ways. People (the default): each
// person, the agent roles under them, and each role's live sessions stacked
// beneath it, folded, paged, opened in place and moved by drag. Everything:
// the same chart with the product layer joined into it (a goal under its
// owner, a project under its lead with its sessions under it). Goals: the
// goals and projects alone. The choice is the person's own (clientState.ui.org_view). The chart
// is a map into the app, not a place of its own: every card opens the page
// that thing already has, a person their profile, a goal its page and a
// project its board. A role (its session), a session and a proposal open in
// the drawer on the right (OrgPanel), the chart staying in view: a proposal
// draws its changes on the chart, a card hovered or clicked in the drawer
// lights its node, and a marked node focuses its card. With nothing named the
// drawer is the Head of People, or the offer to hire one.
import { useCallback, useContext, useRef, useState } from "react";
import { Maximize2, Minimize2, UserPlus } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { objectHref } from "@codecast/shared/entities";
import { isHeadOfPeopleRole } from "@codecast/shared/contracts/orgLead";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useSyncOrgProposal } from "../../hooks/useSyncOrgProposals";
import { useSwitchWorkspace } from "../../hooks/useSwitchWorkspace";
import { useEventListener } from "../../hooks/useEventListener";
import { RevealInBandCtx } from "../../lib/revealHost";
import { hasOpenModal, isEditableTarget } from "../../shortcuts";
import { OrgPanel, type OrgPanelTarget } from "./OrgPanel";
import { useEdgeResize } from "../../hooks/useEdgeResize";
import { OrgHoverContext } from "./proposalContexts";
import { useProposalChanges } from "./proposalHooks";
import { RoleFace } from "./RoleFace";
import { HireRoleDialog } from "./HireRoleDialog";
import type { OrgProposalListRow } from "./orgStaffingTypes";
import type { OrgFocusTarget } from "./orgLayout";
import type { OrgTree } from "./orgTypes";
import { useInboxStore } from "../../store/inboxStore";
import { useSyncOrgTree } from "../../hooks/useSyncOrgTree";
import { useSyncProjects } from "../../hooks/useSyncProjects";
import { ContextMenu, useContextMenu } from "../ui/context-menu";
import { cn } from "../../lib/utils";
import { OrgMap, type MapFilter } from "./OrgMap";
import type { OrgGraphObject } from "./OrgGraph";
import type { OrgLayoutNode } from "./orgLayout";
import { useOrgPeopleView } from "./useOrgPeopleView";
import { useOrgMoves } from "./useOrgMoves";
import { OrgNodeMenu } from "./OrgNodeMenu";

/** The chart's three readings, in the switch's order. */
export type OrgChartView = "people" | "everything" | "goals";
const VIEWS: { id: OrgChartView; label: string }[] = [
  { id: "people", label: "People" },
  { id: "everything", label: "Everything" },
  { id: "goals", label: "Goals" },
];
/** A saved value this build does not draw (an older screen's) reads as the default. */
export const orgChartViewOf = (v: unknown): OrgChartView => (v === "everything" || v === "goals" ? v : "people");

/** Opens every card on the chart in place, or closes them all; the person's own choice, kept across visits. */
function ExpandAllToggle({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  const Icon = on ? Minimize2 : Maximize2;
  return (
    <button
      type="button"
      onClick={() => onChange(!on)}
      aria-pressed={on}
      className={cn("inline-flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-[12px] font-medium transition-colors", on ? "bg-sol-bg-highlight" : "hover:bg-sol-bg-highlight/50")}
      style={{ borderColor: "color-mix(in srgb, var(--sol-border) 35%, transparent)", color: on ? "var(--sol-text)" : "var(--sol-text-muted)" }}
      data-org-expand-all={on ? "on" : "off"}
    >
      <Icon className="h-3.5 w-3.5" />
      {on ? "Collapse all" : "Expand all"}
    </button>
  );
}

function ViewSwitch({ value, onChange }: { value: OrgChartView; onChange: (v: OrgChartView) => void }) {
  return (
    <div role="radiogroup" aria-label="What the chart shows" className="inline-flex h-7 items-center rounded-lg border p-[2px]" style={{ borderColor: "color-mix(in srgb, var(--sol-border) 35%, transparent)" }} data-org-view-switch>
      {VIEWS.map((v) => {
        const on = v.id === value;
        return (
          <button
            key={v.id}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => { if (!on) onChange(v.id); }}
            className={cn("h-[22px] rounded-md px-2.5 text-[12px] font-medium transition-colors", on ? "bg-sol-bg-highlight" : "hover:bg-sol-bg-highlight/50")}
            style={{ color: on ? "var(--sol-text)" : "var(--sol-text-muted)" }}
            data-org-view={v.id}
          >
            {v.label}
          </button>
        );
      })}
    </div>
  );
}

/** The page a chart card opens, or null when the store cannot name one yet. */
export function chartCardHref(o: OrgGraphObject, st: ReturnType<typeof useInboxStore.getState>): string | null {
  if (o.kind === "role") {
    const role = st.orgTree?.roles.find((r) => r._id === o.id || r.short_id === o.id);
    const conv = role?.standing?.conversation_id;
    return conv ? `/conversation/${conv}` : null;
  }
  if (o.kind === "person") {
    const member = (st.teamMembers as Array<{ _id: string; github_username?: string }> | undefined)?.find((m) => String(m._id) === o.id);
    return `/team/${encodeURIComponent(member?.github_username || o.id)}`;
  }
  if (o.kind === "initiative") {
    const goal = (st.initiatives as Record<string, { short_id?: string }> | undefined)?.[o.id];
    return objectHref("initiative", goal?.short_id || o.id);
  }
  const project = (st.projects as Record<string, { short_id?: string }> | undefined)?.[o.id];
  return objectHref("project", project?.short_id || o.id);
}

/** The drawer, closed: the Head of People's face to bring it back, or the offer to hire one. */
function PanelToggle({ tree, onOpen }: { tree: OrgTree | null; onOpen: () => void }) {
  const head = tree?.roles.find((r) => isHeadOfPeopleRole(r)) ?? null;
  return (
    <button type="button" onClick={onOpen} className="inline-flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-[12px] font-medium hover:bg-sol-bg-highlight/50" style={{ borderColor: "color-mix(in srgb, var(--sol-border) 35%, transparent)", color: "var(--sol-text)" }} data-org-panel-open>
      {head && <RoleFace role={head} size={16} />}
      {head ? head.name : "Hire the Head of People"}
    </button>
  );
}

/** Hire a role: the gallery of templates this workspace can hire, and a role written by hand behind it. */
function HireButton({ tree }: { tree: OrgTree | null }) {
  const [open, setOpen] = useState(false);
  const meId = useInboxStore((s) => (s.currentUser as { _id?: string } | null)?._id) ?? "";
  if (!tree) return null;
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="inline-flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-[12px] font-medium hover:bg-sol-bg-highlight/50" style={{ borderColor: "color-mix(in srgb, var(--sol-border) 35%, transparent)", color: "var(--sol-text)" }} data-org-hire>
        <UserPlus className="h-3.5 w-3.5" /> Hire
      </button>
      {open && <HireRoleDialog open onClose={() => setOpen(false)} tree={tree} meId={meId} title="Hire" initialMode="template" onCreate={(input) => { useInboxStore.getState().createOrgRole(input); setOpen(false); }} />}
    </>
  );
}

/** What the drawer shows, read from the address: a proposal (`?proposal=op-N`,
 *  with `&focus=n` naming one of its changes), a session (`?session=<id>`), or
 *  the Head of People. */
function panelTargetOf(params: URLSearchParams): OrgPanelTarget {
  const proposal = params.get("proposal");
  if (proposal) return { kind: "proposal", ref: proposal, ...(params.get("focus") ? { focus: params.get("focus")! } : {}) };
  const session = params.get("session");
  if (session) return { kind: "session", id: session };
  return { kind: "home" };
}

const panelHref = (t: OrgPanelTarget): string =>
  t.kind === "proposal" ? `/org?proposal=${encodeURIComponent(t.ref)}${t.focus ? `&focus=${encodeURIComponent(t.focus)}` : ""}` : t.kind === "session" ? `/org?session=${encodeURIComponent(t.id)}` : "/org";

/** The drawer's width is the reader's, dragged from its left edge and kept per device. The
 *  default fits a proposal's fields without truncating; the chart always keeps `ORG_CHART_MIN`. */
const ORG_PANEL = { key: "codecast.org-panel-w", min: 420, fallback: 620 } as const;
const ORG_CHART_MIN = 280;
const orgPanelWidth = (containerWidth: number, chosen: number) => Math.max(Math.min(ORG_PANEL.min, containerWidth), Math.min(chosen, containerWidth - ORG_CHART_MIN));

/** The container's size: the drawer takes a share of its width, and the proposal it pins a share of its height. */
function useSize(): [(el: HTMLDivElement | null) => void, { w: number; h: number }] {
  const [size, setSize] = useState({ w: 0, h: 0 });
  const ro = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: HTMLDivElement | null) => {
    ro.current?.disconnect();
    if (!el) return;
    const read = () => setSize((prev) => (prev.w === el.clientWidth && prev.h === el.clientHeight ? prev : { w: el.clientWidth, h: el.clientHeight }));
    read();
    if (typeof ResizeObserver === "undefined") return;
    ro.current = new ResizeObserver(read);
    ro.current.observe(el);
  }, []);
  return [ref, size];
}

let focusSeq = 0;

export function OrgChart() {
  const router = useRouter();
  const params = useSearchParams();
  const inBand = useContext(RevealInBandCtx);
  const { tree } = useSyncOrgTree();
  useSyncProjects();
  const target = panelTargetOf(params);
  const headConversation = tree?.roles.find((r) => isHeadOfPeopleRole(r))?.standing?.conversation_id ?? null;

  // A message for the Head of People (`?compose=…`) waits in its composer, in the drawer.
  const draft = params.get("compose");
  useWatchEffect(() => {
    if (!draft || !headConversation) return;
    const st = useInboxStore.getState();
    st.setDraft(headConversation, { ...(st.getDraft(headConversation) ?? {}), draft_message: draft });
    router.replace("/org");
  }, [draft, headConversation]);

  // The drawer is open unless the person closed it; a proposal or a session named in the address always opens it.
  const closed = useInboxStore((st) => st.clientState.ui?.org_panel === "closed");
  const panelOpen = target.kind !== "home" || !closed || params.get("panel") === "open";
  useWatchEffect(() => {
    if (params.get("panel") === "open" && closed) useInboxStore.getState().updateClientUI({ org_panel: undefined });
  }, [params.get("panel")]);
  const goPanel = useCallback((t: OrgPanelTarget) => {
    if (useInboxStore.getState().clientState.ui?.org_panel === "closed") useInboxStore.getState().updateClientUI({ org_panel: undefined });
    router.push(panelHref(t));
  }, [router]);
  const closePanel = useCallback(() => {
    useInboxStore.getState().updateClientUI({ org_panel: "closed" });
    if (target.kind !== "home") router.push("/org");
  }, [router, target.kind]);

  // The proposal open in the drawer: its changes drawn on the chart when it belongs to the workspace on screen.
  const proposalRef = target.kind === "proposal" ? target.ref : null;
  useSyncOrgProposal(proposalRef);
  const proposalRow = useInboxStore((st) => (proposalRef ? Object.values((st.orgProposals ?? {}) as Record<string, OrgProposalListRow>).find((p) => p.short_id === proposalRef) ?? null : null));
  const changes = useProposalChanges(proposalRow?._id);
  const activeTeam = tree?.workspace.kind === "team" ? tree.workspace.id : null;
  const proposalHere = !!proposalRow && !!tree && (proposalRow.team_id ?? null) === activeTeam;
  // Only what still waits is drawn on the chart; a decided or withdrawn proposal says its outcome in the drawer.
  const drawn = proposalHere && proposalRow.status === "open";
  // Arriving at a proposal by address lands in its workspace; inside a reveal band the drawer names it and offers the switch.
  const switchWorkspace = useSwitchWorkspace();
  const switchedFor = useRef<string | null>(null);
  useWatchEffect(() => {
    if (inBand || !proposalRow || !tree || proposalHere || switchedFor.current === proposalRow._id) return;
    switchedFor.current = proposalRow._id;
    void switchWorkspace(proposalRow.team_id ?? null);
  }, [proposalRow?._id, proposalHere, !!tree]);

  // A card hovered in the drawer lights its node; a click on one (or `&focus=n`) focuses it on the chart.
  const [hoverChange, setHoverChange] = useState<string | null>(null);
  const [focusTarget, setFocusTarget] = useState<OrgFocusTarget | null>(null);
  const focusChange = useCallback((changeId: string) => {
    useInboxStore.getState().setOrgFocusChangeId(changeId);
    setFocusTarget({ kind: "change", id: changeId, seq: ++focusSeq });
  }, []);
  const focusSeqParam = params.get("focus");
  useWatchEffect(() => {
    const id = focusSeqParam ? changes.find((c) => String(c.seq) === focusSeqParam)?._id : undefined;
    if (id) focusChange(id);
  }, [focusSeqParam, changes.length]);
  // A marked node on the chart opens its change in the drawer.
  const openChange = useCallback((changeId: string) => {
    if (proposalRef) focusChange(changeId);
  }, [proposalRef, focusChange]);

  const open = useCallback((o: OrgGraphObject | null) => {
    if (!o) return false;
    // A role is its session: it opens in the drawer beside the chart.
    if (o.kind === "role") {
      const conv = useInboxStore.getState().orgTree?.roles.find((r) => r._id === o.id || r.short_id === o.id)?.standing?.conversation_id;
      if (conv) { goPanel({ kind: "session", id: conv }); return true; }
    }
    const href = chartCardHref(o, useInboxStore.getState());
    if (!href) return false;
    router.push(href);
    return true;
  }, [router, goPanel]);
  const openSession = useCallback((conversationId: string) => goPanel({ kind: "session", id: conversationId }), [goPanel]);
  const [measure, size] = useSize();
  const sizeW = useRef(0);
  sizeW.current = size.w;
  const resize = useEdgeResize({ storageKey: ORG_PANEL.key, min: ORG_PANEL.min, fallback: ORG_PANEL.fallback, max: () => sizeW.current - ORG_CHART_MIN });
  const panelWidth = panelOpen && size.w ? orgPanelWidth(size.w, resize.width) : 0;

  useEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key !== "Escape" || inBand || !panelOpen || hasOpenModal() || isEditableTarget(e.target)) return;
    if (target.kind !== "home") goPanel({ kind: "home" });
    else closePanel();
  });
  const view = orgChartViewOf(useInboxStore((st) => st.clientState.ui?.org_view));
  const setView = useCallback((v: OrgChartView) => useInboxStore.getState().updateClientUI({ org_view: v }), []);

  const people = useOrgPeopleView(tree);
  const moves = useOrgMoves(tree, people);
  const menu = useContextMenu<OrgLayoutNode>();
  const onNodeContextMenu = useCallback((e: React.MouseEvent, n: OrgLayoutNode) => menu.open(e, n, { force: true }), [menu]);
  const filter: MapFilter = view;
  return (
    <div className="flex h-full min-h-0 flex-col" style={{ background: "var(--sol-bg)" }} data-org-chart={view}>
      {/* In a reveal band the band's own title names what opened; the chart's controls give the room to it. */}
      {!inBand && <header className="flex h-12 shrink-0 items-center gap-4 border-b px-5" style={{ borderColor: "color-mix(in srgb, var(--sol-border) 30%, transparent)" }}>
        <h1 className="text-[15px] font-medium" style={{ color: "var(--sol-text)" }}>Org</h1>
        <ViewSwitch value={view} onChange={setView} />
        {view !== "goals" && <ExpandAllToggle on={people.expandAll} onChange={people.setExpandAll} />}
        <div className="ml-auto flex items-center gap-2">
          <HireButton tree={tree} />
          {!panelOpen && <PanelToggle tree={tree} onOpen={() => goPanel({ kind: "home" })} />}
        </div>
      </header>}
      <div ref={measure} className="relative min-h-0 flex-1">
        <OrgMap
          tree={tree}
          filter={filter}
          proposal={drawn ? { changes } : null}
          asProposed={drawn}
          onAsProposed={() => {}}
          toolbar={false}
          highlightChangeId={hoverChange}
          focusTarget={focusTarget}
          panelWidth={panelWidth}
          onOpenChange={openChange}
          onOpenObject={open}
          onOpenSession={openSession}
          people={{
            view: people.view,
            loadingClusters: people.loadingClusters,
            onToggleCollapse: people.toggleCollapse,
            onExpandCluster: people.loadMore,
            onCollapseCluster: people.collapseCluster,
            onReparentRequest: moves.requestMove,
            onDropSessions: moves.dropSessions,
            onNodeContextMenu,
            canDrag: moves.canDrag,
            canDropPerson: moves.canDropPerson,
            resetKey: moves.resetKey,
            onToggleOpen: people.toggleOpen,
            sessionProject: people.sessionProject,
          }}
        />
        {panelOpen && (
          <OrgHoverContext.Provider value={setHoverChange}>
            <OrgPanel tree={tree} target={target} onTarget={goPanel} onClose={closePanel} onFocusChange={focusChange} onResizeDown={resize.onResizeDown} style={{ ["--lw-drawer-w" as string]: `${panelWidth}px`, ["--org-panel-h" as string]: `${size.h}px` }} />
          </OrgHoverContext.Provider>
        )}
      </div>
      {people.pagers}
      {moves.ui}
      <ContextMenu state={menu}>
        {(n) => <OrgNodeMenu node={n} moves={moves} currentParentOf={people.currentParentOf} onToggleCollapse={people.toggleCollapse} onOpenSession={openSession} onOpenObject={open} />}
      </ContextMenu>
    </div>
  );
}
