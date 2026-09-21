"use client";
// The scope page's panel (docs/architecture/scopes-and-feed.md F4.1): the
// eleven tabs of F3 as one panel beside the role's conversation. The panel
// keeps its tabs; it stops being the page. Where it sits is the page's call:
// its own column on a wide window, an overlay over the conversation on a
// narrow one, and a bottom sheet on the phone that the conversation hands to
// and takes back. The tab is in the URL (?tab=) so a tab stays linkable.
//
// A role's panel opens on Scope (org-roles-run-work.md R3): what the role
// looks after, as the same rendering its hover card uses, at full size. The
// workspace root has no role to describe, so it still opens on the feed.
import { useEffect, useRef, useState } from "react";
import { ChevronDown, X } from "lucide-react";
import { cn } from "../../../lib/utils";
import { TaskListContent } from "../../../app/tasks/page";
import type { ScopeRef } from "../../../hooks/useScopeQueries";
import type { ScopeIds } from "../../../hooks/useScopeIds";
import type { OrgParentRef, OrgRole, OrgTree } from "../orgTypes";
import type { OrgUpdateRoleInput } from "../../../store/orgSlice";
import { ScopeFeed } from "./ScopeFeed";
import { Empty, HandGroups, ScopeBriefTab, ScopeCharterTab, ScopeDecisionsTab, ScopeDocsTab, ScopePlansTab, ScopeSessionsTab } from "./ScopeTabs";
import { RoleScopeView } from "../../identity/RoleScopeView";
import { ProjectLeadChip } from "../../charter/ProjectLeadChip";
import { ProjectInitiatives } from "../../initiatives/ProjectInitiatives";
import { useRoleScope } from "../../../hooks/useRoleScope";
import { useOpenLinkedSession } from "../../../hooks/useOpenLinkedSession";
import { useInboxStore } from "../../../store/inboxStore";
import { ScopeSettings } from "./ScopeSettings";
import { ScopeLineTab } from "./ScopeLineTab";
import { ScopeWakesTab } from "./ScopeWakesTab";
import type { BriefPerson, RoleBrief, RoleCounters, ScopeSummary } from "./scopeTypes";
import { PersonGoals } from "./PersonGoals";
import { OrgHistory } from "../history/OrgHistory";
import type { PanelLayout } from "../../../hooks/usePanelLayout";
import type { ScopeTabKey } from "../../../lib/scopeTabs";
import { SCOPE_TABS } from "../../../lib/scopeTabs";

export type ScopePanelLayout = PanelLayout;

/** How many entries of the record a role's Scope view shows before "earlier". */
const SCOPE_HISTORY_ENTRIES = 5;

export type ScopePanelProps = {
  tree: OrgTree;
  role: OrgRole | null;
  tab: ScopeTabKey;
  onTab: (next: ScopeTabKey) => void;
  onClose: () => void;
  layout: ScopePanelLayout;
  /** Hands under this scope waiting on a person (F4.1): the Sessions tab
   *  carries the number so the person knows where to look. */
  waiting: number;
  scopeRef: ScopeRef | null;
  scopeIds: ScopeIds;
  summary: ScopeSummary | null | undefined;
  summaryProblem: string | null;
  brief: RoleBrief | null | undefined;
  briefProblem: string | null;
  canEdit: boolean;
  canEditBrief: boolean;
  hostName: string;
  model: string | null;
  /** The standing session; Settings says where it runs. */
  standingId: string | null;
  counters: RoleCounters | null;
  armRetire: boolean;
  now: number;
  wakeHighlight: string | null;
  backHref: string;
  onUpdate: (fields: OrgUpdateRoleInput, opts?: { leave_sessions?: boolean }) => void;
  onReparent: (target: OrgParentRef) => void;
  onRetire: (standingSession?: "keep" | "retire") => void;
};

