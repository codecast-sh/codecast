"use client";
// The scope page's panel (docs/architecture/scopes-and-feed.md F4.1): the
// eleven tabs of F3 as one panel beside the role's conversation. The panel
// keeps its tabs; it stops being the page. Where it sits is the page's call:
// its own column on a wide window, an overlay over the conversation on a
// narrow one, and a bottom sheet on the phone that the conversation hands to
// and takes back. The tab is in the URL (?tab=) so a tab stays linkable.
//
// A role's panel opens on Scope (scopes-and-feed.md F5): a briefing, not a
// board. Three blocks a person reads in ten seconds: what needs them, where
// each project stands in the role's own words, and what the role is doing.
// Counts and lists live one tab away, and the tab strip carries no numbers.
// The workspace root has no role to describe, so it still opens on the feed.
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ChevronDown, X } from "lucide-react";
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
import { RoleEscalationLines } from "../../RoleEscalationLines";
import { EntityIdPill } from "../../EntityIdPill";
import type { RoleEscalation } from "@codecast/shared/contracts";
import { noWordYet, parseStandingSection, standingLineAgeDays, standingLineFor, standingLineStale } from "@codecast/shared/contracts/briefStanding";
import { ScopeSettings } from "./ScopeSettings";
import { ScopeLineTab } from "./ScopeLineTab";
import { ScopeTriggersTab } from "./ScopeTriggersTab";
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
  /** What the role put in front of the person (R1, revised): the first
   *  screen's first block, from the same helper the inbox card reads. */
  escalations: RoleEscalation[];
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
          {tab === "scope" && role && <ScopeOverviewTab role={role} now={p.now} canEdit={p.canEdit} escalations={p.escalations} narrative={p.brief?.narrative} briefLoaded={p.brief !== undefined} />}
          {tab === "line" && <ScopeLineTab ids={p.scopeIds} teamId={teamId} />}
          {tab === "plans" && <ScopePlansTab ids={p.scopeIds} />}
          {tab === "docs" && <ScopeDocsTab ids={p.scopeIds} />}
          {tab === "sessions" && <ScopeSessionsTab tree={tree} role={role} scope={p.scopeRef} hands={p.brief?.facts?.hands ?? null} />}
          {tab === "decisions" && <ScopeDecisionsTab ids={p.scopeIds} roleId={role?._id ?? null} />}
          {tab === "brief" && role && (
            <ScopeBriefTab
              role={role}
              facts={p.brief?.facts ?? null}
              factsProblem={p.briefProblem}
              narrative={p.brief?.narrative ?? ""}
              canEdit={p.canEditBrief}
              backHref={p.backHref}
              goals={(() => { const me = viewerGoals(tree, role, p.brief?.facts?.people); return me ? <PersonGoals person={me} roleHandle={role.handle} now={p.now} own /> : null; })()}
              template={<TemplateSections roleId={role._id} canEdit={p.canEdit} />}
            />
          )}
          {tab === "triggers" && role && <ScopeTriggersTab standingConversationId={p.brief?.role.standing_conversation_id ?? null} />}
          {tab === "charter" && role && <ScopeCharterTab role={role} charter={p.brief?.charter ?? role.charter ?? ""} canEdit={p.canEdit} backHref={p.backHref} onUpdateCharter={(v) => p.onUpdate({ charter: v })} />}
          {tab === "settings" && role && (
            <ScopeSettings tree={tree} role={role} canEdit={p.canEdit} overlaps={p.summary?.overlaps ?? []} hostName={p.hostName} model={p.model} standingId={p.standingId} counters={p.counters} armRetire={p.armRetire} onUpdate={p.onUpdate} onReparent={p.onReparent} onRetire={p.onRetire} history={<RoleHistory roleId={role._id} />} />
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

const BLOCK_LABEL = "px-2.5 mb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.08em]";

/** The first screen (F5.1): three questions, in words, in this order. Every
 *  number on it is inside an escalation's own line or the activity line;
 *  the mount test holds it to that. */
export function ScopeOverviewTab({ role, now, canEdit, escalations, narrative, briefLoaded }: { role: OrgRole; now: number; canEdit: boolean; escalations: RoleEscalation[]; narrative: string | null | undefined; briefLoaded: boolean }) {
  const { model } = useRoleScope(role.short_id);
  const openLinked = useOpenLinkedSession();
  const openId = (id: string) => {
    const s = role.sessions.find((x) => x._id === id);
    openLinked(s ? { _id: s._id, short_id: s.short_id, title: s.title, agent_type: s.agent_type } : { _id: id });
  };
  const standing = useMemo(() => parseStandingSection(narrative), [narrative]);
  const projects = model?.projects ?? role.scope_names.projects.map((p) => ({ id: p.id, ref: p.short_id ?? p.id, title: p.title }));
  // What it is doing: the sessions at work under it, and the one it moved
  // most recently, from the tree's own rows.
  const active = role.counts.working ?? 0;
  const current = [...role.sessions].filter((s) => s.state === "working").sort((a, b) => b.updated_at - a.updated_at)[0]
    ?? [...role.sessions].sort((a, b) => b.updated_at - a.updated_at)[0];
  return (
    <div className="space-y-6" data-scope-briefing>
      <section data-scope-section="needs-you">
        <h3 className={BLOCK_LABEL} style={{ color: "var(--sol-text-dim)" }}>Needs you</h3>
        {escalations.length > 0 ? (
          <div className="px-1"><RoleEscalationLines escalations={escalations} coarseNow={now} canHandBack={canEdit} onOpen={openId} /></div>
        ) : (
          <p className="px-2.5 text-[13px]" style={{ color: "var(--sol-text-muted)" }} data-scope-needs-nothing>Nothing needs you.</p>
        )}
      </section>

      <section data-scope-section="stands">
        <h3 className={BLOCK_LABEL} style={{ color: "var(--sol-text-dim)" }}>Where it stands</h3>
        {projects.length === 0 ? (
          <p className="px-2.5 text-[12.5px]" style={{ color: "var(--sol-text-dim)" }}>No project in its scope yet.</p>
        ) : (
          <ul className="space-y-2">
            {projects.map((p) => {
              const line = standingLineFor(standing, { title: p.title, short_id: p.ref });
              const stale = line && standingLineStale(line, now);
              const days = line ? standingLineAgeDays(line, now) : null;
              return (
                <li key={p.id} className="px-2.5" data-scope-stands={p.ref}>
                  <Link href={`/projects/${p.ref}`} className="text-[12.5px] font-semibold text-sol-text no-underline hover:underline underline-offset-2">{p.title}</Link>
                  {line ? (
                    <p className="text-[13px] leading-relaxed" style={{ color: "var(--sol-text-secondary)" }} data-scope-stands-line>
                      {line.text}
                      {stale && days !== null && <span className="ml-1.5 text-[11px]" style={{ color: "var(--sol-yellow)" }} data-scope-stands-age={days}>written {days} days ago</span>}
                    </p>
                  ) : (
                    <p className="text-[13px] italic" style={{ color: "var(--sol-text-dim)" }} data-scope-stands-line="">{briefLoaded ? noWordYet(role.handle) : "\u2007"}</p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section data-scope-section="doing">
        <h3 className={BLOCK_LABEL} style={{ color: "var(--sol-text-dim)" }}>What it is doing</h3>
        <p className="px-2.5 text-[13px] flex items-center gap-2 flex-wrap" style={{ color: "var(--sol-text-secondary)" }} data-scope-doing={active}>
          {role.total === 0 ? "No sessions under it yet." : active === 0 ? "No session at work right now." : `${active} ${active === 1 ? "session" : "sessions"} at work`}
          {current && (
            <span className="inline-flex items-center gap-1.5 min-w-0" onClick={() => openId(current._id)}>
              <span style={{ color: "var(--sol-text-dim)" }}>{active > 0 ? "· on" : "· last"}</span>
              <EntityIdPill id={current._id} shortId={current.short_id} type="session" compact />
            </span>
          )}
        </p>
      </section>
    </div>
  );
}
