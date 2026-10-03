"use client";
// The scope page's panel (docs/architecture/scopes-and-feed.md F4.1): the
// tabs a person needs as one panel beside the role's conversation (six for a
// role, four for the workspace; lib/scopeTabs.ts). Where it sits is the page's call:
// its own column on a wide window, an overlay over the conversation on a
// narrow one, and a bottom sheet on the phone that the conversation hands to
// and takes back. The tab is in the URL (?tab=) so a tab stays linkable.
//
// A role's panel opens on Overview (scopes-and-feed.md F5): a briefing, not a
// board. What the role is for, where each project stands in the role's own
// words and what it is doing, then its notes and what happened lately. Lists
// live one tab away, under Work, and the tab strip carries no numbers. The
// workspace root has no role to describe, so it opens on its activity.
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ChevronDown, Pencil, X } from "lucide-react";
import { cn } from "../../../lib/utils";
import { TaskListContent } from "../../../app/tasks/page";
import type { ScopeRef } from "../../../hooks/useScopeQueries";
import type { ScopeIds } from "../../../hooks/useScopeIds";
import type { OrgParentRef, OrgRole, OrgTree } from "../orgTypes";
import type { OrgUpdateRoleInput } from "../../../store/orgSlice";
import { ScopeFeed } from "./ScopeFeed";
import { ScopeBriefTab, ScopeCharterTab, ScopeDecisionsTab, ScopeDocsTab, ScopePlansTab, ScopeSessionsTab } from "./ScopeTabs";
import { TemplateSections } from "../TemplateSections";
import { useRoleScope } from "../../../hooks/useRoleScope";
import { useOpenLinkedSession } from "../../../hooks/useOpenLinkedSession";
import { EntityIdPill } from "../../EntityIdPill";
import { parseStandingSection, projectsWithLines, standingLineAgeDays, standingLineFor, standingLineStale } from "@codecast/shared/contracts/briefStanding";
import { ScopeSettings } from "./ScopeSettings";
import { ScopeLineTab } from "./ScopeLineTab";
import { ScopeTriggersTab } from "./ScopeTriggersTab";
import type { BriefPerson, RoleBrief, RoleCounters, ScopeSummary } from "./scopeTypes";
import { PersonGoals } from "./PersonGoals";
import { OrgHistory } from "../history/OrgHistory";
import type { PanelLayout } from "../../../hooks/usePanelLayout";
import { SCOPE_WORK_VIEWS, scopeTabsFor, type ScopeTabKey, type ScopeWorkView } from "../../../lib/scopeTabs";
import { MarkdownRenderer } from "../../tools/MarkdownRenderer";

export type ScopePanelLayout = PanelLayout;

/** How many entries of the record a role's Scope view shows before "earlier". */
const SCOPE_HISTORY_ENTRIES = 5;

export type ScopePanelProps = {
  tree: OrgTree;
  role: OrgRole | null;
  tab: ScopeTabKey;
  onTab: (next: ScopeTabKey) => void;
  /** The Work view a link written for an older tab opens on. */
  initialWorkView?: ScopeWorkView;
  onClose: () => void;
  layout: ScopePanelLayout;
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
  now: number;
  backHref: string;
  onUpdate: (fields: OrgUpdateRoleInput, opts?: { leave_sessions?: boolean }) => void;
  onReparent: (target: OrgParentRef) => void;
};

