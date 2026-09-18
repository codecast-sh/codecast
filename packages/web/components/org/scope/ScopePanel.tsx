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
import { useEffect, useRef } from "react";
import { BellRing, CheckSquare, ChevronDown, Compass, FileText, Layers, ListChecks, MessageCircleQuestionMark, Rss, ScrollText, Settings2, Terminal, Workflow, X } from "lucide-react";
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
import { useRoleScope } from "../../../hooks/useRoleScope";
import { useOpenLinkedSession } from "../../../hooks/useOpenLinkedSession";
import { ScopeSettings } from "./ScopeSettings";
import { ScopeLineTab } from "./ScopeLineTab";
import { ScopeWakesTab } from "./ScopeWakesTab";
import type { RoleBrief, RoleCounters, ScopeSummary } from "./scopeTypes";

export type ScopeTabKey = "scope" | "feed" | "tasks" | "line" | "plans" | "docs" | "sessions" | "decisions" | "brief" | "charter" | "wakes" | "settings";
export const SCOPE_TABS: { key: ScopeTabKey; label: string; icon: any; roleOnly?: boolean }[] = [
  { key: "scope", label: "Scope", icon: Compass, roleOnly: true },
  { key: "feed", label: "Feed", icon: Rss },
  { key: "tasks", label: "Tasks", icon: ListChecks },
  // The line (the-line.md L10): the scope's tasks by station.
  { key: "line", label: "Line", icon: Workflow },
  { key: "plans", label: "Plans", icon: Layers },
  { key: "docs", label: "Docs", icon: FileText },
  { key: "sessions", label: "Sessions", icon: Terminal },
  { key: "decisions", label: "Decisions", icon: MessageCircleQuestionMark },
  { key: "brief", label: "Brief", icon: ScrollText, roleOnly: true },
  { key: "charter", label: "Charter", icon: CheckSquare, roleOnly: true },
  { key: "wakes", label: "Wakes", icon: BellRing, roleOnly: true },
  { key: "settings", label: "Settings", icon: Settings2, roleOnly: true },
];

/** The tab a scope opens on, and the one its bare URL means: a role's Scope,
 *  the workspace root's feed. */
export function scopeDefaultTab(hasRole: boolean): ScopeTabKey {
  return hasRole ? "scope" : "feed";
}

/** The tab a URL names, when it is one this scope shows; else the default. */
export function scopeTabFromParam(param: string | null, hasRole: boolean): ScopeTabKey {
  const hit = SCOPE_TABS.find((t) => t.key === param && (!t.roleOnly || hasRole));
  return hit ? hit.key : scopeDefaultTab(hasRole);
}

export type ScopePanelLayout = "side" | "overlay" | "sheet";

/** The width of the panel's own column and of the overlay. */
export const SCOPE_PANEL_W = 440;

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
  counters: RoleCounters | null;
  armRetire: boolean;
  now: number;
  wakeHighlight: string | null;
  backHref: string;
  onUpdate: (fields: OrgUpdateRoleInput) => void;
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
          {tab === "scope" && role && <ScopeOverviewTab role={role} now={p.now} onTab={p.onTab} />}
          {tab === "line" && <ScopeLineTab ids={p.scopeIds} teamId={teamId} />}
          {tab === "plans" && <ScopePlansTab ids={p.scopeIds} />}
          {tab === "docs" && <ScopeDocsTab ids={p.scopeIds} />}
          {tab === "sessions" && <ScopeSessionsTab tree={tree} role={role} scope={p.scopeRef} hands={p.brief?.facts?.hands ?? null} />}
          {tab === "decisions" && <ScopeDecisionsTab ids={p.scopeIds} roleId={role?._id ?? null} />}
          {tab === "brief" && role && <ScopeBriefTab role={role} facts={p.brief?.facts ?? null} factsProblem={p.briefProblem} narrative={p.brief?.narrative ?? ""} canEdit={p.canEditBrief} backHref={p.backHref} />}
          {tab === "wakes" && role && <ScopeWakesTab role={role} highlight={p.wakeHighlight} now={p.now} />}
          {tab === "charter" && role && <ScopeCharterTab role={role} charter={p.brief?.charter ?? role.charter ?? ""} canEdit={p.canEdit} backHref={p.backHref} onUpdateCharter={(v) => p.onUpdate({ charter: v })} />}
          {tab === "settings" && role && (
            <ScopeSettings tree={tree} role={role} canEdit={p.canEdit} overlaps={p.summary?.overlaps ?? []} hostName={p.hostName} model={p.model} counters={p.counters} armRetire={p.armRetire} onUpdate={p.onUpdate} onReparent={p.onReparent} onRetire={p.onRetire} />
          )}
        </div>
      )}
    </div>
  );
}

/** The Scope tab: RoleScopeView at full size, with the two pieces only the
 *  page can afford, a project's lead chip and the role's sessions grouped by
 *  who acts next (the tree's top rows; the Sessions tab pages the rest). */
function ScopeOverviewTab({ role, now, onTab }: { role: OrgRole; now: number; onTab: (next: ScopeTabKey) => void }) {
  const { model, escalated } = useRoleScope(role.short_id);
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
      renderLead={(projectId) => <ProjectLeadChip projectId={projectId} size="xs" />}
      sessions={rest.length > 0 ? <HandGroups rows={rest} now={now} onOpen={open} /> : null}
      onTab={onTab}
      onOpenSession={open}
    />
  );
}
