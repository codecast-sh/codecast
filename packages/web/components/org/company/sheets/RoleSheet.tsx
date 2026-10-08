"use client";
// A role's sheet (cohesive build spec §5.4): the same head its hover card
// and its line say (whom it reports to, its state, what it carries, since
// when; the goals it drives; Ask it), then what it is for, where its
// projects stand in its own words, Now with what it is doing, its week, what
// carries it, the working tabs (Work, Sessions, Decisions, Triggers,
// Settings) and, folded at the foot, its playbook, how it wakes and its notes.
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Pencil } from "lucide-react";
import { objectHref } from "@codecast/shared/entities";
import { parsePlaybook, playbookIsEmpty, roleWakeOf, wakeWords } from "@codecast/shared/contracts/rolePlaybook";
import { useInboxStore, type PlanItem, type ProjectItem } from "../../../../store/inboxStore";
import { useSyncPlans } from "../../../../hooks/useSyncPlans";
import { useSyncTasks } from "../../../../hooks/useSyncTasks";
import { useSyncDocs } from "../../../../hooks/useSyncDocs";
import { useSyncOrgHealth } from "../../../../hooks/useSyncOrgHealth";
import { useWorkspaceCollection } from "../../../../hooks/useWorkspaceCollection";
import { useBoardTasks, useTasksBackfilled } from "../../../../hooks/useInitiatives";
import { useCoarseNow } from "../../../../hooks/useCoarseNow";
import { useRoleBrief, useScopeSummary, type ScopeRef } from "../../../../hooks/useScopeQueries";
import { useScopeIds } from "../../../../hooks/useScopeIds";
import { isHeaderPinned, toggleHeaderPin } from "../../../../lib/headerPins";
import { canEditRole, queryProblem, scopeQueryRef } from "../../../../lib/scopePage";
import type { ScopeTabKey } from "../../../../lib/scopeTabs";
import { RoleStands, ScopePanel } from "../../scope/ScopePanel";
import { ScopeBriefTab, ScopeCharterTab } from "../../scope/ScopeTabs";
import { RolePlaybook, RoleWakeLine } from "../../scope/RolePlaybook";
import type { RoleBrief } from "../../scope/scopeTypes";
import { TemplateSections } from "../../TemplateSections";
import { useTemplateInstance } from "../../../../hooks/useTemplateHire";
import { RoleFace } from "../../RoleFace";
import { RoleWeekBody } from "../../orgFlowViz";
import { FixLoopLine, HealthNote, RoleLevers } from "../../healthParts";
import { DEFAULT_ROLE_CAPS } from "@codecast/shared/contracts/orgCapacity";
import { toast } from "sonner";
import { flowDays, roleFlows } from "../../orgFlow";
import { lineProjectOf, ProjectLine, RoleLine, useRoleHead } from "../../lines";
import { findHeadOfPeople, rolesInTreeOrder } from "../../staffingModel";
import type { OrgParentRef, OrgRole, OrgTree } from "../../orgTypes";
import { findRole, seatFor } from "../objects";
import { NowBlock } from "../NowBlock";
import { ObjectLink, SheetFold, SheetFolds, SheetFrame, SheetSection, type SheetMenuItem } from "../SheetFrame";
import type { SheetRef } from "../sheetStack";
import { useCompanyRows, type CompanyRows } from "../useCompanyRows";
import { CarriedLines, NotHere, RoleNowLine } from "./sheetParts";
import { reportsChain, reportsToNamed, roleNow, workspaceCrumb } from "./sheetModel";

const todayUtc = () => new Date().toISOString().slice(0, 10);
const DIM = "var(--sol-text-dim)";

/** The working tabs under the summary: the Overview is the sheet itself. */
const WORKING_TABS: readonly ScopeTabKey[] = ["work", "sessions", "decisions", "triggers", "settings"];

export function RoleSheet({ sheet }: { sheet: SheetRef }) {
  const rows = useCompanyRows();
  // The full tree: the working tabs read the role's sessions as well as its facts.
  const tree = useInboxStore((s) => s.orgTree) as OrgTree | null;
  const role = findRole(tree, sheet.ref);
  if (!role || !tree) {
    return (
      <SheetFrame kind="role" idRef={sheet.ref} glyph={null} title="Role" crumbs={[workspaceCrumb(rows)]} loading={!tree}>
        <NotHere what="role" />
      </SheetFrame>
    );
  }
  return <RoleSheetBody sheet={sheet} role={role} tree={tree} rows={rows} />;
}