export function ScopePanel(p: ScopePanelProps) {
  const { tree, role, tab, layout } = p;
  const visibleTabs = scopeTabsFor(!!role);
  const [workView, setWorkView] = useState<ScopeWorkView>(p.initialWorkView ?? "tasks");
  const teamId = tree.workspace.kind === "team" ? tree.workspace.id : undefined;
  const stripRef = useRef<HTMLElement | null>(null);
  // A narrow panel scrolls its strip: the active tab scrolls into view so a
  // link straight to a tab lands on a tab the person can see.
  // eslint-disable-next-line no-restricted-syntax -- scrolls the active tab into the strip when it changes
  useEffect(() => {
    const el = stripRef.current?.querySelector<HTMLElement>(`[data-scope-tab="${tab}"]`);
    el?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [tab]);

  return (
    <div className="scope-panel-cq h-full flex flex-col min-h-0" data-scope-panel={layout} data-scope-tab-active={tab}>
      <style>{`.scope-panel-cq { container-type: inline-size; } @container (max-width: 560px) { .scope-tab-label { display: none; } }`}</style>
      <div className="shrink-0 flex items-center gap-1 border-b pl-1 pr-1.5" style={{ borderColor: "color-mix(in srgb, var(--sol-border) 22%, transparent)" }}>
        <nav ref={stripRef as any} className="flex-1 min-w-0 flex items-center gap-0.5 overflow-x-auto cq-no-scrollbar -mb-px" aria-label="Sections">
          {visibleTabs.map((t) => {
            const Icon = t.icon;
            const active = tab === t.key;
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => p.onTab(t.key)}
                data-scope-tab={t.key}
                className={cn("relative shrink-0 inline-flex items-center gap-1.5 h-8 text-[12px] transition-colors rounded-t-md", active ? "px-2 font-semibold" : "px-2 hover:bg-sol-bg-highlight/60")}
                style={{ color: active ? "var(--sol-text)" : "var(--sol-text-muted)" }}
                aria-current={active ? "page" : undefined}
                title={t.label}
                aria-label={t.label}
              >
                <Icon className="w-3.5 h-3.5" style={{ color: active ? "var(--sol-violet)" : undefined }} />
                {/* Every label shows where the panel is wide enough; a narrow one keeps the active tab's. */}
                <span className={cn(!active && "scope-tab-label")}>{t.label}</span>
                {active && <span className="absolute left-1.5 right-1.5 -bottom-px h-[2px] rounded-full" style={{ background: "var(--sol-violet)" }} />}
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
      {tab === "work" && (
        <div className="shrink-0 flex items-center gap-1 px-3 pt-2.5 pb-1.5" role="tablist" aria-label="Work" data-work-views>
          {SCOPE_WORK_VIEWS.map((v) => (
            <button key={v.key} type="button" role="tab" aria-selected={workView === v.key} onClick={() => setWorkView(v.key)} data-work-view={v.key} className={cn("h-6 px-2.5 rounded-full text-[11.5px] transition-colors", workView === v.key ? "font-semibold" : "hover:bg-sol-bg-highlight/60")} style={workView === v.key ? { background: "color-mix(in srgb, var(--sol-violet) 16%, transparent)", color: "var(--sol-text)" } : { color: "var(--sol-text-muted)" }}>
              {v.label}
            </button>
          ))}
        </div>
      )}
      {tab === "work" && workView === "tasks" && (
        <div className="flex-1 min-h-0">
          <TaskListContent scope={p.scopeIds.whole ? undefined : { projectIds: p.scopeIds.projectIds, planIds: p.scopeIds.planIds }} />
        </div>
      )}
      {tab !== "feed" && !(tab === "work" && workView === "tasks") && (
        <div data-scope-scroll className={cn("flex-1 min-h-0 overflow-y-auto", layout === "sheet" ? "px-2 py-3" : "px-3 py-3")}>
          {tab === "scope" && role && <RoleOverview {...p} role={role} />}
          {tab === "work" && workView === "status" && <ScopeLineTab ids={p.scopeIds} teamId={teamId} />}
          {tab === "work" && workView === "plans" && <ScopePlansTab ids={p.scopeIds} />}
          {tab === "work" && workView === "pages" && <ScopeDocsTab ids={p.scopeIds} />}
          {tab === "sessions" && <ScopeSessionsTab tree={tree} role={role} scope={p.scopeRef} hands={p.brief?.facts?.hands ?? null} />}
          {tab === "decisions" && <ScopeDecisionsTab ids={p.scopeIds} roleId={role?._id ?? null} />}
          {tab === "triggers" && role && <ScopeTriggersTab standingConversationId={p.brief?.role.standing_conversation_id ?? null} />}
          {tab === "settings" && role && (
            <ScopeSettings tree={tree} role={role} canEdit={p.canEdit} overlaps={p.summary?.overlaps ?? []} hostName={p.hostName} model={p.model} standingId={p.standingId} counters={p.counters} onUpdate={p.onUpdate} onReparent={p.onReparent} history={<RoleHistory roleId={role._id} />} />
          )}
        </div>
      )}
    </div>
  );
}

/** The record of what changed this role (org-staffing.md S21), newest first;
 *  the newest few, the rest open in place. Lives on Settings, where the role
 *  is changed. */
function RoleHistory({ roleId }: { roleId: string }) {
  const [all, setAll] = useState(false);
  return <OrgHistory roleId={roleId} limit={all ? undefined : SCOPE_HISTORY_ENTRIES} onMore={() => setAll(true)} />;
}

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

/** A role's Overview: what it is for (the charter, edited in place), the
 *  briefing, the viewer's goals, the role's own notes behind a fold, and what
 *  happened in its area lately. */
function RoleOverview(p: ScopePanelProps & { role: OrgRole }) {
  const { tree, role } = p;
  const [editingCharter, setEditingCharter] = useState(false);
  // The role's own short statement reads here; the charter document (its
  // longer form, when the role has one) opens under Edit.
  const charter = (role.charter ?? "").trim() || (p.brief?.charter ?? "").trim();
  const me = viewerGoals(tree, role, p.brief?.facts?.people);
  return (
    <div className="space-y-6" data-role-overview>
      <section data-scope-section="charter">
        <h3 className={cn(BLOCK_LABEL, "flex items-center gap-2")} style={{ color: "var(--sol-text-dim)" }}>
          What it is for
          {p.canEdit && (
            <button type="button" onClick={() => setEditingCharter((v) => !v)} className="inline-flex items-center gap-1 font-normal normal-case tracking-normal text-[11px] hover:underline" style={{ color: "var(--sol-violet)" }} data-charter-edit>
              {editingCharter ? "Done" : <><Pencil className="w-3 h-3" /> Edit</>}
            </button>
          )}
        </h3>
        {editingCharter ? (
          <ScopeCharterTab role={role} charter={charter} canEdit={p.canEdit} backHref={p.backHref} onUpdateCharter={(v) => p.onUpdate({ charter: v })} />
        ) : charter ? (
          role.charter?.trim()
            ? <p className="px-2.5 text-[13px] leading-relaxed whitespace-pre-wrap" style={{ color: "var(--sol-text-secondary)" }} data-role-charter>{charter}</p>
            : <div className="px-2.5 text-[13px] leading-relaxed" style={{ color: "var(--sol-text-secondary)" }} data-role-charter><MarkdownRenderer content={charter} /></div>
        ) : (
          <p className="px-2.5 text-[13px]" style={{ color: "var(--sol-text-dim)" }}>Nobody has written what this role is for yet.</p>
        )}
      </section>

      <ScopeOverviewTab role={role} now={p.now} narrative={p.brief?.narrative} briefLoaded={p.brief !== undefined} />

      {me && (
        <section data-scope-section="goals">
          <h3 className={BLOCK_LABEL} style={{ color: "var(--sol-text-dim)" }}>Your goals</h3>
          <PersonGoals person={me} roleHandle={role.handle} now={p.now} own />
        </section>
      )}
      <TemplateSections roleId={role._id} canEdit={p.canEdit} teamId={p.tree.workspace.kind === "team" ? p.tree.workspace.id : undefined} />

      <details className="group" data-scope-section="notes">
        <summary className={cn(BLOCK_LABEL, "cursor-pointer select-none list-none flex items-center gap-1.5 mb-0")} style={{ color: "var(--sol-text-dim)" }}>
          <ChevronDown className="w-3 h-3 -rotate-90 transition-transform group-open:rotate-0" /> Its notes
        </summary>
        <div className="mt-2.5">
          <ScopeBriefTab role={role} facts={p.brief?.facts ?? null} factsProblem={p.briefProblem} narrative={p.brief?.narrative ?? ""} canEdit={p.canEditBrief} backHref={p.backHref} />
        </div>
      </details>

      {p.scopeRef && (
        <section data-scope-section="lately">
          <h3 className={BLOCK_LABEL} style={{ color: "var(--sol-text-dim)" }}>Lately</h3>
          <ScopeFeed key={JSON.stringify(p.scopeRef)} scope={p.scopeRef} plain />
        </section>
      )}
    </div>
  );
}

const BLOCK_LABEL = "px-2.5 mb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.08em]";

/** The briefing (F5.1): where each project stands and what the role is
 *  doing, in words. The only number on it is inside the activity line; the
 *  mount test holds it to that. */
export function ScopeOverviewTab({ role, now, narrative, briefLoaded }: { role: OrgRole; now: number; narrative: string | null | undefined; briefLoaded: boolean }) {
  const { model } = useRoleScope(role.short_id);
  const standing = useMemo(() => parseStandingSection(narrative), [narrative]);
  const projects = model?.projects ?? role.scope_names.projects.map((p) => ({ id: p.id, ref: p.short_id ?? p.id, title: p.title }));
  const written = projectsWithLines(standing, projects.map((p) => ({ ...p, short_id: p.ref })));
  return (
    <div className="space-y-6" data-scope-briefing>
      {written.length > 0 && (
        <section data-scope-section="stands">
          <h3 className={BLOCK_LABEL} style={{ color: "var(--sol-text-dim)" }}>Where it stands</h3>
          <ul className="space-y-2">
            {written.map(({ project: p, line }) => {
              const stale = standingLineStale(line, now);
              const days = standingLineAgeDays(line, now);
              return (
                <li key={p.id} className="px-2.5" data-scope-stands={p.ref}>
                  <Link href={`/projects/${p.ref}`} className="text-[12.5px] font-semibold text-sol-text no-underline hover:underline underline-offset-2">{p.title}</Link>
                  <p className="text-[13px] leading-relaxed" style={{ color: "var(--sol-text-secondary)" }} data-scope-stands-line>
                    {line.text}
                    {stale && days !== null && <span className="ml-1.5 text-[11px]" style={{ color: "var(--sol-yellow)" }} data-scope-stands-age={days}>written {days} days ago</span>}
                  </p>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section data-scope-section="doing">
        <h3 className={BLOCK_LABEL} style={{ color: "var(--sol-text-dim)" }}>What it is doing</h3>
        <RoleDoing role={role} className="px-2.5 text-[13px]" />
      </section>
    </div>
  );
}

/** What a role is doing (F5.1): the sessions at work under it, and the one it
 *  moved most recently, from the tree's own rows. The Overview says it in
 *  full, with the session it is on; `short` is the collapsed glance's count. */
export function RoleDoing({ role, short, className }: { role: OrgRole; short?: boolean; className?: string }) {
  const openLinked = useOpenLinkedSession();
  const active = role.counts.working ?? 0;
  const current = [...role.sessions].filter((s) => s.state === "working").sort((a, b) => b.updated_at - a.updated_at)[0]
    ?? [...role.sessions].sort((a, b) => b.updated_at - a.updated_at)[0];
  const line = short
    ? (role.total === 0 ? "no sessions yet" : active === 0 ? "nothing at work" : `${active} at work`)
    : (role.total === 0 ? "No sessions under it yet." : active === 0 ? "No session at work right now." : `${active} ${active === 1 ? "session" : "sessions"} at work`);
  return (
    <p className={cn("flex items-center gap-2 flex-wrap", className)} style={{ color: "var(--sol-text-secondary)" }} data-scope-doing={active}>
      {line}
      {current && !short && (
        <span className="inline-flex items-center gap-1.5 min-w-0" onClick={() => { openLinked({ _id: current._id, short_id: current.short_id, title: current.title, agent_type: current.agent_type }); }}>
          <span style={{ color: "var(--sol-text-dim)" }}>{active > 0 ? "· on" : "· last"}</span>
          <EntityIdPill id={current._id} shortId={current.short_id} type="session" compact />
        </span>
      )}
    </p>
  );
}