export function ScopePanel(p: ScopePanelProps) {
  const { tree, role, tab, layout } = p;
  const visibleTabs = SCOPE_TABS.filter((t) => !t.roleOnly || role);
  const teamId = tree.workspace.kind === "team" ? tree.workspace.id : undefined;
  const stripRef = useRef<HTMLElement | null>(null);
  // Eleven tabs do not fit the panel's width: the active one scrolls into view
  // so a link straight to a tab lands on a tab the person can see.
  // eslint-disable-next-line no-restricted-syntax -- scrolls the active tab into the strip when it changes
  useEffect(() => {
    const el = stripRef.current?.querySelector<HTMLElement>(`[data-scope-tab="${tab}"]`);
    el?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [tab]);

  return (
    <div className="h-full flex flex-col min-h-0" data-scope-panel={layout} data-scope-tab-active={tab}>
      <div className="shrink-0 flex items-center gap-1 border-b pl-1 pr-1.5" style={{ borderColor: "color-mix(in srgb, var(--sol-border) 22%, transparent)" }}>
        <nav ref={stripRef as any} className="flex-1 min-w-0 flex items-center gap-0.5 overflow-x-auto cq-no-scrollbar -mb-px" aria-label="Scope sections">
          {visibleTabs.map((t) => {
            const Icon = t.icon;
            const active = tab === t.key;
            const count = t.key === "decisions" ? p.summary?.decisions.open : t.key === "tasks" ? p.summary?.tasks.open : t.key === "sessions" ? p.waiting : undefined;
            const hot = t.key === "sessions" && (p.waiting ?? 0) > 0;
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => p.onTab(t.key)}
                data-scope-tab={t.key}
                className={cn("relative shrink-0 inline-flex items-center gap-1.5 h-9 px-2.5 text-[12px] transition-colors rounded-t-md", active ? "font-semibold" : "hover:bg-sol-bg-highlight/60")}
                style={{ color: active ? "var(--sol-text)" : "var(--sol-text-muted)" }}
                aria-current={active ? "page" : undefined}
                title={t.label}
              >
                <Icon className="w-3.5 h-3.5" style={{ color: active ? "var(--sol-violet)" : undefined }} />
                {t.label}
                {count ? <span className="text-[10px] tabular-nums px-1 rounded-sm" style={{ background: hot ? "color-mix(in srgb, var(--sol-yellow) 18%, transparent)" : "color-mix(in srgb, var(--sol-border) 30%, transparent)", color: hot ? "var(--sol-yellow)" : "var(--sol-text-dim)" }} data-scope-tab-count={count}>{count}</span> : null}
                {active && <span className="absolute left-2 right-2 -bottom-px h-[2px] rounded-full" style={{ background: "var(--sol-violet)" }} />}
              </button>
            );
          })}
        </nav>
        <button
          type="button"
          onClick={p.onClose}
          className="shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-md hover:bg-sol-bg-highlight/70"
          style={{ color: "var(--sol-text-muted)" }}
          aria-label={layout === "sheet" ? "Back to the conversation" : "Close the board"}
          title={layout === "sheet" ? "Back to the conversation" : "Close the board"}
          data-scope-panel-close
        >
          {layout === "sheet" ? <ChevronDown className="w-4 h-4" /> : <X className="w-4 h-4" />}
        </button>
      </div>

      {tab === "feed" && p.scopeRef && <ScopeFeed key={JSON.stringify(p.scopeRef)} scope={p.scopeRef} fill />}
      {tab === "tasks" && (
        <div className="flex-1 min-h-0">
          <TaskListContent scope={p.scopeIds.whole ? undefined : { projectIds: p.scopeIds.projectIds, planIds: p.scopeIds.planIds }} />
        </div>
      )}
      {tab !== "feed" && tab !== "tasks" && (
        <div data-scope-scroll className={cn("flex-1 min-h-0 overflow-y-auto", layout === "sheet" ? "px-2 py-3" : "px-3 py-3")}>
          {!p.summary && p.summaryProblem && <p className="px-2.5 pb-2 text-[11px]" style={{ color: "var(--sol-text-dim)" }}>{p.summaryProblem}</p>}
          {tab === "scope" && role && <ScopeOverviewTab role={role} now={p.now} canEdit={p.canEdit} waiting={p.waiting} onTab={p.onTab} me={viewerGoals(tree, role, p.brief?.facts?.people)} />}
          {tab === "line" && <ScopeLineTab ids={p.scopeIds} teamId={teamId} />}
          {tab === "plans" && <ScopePlansTab ids={p.scopeIds} />}
          {tab === "docs" && <ScopeDocsTab ids={p.scopeIds} />}
          {tab === "sessions" && <ScopeSessionsTab tree={tree} role={role} scope={p.scopeRef} hands={p.brief?.facts?.hands ?? null} />}
          {tab === "decisions" && <ScopeDecisionsTab ids={p.scopeIds} roleId={role?._id ?? null} />}
          {tab === "brief" && role && <ScopeBriefTab role={role} facts={p.brief?.facts ?? null} factsProblem={p.briefProblem} narrative={p.brief?.narrative ?? ""} canEdit={p.canEditBrief} backHref={p.backHref} />}
          {tab === "wakes" && role && <ScopeWakesTab role={role} highlight={p.wakeHighlight} now={p.now} />}
          {tab === "charter" && role && <ScopeCharterTab role={role} charter={p.brief?.charter ?? role.charter ?? ""} canEdit={p.canEdit} backHref={p.backHref} onUpdateCharter={(v) => p.onUpdate({ charter: v })} />}
          {tab === "settings" && role && (
            <ScopeSettings tree={tree} role={role} canEdit={p.canEdit} overlaps={p.summary?.overlaps ?? []} hostName={p.hostName} model={p.model} standingId={p.standingId} counters={p.counters} armRetire={p.armRetire} onUpdate={p.onUpdate} onReparent={p.onReparent} onRetire={p.onRetire} />
          )}
        </div>
      )}
    </div>
  );
}