function RoleSheetBody({ sheet, role, tree, rows }: { sheet: SheetRef; role: OrgRole; tree: OrgTree; rows: CompanyRows }) {
  // The working tabs paint from these collections: keep them fed, as the role page does.
  useSyncTasks(); useSyncPlans(); useSyncDocs();
  const now = useCoarseNow(30_000);
  const head = useRoleHead(role);
  const meId = useInboxStore((s) => (s.currentUser?._id ? String(s.currentUser._id) : null));
  const pinned = useInboxStore((s) => isHeaderPinned(s, "role", role._id));
  const projects = useWorkspaceCollection<ProjectItem>("projects");
  const plans = useWorkspaceCollection<PlanItem>("plans");
  const scopeIds = useScopeIds(role.scope, plans);
  const scopeRef: ScopeRef | null = useMemo(() => scopeQueryRef(role, projects.map((p) => p._id), tree.workspace.kind === "team" ? tree.workspace.id : undefined), [role, tree, projects]);
  const { data: summary, error: summaryError, missing: summaryMissing } = useScopeSummary(scopeRef ?? "skip");
  const { data: brief, error: briefError, missing: briefMissing } = useRoleBrief(role._id);
  const [tab, setTab] = useState<ScopeTabKey>("work");
  const [editingCharter, setEditingCharter] = useState(false);
  const seat = useMemo(() => seatFor(sheet, rows), [sheet, rows]);
  const update = useCallback((fields: Parameters<ReturnType<typeof useInboxStore.getState>["updateOrgRole"]>[1], opts?: { leave_sessions?: boolean }) => useInboxStore.getState().updateOrgRole(role._id, fields, opts), [role._id]);
  const reparent = useCallback((target: OrgParentRef) => useInboxStore.getState().reparentOrgRole(role._id, target), [role._id]);

  const canEdit = canEditRole(tree, role, meId);
  const isParent = role.reports_to.kind === "user" && role.reports_to.user_id === meId;
  const standingId = role.standing?.conversation_id ?? null;
  const counters = role.counters && role.counters.day === todayUtc() ? role.counters : null;
  const hostName = tree.people.find((p) => p.user_id === role.host_user_id)?.name ?? "the host";
  const teamId = tree.workspace.kind === "team" ? tree.workspace.id : undefined;
  const reportsTo = reportsToNamed(tree, rows.members, role);
  // The role's own short statement; its charter document when it has only that.
  const charter = (role.charter ?? "").trim() || (brief?.charter ?? "").trim();
  const narrative = brief?.narrative ?? null;
  const backHref = objectHref("role", role.short_id);
  const menu: SheetMenuItem[] = [
    { label: pinned ? "Unpin from header" : "Pin to header", onSelect: () => toggleHeaderPin("role", role._id) },
    ...(canEdit ? [{ label: role.status === "paused" ? "Resume role" : "Pause role", onSelect: () => update({ status: role.status === "paused" ? "active" : "paused" }) }] : []),
  ];

  return (
    <SheetFrame
      kind="role"
      idRef={role.short_id}
      idLabel={`@${role.handle} · ${role.short_id}`}
      glyph={<RoleFace role={role} size={20} />}
      title={role.name}
      onRename={canEdit ? (name) => update({ name }) : undefined}
      crumbs={[workspaceCrumb(rows), ...reportsChain(tree, rows.members, role)]}
      // Whom it reports to opens that person's or role's sheet.
      facts={{ ...head.facts, owner: reportsTo ? <span className="inline-flex min-w-0 items-center gap-1" data-role-reports-to><span aria-hidden style={{ color: DIM }}>↳</span><ObjectLink n={reportsTo} /></span> : null }}
      serves={head.serves}
      talk={seat}
      ask={seat ? { seat } : null}
      menu={menu}
    >
      <SheetSection
        title="What it is for"
        data="charter"
        action={canEdit ? (
          <button type="button" onClick={() => setEditingCharter((v) => !v)} className="inline-flex items-center gap-1 text-[11.5px] hover:underline underline-offset-2" style={{ color: "var(--sol-text-muted)" }} data-charter-edit>
            {editingCharter ? "Done" : <><Pencil className="h-3 w-3" /> Edit</>}
          </button>
        ) : undefined}
      >
        {editingCharter ? (
          <ScopeCharterTab role={role} charter={charter} canEdit={canEdit} backHref={backHref} onUpdateCharter={(v) => update({ charter: v })} />
        ) : charter ? (
          <p className="whitespace-pre-wrap text-[13px] leading-relaxed" style={{ color: "var(--sol-text-secondary)" }} data-role-charter>{charter}</p>
        ) : (
          <p className="text-[12.5px]" style={{ color: DIM }} data-role-charter="">Nothing written yet. Ask {role.name} to say what it is for.</p>
        )}
      </SheetSection>

      <RoleStands role={role} now={now} narrative={narrative} only={head.leads.length ? head.leads.map((p) => p._id) : undefined} section={(body) => <SheetSection title="Where it stands" data="stands">{body}</SheetSection>} />

      <NowBlock
        subject={{ keys: [`role:${role.handle.toLowerCase()}`], refs: [role.short_id], role }}
        sessions={role.sessions}
        rows={rows}
        lead={roleNow(role) ? <RoleNowLine role={role} /> : undefined}
      />

      <RoleWeek role={role} tree={tree} now={now} canEdit={canEdit} />

      <RoleCarried role={role} head={head} tree={tree} now={now} />

      <div className="-mx-[22px] mt-6 border-t" style={{ borderColor: "var(--cc-panel-rule, color-mix(in srgb, var(--sol-border) 45%, transparent))" }} data-sheet-role-tabs>
        <ScopePanel
          tree={tree}
          role={role}
          tabs={WORKING_TABS}
          tab={tab}
          onTab={setTab}
          layout="side"
          inline
          scopeRef={scopeRef}
          scopeIds={scopeIds}
          summary={summary}
          summaryProblem={summaryMissing ? null : queryProblem(summaryError, false, "The counts")}
          brief={brief}
          briefProblem={briefMissing ? null : queryProblem(briefError, false, "The role's notes")}
          canEdit={canEdit}
          canEditBrief={canEdit || isParent}
          hostName={hostName}
          model={null}
          standingId={standingId}
          counters={counters}
          now={now}
          backHref={backHref}
          onUpdate={update}
          onReparent={reparent}
        />
      </div>

      <RoleFolds roleId={role._id} canEdit={canEdit} teamId={teamId} narrative={narrative} routine={brief?.role.routine ?? null} now={now} notes={
        <ScopeBriefTab role={role} facts={brief?.facts ?? null} factsProblem={briefMissing ? null : queryProblem(briefError, false, "The role's notes")} narrative={narrative ?? ""} canEdit={canEdit || isParent} backHref={backHref} />
      } />
    </SheetFrame>
  );
}

