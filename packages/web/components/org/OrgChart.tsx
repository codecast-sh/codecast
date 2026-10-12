"use client";
// /org: the company as one chart, read three ways. People (the default): each
// person, the agent roles under them, and each role's live sessions stacked
// beneath it, folded, paged, opened in place and moved by drag. Everything:
// the same chart with the product layer joined into it (a goal under its
// owner, a project under its lead with its sessions under it). Goals: the
// goals and projects alone. The choice is the person's own (clientState.ui.org_view). The chart
// is a map into the app, not a place of its own: every card opens the page
// that thing already has. A role opens its session, a session its
// conversation, a person their profile, a goal its page and a project its
// board. Proposals are answered in the Head of People's session like any
// other conversation.
import { useCallback } from "react";
import { Maximize2, Minimize2 } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { objectHref } from "@codecast/shared/entities";
import { isHeadOfPeopleRole } from "@codecast/shared/contracts/orgLead";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useSyncOrgProposal } from "../../hooks/useSyncOrgProposals";
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

/** Older links still name a proposal (`?proposal=op-N`, its card lives in the
 *  conversation that posted it) or a message for the Head of People
 *  (`?compose=…`). Both lead to that conversation; a message waits in its
 *  composer. Null when the address names neither, or the store cannot say yet. */
function useConversationAsk(): { to: string | null; draft: string | null } {
  const params = useSearchParams();
  const proposal = params.get("proposal");
  const draft = params.get("compose");
  useSyncOrgProposal(proposal);
  const to = useInboxStore((st) => {
    if (!proposal && !draft) return null;
    const row = proposal ? Object.values((st.orgProposals ?? {}) as Record<string, { short_id?: string; thread?: { conversation_id: string } | null }>).find((p) => p.short_id === proposal) : undefined;
    const head = st.orgTree?.roles.find((r) => isHeadOfPeopleRole(r))?.standing?.conversation_id;
    return row?.thread?.conversation_id ?? head ?? null;
  });
  return { to, draft };
}

export function OrgChart() {
  const router = useRouter();
  const { tree } = useSyncOrgTree();
  useSyncProjects();
  const ask = useConversationAsk();
  useWatchEffect(() => {
    if (!ask.to) return;
    if (ask.draft) useInboxStore.getState().setDraft(ask.to, { ...(useInboxStore.getState().getDraft(ask.to) ?? {}), draft_message: ask.draft });
    router.replace(`/conversation/${ask.to}`);
  }, [ask.to]);
  const open = useCallback((o: OrgGraphObject | null) => {
    if (!o) return false;
    const href = chartCardHref(o, useInboxStore.getState());
    if (!href) return false;
    router.push(href);
    return true;
  }, [router]);
  const openSession = useCallback((conversationId: string) => router.push(`/conversation/${conversationId}`), [router]);
  const view = orgChartViewOf(useInboxStore((st) => st.clientState.ui?.org_view));
  const setView = useCallback((v: OrgChartView) => useInboxStore.getState().updateClientUI({ org_view: v }), []);

  const people = useOrgPeopleView(tree);
  const moves = useOrgMoves(tree, people);
  const menu = useContextMenu<OrgLayoutNode>();
  const onNodeContextMenu = useCallback((e: React.MouseEvent, n: OrgLayoutNode) => menu.open(e, n, { force: true }), [menu]);
  const filter: MapFilter = view;
  return (
    <div className="flex h-full min-h-0 flex-col" style={{ background: "var(--sol-bg)" }} data-org-chart={view}>
      <header className="flex h-12 shrink-0 items-center gap-4 border-b px-5" style={{ borderColor: "color-mix(in srgb, var(--sol-border) 30%, transparent)" }}>
        <h1 className="text-[15px] font-medium" style={{ color: "var(--sol-text)" }}>Org</h1>
        <ViewSwitch value={view} onChange={setView} />
        {view !== "goals" && <ExpandAllToggle on={people.expandAll} onChange={people.setExpandAll} />}
      </header>
      <div className="relative min-h-0 flex-1">
        <OrgMap
          tree={tree}
          filter={filter}
          asProposed={false}
          onAsProposed={() => {}}
          toolbar={false}
          onOpenObject={open}
          onOpenSession={openSession}
          people={{
            view: people.view,
            loadingClusters: people.loadingClusters,
            onToggleCollapse: people.toggleCollapse,
            onExpandCluster: people.loadMore,
            onCollapseCluster: people.collapseCluster,
            onReparentRequest: moves.requestMove,
            onNodeContextMenu,
            canDrag: moves.canDrag,
            resetKey: moves.resetKey,
            onToggleOpen: people.toggleOpen,
            sessionProject: people.sessionProject,
          }}
        />
      </div>
      {people.pagers}
      {moves.ui}
      <ContextMenu state={menu}>
        {(n) => <OrgNodeMenu node={n} moves={moves} currentParentOf={people.currentParentOf} onToggleCollapse={people.toggleCollapse} onOpenSession={openSession} onOpenObject={open} />}
      </ContextMenu>
    </div>
  );
}