/** The Scope tab: RoleScopeView at full size, with the two pieces only the
 *  page can afford, a project's lead chip and the role's sessions grouped by
 *  who acts next (the tree's top rows; the Sessions tab pages the rest). */
/** The viewer's row among the people who report to the role. The brief is
 *  what knows the goals, so nothing shows until it answers; a viewer who just
 *  started reporting (the tree has them, the brief not yet) gets an empty
 *  row, so the section says where goals go. */
function viewerGoals(tree: OrgTree, role: OrgRole, people: BriefPerson[] | undefined): BriefPerson | null {
  const me = tree.people.find((x) => x.is_me);
  if (!people || !me || !(role.reports_user_ids ?? []).includes(me.user_id)) return null;
  return people.find((x) => x.user_id === me.user_id)
    ?? { user_id: me.user_id, name: me.name, has_section: false, goals: [], sessions_changed: [], sessions_total: 0, stalled_high: 0 };
}

function ScopeOverviewTab({ role, now, canEdit, waiting, onTab, me }: { role: OrgRole; now: number; canEdit: boolean; waiting: number; onTab: (next: ScopeTabKey) => void; me: BriefPerson | null }) {
  const { model, escalated } = useRoleScope(role.short_id);
  // The newest few changes to the role; the rest open in place.
  const [allHistory, setAllHistory] = useState(false);
  const openLinked = useOpenLinkedSession();
  const open = (s: { _id: string; short_id: string; title: string; agent_type: string }) => openLinked({ _id: s._id, short_id: s.short_id, title: s.title, agent_type: s.agent_type });
  if (!model) return <Empty title="Nothing to show for this role yet." />;
  const escalatedIds = new Set(escalated.map((e) => e.session._id));
  const rest = role.sessions.filter((s) => !escalatedIds.has(s._id));
  return (
    <RoleScopeView
      model={model}
      density="page"
      escalated={escalated}
      waitingInArea={waiting}
      renderLead={(projectId) => <ProjectLeadChip projectId={projectId} size="xs" />}
      renderInitiative={(projectId) => <ProjectInitiatives projectId={projectId} size="xs" />}
      // The draft moves the plan into its project's card in this tick; the
      // named side effect (dispatch.updatePlan) makes the write.
      onFilePlan={canEdit ? (planRef, projectId) => useInboxStore.getState().updatePlan(planRef, { project_id: projectId }) : undefined}
      sessions={rest.length > 0 ? <HandGroups rows={rest} now={now} onOpen={open} /> : null}
      goals={me ? <PersonGoals person={me} roleHandle={role.handle} now={now} own /> : null}
      history={<OrgHistory roleId={role._id} limit={allHistory ? undefined : SCOPE_HISTORY_ENTRIES} onMore={() => setAllHistory(true)} />}
      onTab={onTab}
      onOpenSession={open}
    />
  );
}