/** The role's week (D12): work that reached it against work it closed, day by
 *  day, the few signals that need a person, its fix loop, and behind What if
 *  its two levers (its daily limit, and handing part of its work to another
 *  role). Read from the org's health, which the sheet keeps fresh on the map's
 *  cadence while it is open. A read that failed, or a server without it,
 *  says so here; a clean read with no word on this role draws nothing.
 *  Pause, resume and run now are its Triggers tab. */
function RoleWeek({ role, tree, now, canEdit }: { role: OrgRole; tree: OrgTree; now: number; canEdit: boolean }) {
  const health = useInboxStore((s) => s.orgHealth);
  // The feeder runs while the sheet is open, on the map's cadence: a cached
  // copy from an earlier visit is painted first and replaced as it refreshes.
  const { error, missing, refresh } = useSyncOrgHealth(true);
  const flows = useMemo(() => (health ? roleFlows(tree, health, now) : []), [health, tree, now]);
  const flow = flows.find((f) => f.role._id === role._id);
  const [levers, setLevers] = useState(false);
  const head = useMemo(() => findHeadOfPeople(tree), [tree]);
  const headConv = head && head._id !== role._id ? head.standing?.conversation_id ?? null : null;
  const note = <HealthNote missing={missing} error={error?.message} hasHealth={!!health} onRetry={() => { void refresh(); }} />;
  if (!flow?.health) {
    // A read that failed or a server without it says so; a clean read with no word on this role draws nothing.
    if (!missing && !(error && !health)) return null;
    return <SheetSection title="This week" data="week">{note}</SheetSection>;
  }
  const days = flowDays(now);
  const setLimit = (perDay: number) => {
    useInboxStore.getState().updateOrgRole(role._id, { caps: { ...DEFAULT_ROLE_CAPS, ...(role.caps ?? {}), wakes_per_day: perDay } });
    toast.success(`${role.name} can now take ${perDay} a day`);
  };
  return (
    <SheetSection
      title="This week"
      data="week"
      action={(
        <button type="button" onClick={() => setLevers((v) => !v)} aria-expanded={levers} className="text-[11.5px] hover:underline underline-offset-2" style={{ color: "var(--sol-text-muted)" }} data-role-week-levers>
          {levers ? "Done" : "What if"}
        </button>
      )}
    >
      <div className="max-w-[340px]"><RoleWeekBody f={flow} days={days} headless /></div>
      <FixLoopLine flow={flow.health.flow} />
      {note}
      {levers && (
        <div className="mt-3">
          <RoleLevers
            f={flow}
            flows={flows}
            days={days}
            onSetLimit={canEdit ? setLimit : undefined}
            head={headConv ? head : null}
            onAskHead={headConv ? (text) => useInboxStore.getState().sendMessage(headConv, text) : undefined}
          />
        </div>
      )}
    </SheetSection>
  );
}

/** What carries the role's work: the projects it leads, then the roles under it. */
function RoleCarried({ role, head, tree, now }: { role: OrgRole; head: ReturnType<typeof useRoleHead>; tree: OrgTree; now: number }) {
  const tasks = useBoardTasks();
  const counted = useTasksBackfilled();
  const live = useMemo(() => rolesInTreeOrder(tree), [tree]);
  if (head.leads.length === 0 && head.under.length === 0) return null;
  return (
    <SheetSection title="Carried by">
      <CarriedLines>
        {head.leads.map((p) => <ProjectLine key={p._id} project={lineProjectOf(p, { tree, roles: live, tasks, tasksCounted: counted })} now={now} sub="leads" />)}
        {head.under.map((r) => <RoleLine key={r._id} line={{ role: r, reportsTo: { name: role.name }, leads: [], goals: [], charter: r.charter }} now={now} />)}
      </CarriedLines>
    </SheetSection>
  );
}

/** What the role has learned, how it wakes, its own notes and, for a role
 *  hired from a template, that template's setup, folded at the foot. */
function RoleFolds({ roleId, canEdit, teamId, narrative, routine, now, notes }: { roleId: string; canEdit: boolean; teamId?: string; narrative: string | null; routine: RoleBrief["role"]["routine"]; now: number; notes: ReactNode }) {
  const playbook = useMemo(() => parsePlaybook(narrative), [narrative]);
  const wake = routine ? routine.wake ?? roleWakeOf(routine) : null;
  // Only a role hired from a template has one: its instance names this role.
  const { instance } = useTemplateInstance(roleId);
  const templateHint = instance ? (instance.phase === "awaiting_host" ? "one step left" : instance.ask?.title ?? instance.template?.name ?? null) : null;
  return (
    <SheetFolds>
      {instance && (
        <SheetFold title="Its template" hint={templateHint ?? undefined} defaultOpen={instance.phase === "awaiting_host"}>
          <TemplateSections roleId={roleId} canEdit={canEdit} teamId={teamId} inSheet />
        </SheetFold>
      )}
      {!playbookIsEmpty(playbook) && <SheetFold title="Its playbook"><RolePlaybook playbook={playbook} narrative={narrative} now={now} /></SheetFold>}
      {wake && <SheetFold title="How it wakes" hint={wakeWords({ ...wake, why: null }).split(" · ")[0]}><RoleWakeLine wake={wake} /></SheetFold>}
      <SheetFold title="Its notes">{notes}</SheetFold>
    </SheetFolds>
  );
}
