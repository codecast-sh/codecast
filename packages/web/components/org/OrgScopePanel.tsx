"use client";
// The right panel for the selected org node. A role shows its handle, name,
// charter, editable scope (project and plan chips) and ONE feed of everything
// under the scope: sessions filed under the role, tasks and docs whose
// project_id or plan_id is in scope, newest first. A person shows counts and
// their sessions. A session shows what it is, its parent, and an open link.
import { useMemo, useState } from "react";
import Link from "next/link";
import { X, ExternalLink, Trash2, ArrowRightLeft, CheckSquare, FileText, Users, Anchor as AnchorGlyph, Pencil, Check, Crown, Shield } from "lucide-react";
import { useWorkspaceCollection } from "../../hooks/useWorkspaceCollection";
import type { TaskItem, DocItem, PlanItem, ProjectItem } from "../../store/inboxStore";
import { compactAge } from "../../lib/threadState";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { AgentIcon } from "../ConversationList";
import { Avatar } from "../tasks/TaskCommentStream";
import { SelectBox } from "../ui/select-box";
import { cn } from "../../lib/utils";
import { GhostChips, StateBar, StateTally, StandingLine } from "./OrgNodeCards";
import { ORG_STATE_META, parentName, staffingPaneWord } from "./orgMeta";
import { OrgButton } from "./OrgButton";
import { RetireRoleConfirm, type UnseatChoice } from "./RetireRoleConfirm";
import type { OrgGhostChip, OrgLayoutNode } from "./orgLayout";
import { ghostChipOf, parentNodeId, refMatches } from "./orgLayout";
import type { OrgParentRef, OrgRole, OrgScope, OrgSession, OrgTree } from "./orgTypes";
import { TakeoverGate } from "./TakeoverEdit";
import type { OrgProposalChange } from "./orgStaffingTypes";
import type { OrgUpdateRoleInput } from "../../store/orgSlice";
import { useOrgRoles } from "../../hooks/useOrgRoles";
import { PriorityPill } from "../charter/CharterChips";
import { ProjectLeadChip } from "../charter/ProjectLeadChip";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { isMac } from "../../shortcuts";

export type OrgSessionsSource = {
  sessionsUnder: (parentId: string) => OrgSession[];
  hasMore: (parentId: string) => boolean;
  loading: (parentId: string) => boolean;
  loadMore: (parentId: string) => void;
};

/** The panel's modes: the selected node, the staffing pane (org-staffing.md
 *  S5), or the record of what changed (S21). The tabs show whenever their
 *  subject exists; with no node selected the sheet opens on staffing, or on
 *  History when that is what the person asked for. */
export type OrgPanelMode = "node" | "staffing" | "history";

export type OrgScopePanelProps = {
  tree: OrgTree;
  /** Null when the sheet is open in staffing mode with nothing selected. */
  node: OrgLayoutNode | null;
  sessions: OrgSessionsSource;
  canEdit: boolean;
  onClose: () => void;
  onOpenSession: (conversationId: string) => void;
  onMove: (subject: { kind: "session" | "role"; id: string; title: string }) => void;
  /** `opts.leave_sessions` is the person's one edit on a scope that gains refs (R1). */
  onUpdateRole: (roleId: string, fields: OrgUpdateRoleInput, opts?: { leave_sessions?: boolean }) => void;
  onRetireRole: (roleId: string, standingSession?: UnseatChoice) => void;
  onSelectNode: (id: string) => void;
  mode: OrgPanelMode;
  onMode: (mode: OrgPanelMode) => void;
  /** The staffing pane, rendered in the body when mode is "staffing". */
  staffing: React.ReactNode;
  /** The record of org changes (S21), rendered when mode is "history". */
  history?: React.ReactNode;
  /** The proposal's conversation, leading: the wider column to the left of
   *  the body on a desktop (org-staffing.md S19), `staffingLeadWidth` wide. */
  staffingLead?: React.ReactNode;
  staffingLeadWidth?: number;
  /** The body is one full height view with its own scroll (the phone
   *  sheet's conversation view), not the padded scroll of the pane. */
  staffingFill?: boolean;
  /** Changes still to decide on the open proposal, shown on the tab. */
  staffingCount?: number;
  /** The open proposal's changes: a project charter or a filing renders as a
   *  dashed chip on the scope row it names (org-staffing.md S5). */
  changes?: OrgProposalChange[];
  focusChangeId?: string | null;
  onSelectChange?: (changeId: string) => void;
};

type FeedRow =
  | { kind: "session"; id: string; title: string; at: number; session: OrgSession }
  | { kind: "task"; id: string; title: string; at: number; task: TaskItem }
  | { kind: "doc"; id: string; title: string; at: number; doc: DocItem };

export function SectionLabel({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between mt-5 mb-2">
      <span className="text-[10.5px] font-semibold uppercase tracking-[0.08em]" style={{ color: "var(--sol-text-dim)" }}>{children}</span>
      {right}
    </div>
  );
}

export function StateChip({ state }: { state: OrgSession["state"] }) {
  const m = ORG_STATE_META[state] ?? ORG_STATE_META.idle;
  return <span className={cn("inline-flex items-center h-[18px] px-1.5 rounded-md border text-[10px] font-medium", m.chip)}>{m.label}</span>;
}

// ---------------------------------------------------------------- feed rows

export function SessionRow({ s, now, onOpen }: { s: OrgSession; now: number; onOpen: () => void }) {
  const m = ORG_STATE_META[s.state] ?? ORG_STATE_META.idle;
  return (
    <button type="button" onClick={onOpen} className="group w-full text-left flex items-center gap-2.5 px-2.5 py-2 rounded-lg transition-colors hover:bg-sol-bg-highlight/70">
      <span className="w-[3px] self-stretch rounded-full shrink-0" style={{ background: m.color }} />
      <AgentIcon agentType={s.agent_type} className="w-4 h-4" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] font-medium" style={{ color: "var(--sol-text)" }}>{s.title || "Untitled"}</span>
        <span className="block truncate text-[10.5px] mt-[1px]" style={{ color: "var(--sol-text-dim)", fontFamily: "var(--font-mono)" }}>
          {s.short_id}{s.subagent_count > 0 ? ` · ${s.subagent_count} subagent${s.subagent_count === 1 ? "" : "s"}` : ""}
        </span>
      </span>
      <span className="text-[10.5px] tabular-nums shrink-0" style={{ color: "var(--sol-text-dim)" }}>{compactAge(now - s.updated_at)}</span>
      <ExternalLink className="w-3 h-3 shrink-0 opacity-0 group-hover:opacity-70 transition-opacity" style={{ color: "var(--sol-text-dim)" }} />
    </button>
  );
}

export function TaskRow({ t, now }: { t: TaskItem; now: number }) {
  const done = t.status === "done" || t.status === "closed" || t.status === "cancelled";
  return (
    <Link href={`/tasks/${t.short_id}`} className="group flex items-center gap-2.5 px-2.5 py-2 rounded-lg transition-colors hover:bg-sol-bg-highlight/70">
      <span className="w-[3px] self-stretch rounded-full shrink-0" style={{ background: done ? "var(--sol-cyan)" : "color-mix(in srgb, var(--sol-border) 60%, transparent)" }} />
      <CheckSquare className="w-4 h-4 shrink-0" style={{ color: done ? "var(--sol-cyan)" : "var(--sol-text-dim)" }} />
      <span className="min-w-0 flex-1">
        <span className={cn("block truncate text-[12.5px] font-medium", done && "line-through opacity-70")} style={{ color: "var(--sol-text)" }}>{t.title}</span>
        <span className="block truncate text-[10.5px] mt-[1px]" style={{ color: "var(--sol-text-dim)", fontFamily: "var(--font-mono)" }}>{t.short_id} · {t.status.replace(/_/g, " ")}</span>
      </span>
      <span className="text-[10.5px] tabular-nums shrink-0" style={{ color: "var(--sol-text-dim)" }}>{compactAge(now - t.updated_at)}</span>
    </Link>
  );
}

export function DocRow({ d, now }: { d: DocItem; now: number }) {
  const title = (d as any).display_title || d.title || "Untitled";
  return (
    <Link href={`/docs/${d._id}`} className="group flex items-center gap-2.5 px-2.5 py-2 rounded-lg transition-colors hover:bg-sol-bg-highlight/70">
      <span className="w-[3px] self-stretch rounded-full shrink-0" style={{ background: "color-mix(in srgb, var(--sol-border) 60%, transparent)" }} />
      <FileText className="w-4 h-4 shrink-0" style={{ color: "var(--sol-text-dim)" }} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] font-medium" style={{ color: "var(--sol-text)" }}>{title}</span>
        <span className="block truncate text-[10.5px] mt-[1px]" style={{ color: "var(--sol-text-dim)" }}>page · {d.doc_type.replace(/_/g, " ")}</span>
      </span>
      <span className="text-[10.5px] tabular-nums shrink-0" style={{ color: "var(--sol-text-dim)" }}>{compactAge(now - d.updated_at)}</span>
    </Link>
  );
}

function Feed({ rows, now, onOpenSession, more }: { rows: FeedRow[]; now: number; onOpenSession: (id: string) => void; more?: React.ReactNode }) {
  if (rows.length === 0 && !more) {
    return <p className="text-[12px] px-2.5 py-3" style={{ color: "var(--sol-text-dim)" }}>Nothing under this scope yet.</p>;
  }
  return (
    <div className="flex flex-col -mx-1">
      {rows.map((r) =>
        r.kind === "session" ? <SessionRow key={r.id} s={r.session} now={now} onOpen={() => onOpenSession(r.session._id)} />
        : r.kind === "task" ? <TaskRow key={r.id} t={r.task} now={now} />
        : <DocRow key={r.id} d={r.doc} now={now} />,
      )}
      {more}
    </div>
  );
}

function LoadMore({ parentId, sessions }: { parentId: string; sessions: OrgSessionsSource }) {
  if (!sessions.hasMore(parentId)) return null;
  const loading = sessions.loading(parentId);
  return (
    <button
      type="button"
      onClick={() => sessions.loadMore(parentId)}
      disabled={loading}
      className="mx-2.5 mt-1 mb-2 h-8 rounded-lg border border-dashed text-[11.5px] font-medium transition-colors hover:bg-sol-bg-highlight/60 disabled:opacity-60"
      style={{ borderColor: "color-mix(in srgb, var(--sol-border) 55%, transparent)", color: "var(--sol-text-muted)" }}
    >
      {loading ? "Loading…" : "Load more sessions"}
    </button>
  );
}

// ---------------------------------------------------------------- scope editor

/**
 * The scope editor, with what a gain moves said before it is written
 * (org-roles-run-work.md R1). A role that gains a project or a plan takes over
 * the sessions in it that report to its host and to no role, so an edit that
 * ADDS a ref shows in the editor at once and its write waits at the gate: it
 * goes through by itself when nothing would move, and otherwise the person
 * reads the count and may leave the sessions where they are. An edit that
 * only removes is written as before. Every surface that edits a live role's
 * scope by hand mounts this one (Settings, the chart's panel).
 */
export function GatedScopeEditor({ workspace, role, onChange, ...editor }: Omit<React.ComponentProps<typeof ScopeEditor>, "onChange"> & {
  workspace: OrgTree["workspace"];
  onChange: (scope: OrgScope, opts?: { leave_sessions?: boolean }) => void;
}) {
  const [pending, setPending] = useState<OrgScope | null>(null);
  const gained = pending
    ? [...pending.project_ids.filter((id) => !role.scope.project_ids.includes(id)).map((id) => `project:${id}`), ...pending.plan_ids.filter((id) => !role.scope.plan_ids.includes(id)).map((id) => `plan:${id}`)]
    : [];
  const change = (scope: OrgScope) => {
    const adds = scope.project_ids.some((id) => !role.scope.project_ids.includes(id)) || scope.plan_ids.some((id) => !role.scope.plan_ids.includes(id));
    if (adds) setPending(scope); else { setPending(null); onChange(scope); }
  };
  return (
    <>
      <ScopeEditor {...editor} role={pending ? { ...role, scope: pending } : role} onChange={change} />
      {pending && gained.length > 0 && (
        <TakeoverGate
          // A different gain is a different question: the gate starts over.
          key={gained.join(",")}
          className="mt-2"
          workspace={workspace}
          ask={{ handle: role.handle, add: gained }}
          what={`@${role.handle} gains ${gained.length === 1 ? "this" : "these"}, and with ${gained.length === 1 ? "it" : "them"} the sessions inside that report to its host and to no role.`}
          confirmLabel="Change the scope"
          onConfirm={(opts) => { onChange(pending, opts.leave_sessions ? opts : undefined); setPending(null); }}
          onCancel={() => setPending(null)}
        />
      )}
    </>
  );
}

export function ScopeEditor({ role, canEdit, onChange, changes, focusChangeId, onSelectChange }: {
  role: OrgRole; canEdit: boolean; onChange: (scope: OrgScope) => void;
  changes?: OrgProposalChange[]; focusChangeId?: string | null; onSelectChange?: (changeId: string) => void;
}) {
  const projects = useWorkspaceCollection<ProjectItem>("projects");
  const plans = useWorkspaceCollection<PlanItem>("plans");
  const projectById = useMemo(() => new Map(projects.map((p) => [p._id, p])), [projects]);
  const planById = useMemo(() => new Map(plans.map((p) => [p._id, p])), [plans]);
  // A proposal's chips on the rows they name (S5): a project charter on its
  // project's row; a filing on its plan's row when the scope has the plan,
  // else on its project's row. Decided ones are gone from here.
  const open = useMemo(() => (changes ?? []).filter((c) => c.status !== "skipped" && c.status !== "applied" && c.status !== "removed"), [changes]);
  const chipsOnProject = (id: string): OrgGhostChip[] => {
    const row = { id, title: nameOfProject(id), short_id: (projectById.get(id) as { short_id?: string } | undefined)?.short_id };
    return open
      .filter((c) => (c.change.kind === "project_meta" && refMatches(c.change.project, row)) || (c.change.kind === "file" && refMatches(c.change.project, row) && !role.scope.plan_ids.some((pid) => c.change.kind === "file" && refMatches(c.change.plan, { id: pid, title: nameOfPlan(pid), short_id: shortOfPlan(pid) }))))
      .map((c) => ghostChipOf(c));
  };
  const chipsOnPlan = (id: string): OrgGhostChip[] =>
    open.filter((c) => c.change.kind === "file" && refMatches(c.change.plan, { id, title: nameOfPlan(id), short_id: shortOfPlan(id) })).map((c) => ghostChipOf(c));
  const nameOfProject = (id: string) => projectById.get(id)?.title ?? role.scope_names.projects.find((p) => p.id === id)?.title ?? "project";
  const nameOfPlan = (id: string) => planById.get(id)?.title ?? role.scope_names.plans.find((p) => p.id === id)?.title ?? "plan";
  const shortOfPlan = (id: string) => planById.get(id)?.short_id ?? role.scope_names.plans.find((p) => p.id === id)?.short_id;
  const empty = role.scope.project_ids.length === 0 && role.scope.plan_ids.length === 0;
  const remove = (kind: "project" | "plan", id: string) =>
    onChange(kind === "project"
      ? { ...role.scope, project_ids: role.scope.project_ids.filter((x) => x !== id) }
      : { ...role.scope, plan_ids: role.scope.plan_ids.filter((x) => x !== id) });
  const add = (value: string) => {
    if (!value) return;
    const [kind, id] = value.split(":", 2);
    if (kind === "project" && !role.scope.project_ids.includes(id)) onChange({ ...role.scope, project_ids: [...role.scope.project_ids, id] });
    if (kind === "plan" && !role.scope.plan_ids.includes(id)) onChange({ ...role.scope, plan_ids: [...role.scope.plan_ids, id] });
  };
  const openProjects = projects.filter((p) => !role.scope.project_ids.includes(p._id) && p.status !== "archived");
  const openPlans = plans.filter((p) => !role.scope.plan_ids.includes(p._id) && p.status !== "done" && p.status !== "dropped");
  return (
    <div>
      <div className="flex flex-wrap gap-1.5">
        {empty && (
          <span className="inline-flex items-center h-[22px] px-2 rounded-md border text-[11px]" style={{ borderColor: "color-mix(in srgb, var(--sol-border) 45%, transparent)", color: "var(--sol-text-muted)" }}>
            whole workspace
          </span>
        )}
        {role.scope.project_ids.map((id) => (
          <span key={`p:${id}`} className="inline-flex items-center gap-1" data-scope-project={id}>
            <Chip tone="blue" href={`/projects/${id}`} onRemove={canEdit ? () => remove("project", id) : undefined}>{nameOfProject(id)}</Chip>
            {/* The project's charter at a glance (org-staffing.md S7): its priority and who leads it (org-roles-run-work.md R4). */}
            <PriorityPill priority={projectById.get(id)?.priority} size="xs" />
            <ProjectLeadChip projectId={id} size="xs" />
            <GhostChips chips={chipsOnProject(id)} focusChangeId={focusChangeId} onFocusChange={onSelectChange} />
          </span>
        ))}
        {role.scope.plan_ids.map((id) => (
          <span key={`l:${id}`} className="inline-flex items-center gap-1" data-scope-plan={id}>
            <Chip tone="magenta" mono href={`/plans/${id}`} onRemove={canEdit ? () => remove("plan", id) : undefined}>{shortOfPlan(id) ?? nameOfPlan(id)}</Chip>
            <GhostChips chips={chipsOnPlan(id)} focusChangeId={focusChangeId} onFocusChange={onSelectChange} />
          </span>
        ))}
      </div>
      {canEdit && (openProjects.length > 0 || openPlans.length > 0) && (
        <div className="mt-2">
          <SelectBox value="" onChange={(e) => add(e.target.value)} className="text-[12px]" aria-label="Add to scope">
            <option value="">Add a project or plan…</option>
            {openProjects.length > 0 && (
              <optgroup label="Projects">
                {openProjects.map((p) => <option key={p._id} value={`project:${p._id}`}>{p.title}</option>)}
              </optgroup>
            )}
            {openPlans.length > 0 && (
              <optgroup label="Plans">
                {openPlans.map((p) => <option key={p._id} value={`plan:${p._id}`}>{p.short_id} · {p.title}</option>)}
              </optgroup>
            )}
          </SelectBox>
        </div>
      )}
    </div>
  );
}

export function Chip({ children, tone, mono, href, onRemove }: { children: React.ReactNode; tone: "blue" | "magenta"; mono?: boolean; href: string; onRemove?: () => void }) {
  const color = tone === "blue" ? "var(--sol-blue)" : "var(--sol-magenta)";
  return (
    <span className="inline-flex items-center h-[22px] rounded-md overflow-hidden text-[11px] font-medium" style={{ background: `color-mix(in srgb, ${color} 12%, transparent)`, color, fontFamily: mono ? "var(--font-mono)" : undefined }}>
      <Link href={href} className="px-2 hover:underline truncate max-w-[160px]">{children}</Link>
      {onRemove && (
        <button type="button" onClick={onRemove} className="h-full px-1.5 hover:bg-black/10 dark:hover:bg-white/10" aria-label="Remove from scope">
          <X className="w-3 h-3" />
        </button>
      )}
    </span>
  );
}

// ---------------------------------------------------------------- inline text edit

/** One inline field: a button showing the value until clicked, then the
 *  input. `ariaLabel` names the field for a screen reader (the placeholder
 *  is not a name); it labels both the button and the input. Enter commits a
 *  single line; a multiline field commits on the modifier plus Enter and
 *  shows that as keycaps beside the save button. */
export function InlineEdit({ value, onSave, className, style, placeholder, multiline, canEdit, ariaLabel }: { value: string; onSave: (v: string) => void; className?: string; style?: React.CSSProperties; placeholder?: string; multiline?: boolean; canEdit: boolean; ariaLabel?: string }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  if (!editing) {
    return (
      <button
        type="button"
        disabled={!canEdit}
        onClick={() => { setDraft(value); setEditing(true); }}
        className={cn("group text-left w-full rounded-md -mx-1 px-1 disabled:cursor-default", canEdit && "hover:bg-sol-bg-highlight/60", className)}
        style={style}
        title={canEdit ? "Click to edit" : undefined}
        aria-label={ariaLabel ? (canEdit ? `Edit ${ariaLabel}` : ariaLabel) : undefined}
      >
        <span className={cn(!value && "italic opacity-60")}>{value || placeholder}</span>
        {canEdit && <Pencil className="inline-block w-3 h-3 ml-1.5 align-[-1px] opacity-0 group-hover:opacity-60 transition-opacity" />}
      </button>
    );
  }
  const commit = () => { setEditing(false); if (draft.trim() !== value) onSave(draft.trim()); };
  const Tag: any = multiline ? "textarea" : "input";
  return (
    <div className="flex items-start gap-1.5 w-full">
      <Tag
        autoFocus
        value={draft}
        rows={multiline ? 3 : undefined}
        onChange={(e: any) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e: any) => {
          if (e.key === "Enter" && (!multiline || e.metaKey || e.ctrlKey)) { e.preventDefault(); commit(); }
          if (e.key === "Escape") { e.preventDefault(); setEditing(false); }
        }}
        className={cn("flex-1 min-w-0 rounded-md px-2 py-1 border outline-none text-[13px] bg-sol-bg-alt", className)}
        style={{ borderColor: "var(--sol-cyan)", color: "var(--sol-text)", ...style }}
        aria-label={ariaLabel}
        placeholder={placeholder}
      />
      {multiline && (
        <span className="flex items-center gap-0.5 mt-1.5 shrink-0" aria-hidden title={`${isMac ? "Command" : "Control"} Enter saves`}>
          <KeyCap size="xs">{isMac ? "⌘" : "Ctrl"}</KeyCap><KeyCap size="xs">↵</KeyCap>
        </span>
      )}
      <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={commit} className="h-7 w-7 inline-flex items-center justify-center rounded-md" style={{ color: "var(--sol-cyan)" }} aria-label={ariaLabel ? `Save ${ariaLabel}` : "Save"}><Check className="w-3.5 h-3.5" /></button>
    </div>
  );
}

// ---------------------------------------------------------------- panel bodies

function RolePanel({ tree, role, sessions, canEdit, onOpenSession, onMove, onUpdateRole, onRetireRole, onSelectNode, now, changes, focusChangeId, onSelectChange }: {
  tree: OrgTree; role: OrgRole; sessions: OrgSessionsSource; canEdit: boolean; now: number;
  onOpenSession: (id: string) => void; onMove: OrgScopePanelProps["onMove"]; onUpdateRole: OrgScopePanelProps["onUpdateRole"]; onRetireRole: OrgScopePanelProps["onRetireRole"]; onSelectNode: (id: string) => void;
  changes?: OrgProposalChange[]; focusChangeId?: string | null; onSelectChange?: (changeId: string) => void;
}) {
  const parentId = parentNodeId({ kind: "role", role_id: role._id });
  const tasks = useWorkspaceCollection<TaskItem>("tasks");
  const docs = useWorkspaceCollection<DocItem>("docs");
  const [confirmRetire, setConfirmRetire] = useState(false);
  const inScope = (row: { project_id?: string | null; plan_id?: string | null }) => {
    const empty = role.scope.project_ids.length === 0 && role.scope.plan_ids.length === 0;
    if (empty) return true;
    return (!!row.project_id && role.scope.project_ids.includes(row.project_id)) || (!!row.plan_id && role.scope.plan_ids.includes(row.plan_id));
  };
  const rows = useMemo<FeedRow[]>(() => {
    const out: FeedRow[] = [];
    for (const s of sessions.sessionsUnder(parentId)) out.push({ kind: "session", id: `s:${s._id}`, title: s.title, at: s.updated_at, session: s });
    for (const t of tasks) if (inScope(t as any) && !(t as any).parent_id) out.push({ kind: "task", id: `t:${t._id}`, title: t.title, at: t.updated_at, task: t });
    for (const d of docs) if (inScope(d as any)) out.push({ kind: "doc", id: `d:${d._id}`, title: d.title, at: d.updated_at, doc: d });
    out.sort((a, b) => b.at - a.at);
    return out.slice(0, 120);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, parentId, tasks, docs, role.scope]);
  const counts = { sessions: rows.filter((r) => r.kind === "session").length, tasks: rows.filter((r) => r.kind === "task").length, docs: rows.filter((r) => r.kind === "doc").length };
  const reportsTo = role.reports_to;
  return (
    <>
      <div className="flex items-center gap-2">
        <span className="inline-flex items-center h-[20px] px-1.5 rounded-md text-[10.5px] font-medium" style={{ background: "var(--sol-violet)", color: "var(--sol-bg)", fontFamily: "var(--font-mono)" }}>@{role.handle}</span>
        <Link href={`/org/${role.short_id}`} className="text-[10.5px] hover:underline" style={{ color: "var(--sol-text-dim)", fontFamily: "var(--font-mono)" }} title="Open the scope page">{role.short_id}</Link>
        <Link href={`/org/${role.short_id}`} className="ml-auto inline-flex items-center gap-1 text-[11px] px-1.5 h-[20px] rounded-md hover:bg-sol-bg-highlight" style={{ color: "var(--sol-violet)" }}>
          Open page <ExternalLink className="w-3 h-3" />
        </Link>
        {role.status === "paused" && <span className="text-[10px] px-1.5 h-[18px] inline-flex items-center rounded-md" style={{ background: "color-mix(in srgb, var(--sol-yellow) 14%, transparent)", color: "var(--sol-yellow)" }}>paused</span>}
      </div>
      <div className="mt-2">
        <InlineEdit canEdit={canEdit} value={role.name} onSave={(v) => v && onUpdateRole(role._id, { name: v })} className="text-[20px] leading-tight font-semibold tracking-tight" style={{ fontFamily: "var(--font-serif)", color: "var(--sol-text)" }} />
      </div>
      <StandingLine standing={role.standing} size="md" className="mt-2" />
      <div className="mt-1.5 text-[12px] flex items-center gap-1.5 flex-wrap" style={{ color: "var(--sol-text-muted)" }}>
        <span>reports to</span>
        <button type="button" onClick={() => onSelectNode(parentNodeId(reportsTo))} className="font-medium hover:underline" style={{ color: "var(--sol-text)" }}>{parentName(tree, reportsTo)}</button>
        {canEdit && (
          <button type="button" onClick={() => onMove({ kind: "role", id: role._id, title: role.name })} className="inline-flex items-center gap-1 text-[11px] px-1.5 h-[20px] rounded-md hover:bg-sol-bg-highlight" style={{ color: "var(--sol-text-dim)" }}>
            <ArrowRightLeft className="w-3 h-3" /> move
          </button>
        )}
      </div>

      <SectionLabel>Charter</SectionLabel>
      <InlineEdit canEdit={canEdit} multiline value={role.charter ?? ""} placeholder="What this seat owns, in a sentence or two." onSave={(v) => onUpdateRole(role._id, { charter: v })} className="text-[12.5px] leading-relaxed" style={{ color: "var(--sol-text-secondary)" }} />

      <SectionLabel>Scope</SectionLabel>
      <GatedScopeEditor workspace={tree.workspace} role={role} canEdit={canEdit} onChange={(scope, opts) => onUpdateRole(role._id, { scope }, opts)} changes={changes} focusChangeId={focusChangeId} onSelectChange={onSelectChange} />

      <SectionLabel right={<StateTally counts={role.counts} />}>Sessions</SectionLabel>
      <StateBar counts={role.counts} />

      <SectionLabel right={<span className="text-[10.5px] tabular-nums" style={{ color: "var(--sol-text-dim)" }}>{counts.sessions} sessions · {counts.tasks} tasks · {counts.docs} pages</span>}>Under this scope</SectionLabel>
      <Feed rows={rows} now={now} onOpenSession={onOpenSession} more={<LoadMore parentId={parentId} sessions={sessions} />} />

      {canEdit && (
        <div className="mt-8 pt-4 border-t" style={{ borderColor: "color-mix(in srgb, var(--sol-border) 30%, transparent)" }}>
          {!confirmRetire ? (
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => onUpdateRole(role._id, { status: role.status === "paused" ? "active" : "paused" })} className="h-8 px-3 rounded-lg border text-[12px] font-medium hover:bg-sol-bg-highlight/60" style={{ borderColor: "color-mix(in srgb, var(--sol-border) 45%, transparent)", color: "var(--sol-text-muted)" }}>
                {role.status === "paused" ? "Resume role" : "Pause role"}
              </button>
              <button type="button" onClick={() => setConfirmRetire(true)} className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-[12px] font-medium hover:bg-sol-red/10" style={{ color: "var(--sol-red)" }}>
                <Trash2 className="w-3.5 h-3.5" /> Retire role
              </button>
            </div>
          ) : (
            <div className="rounded-lg p-3 border" style={{ borderColor: "color-mix(in srgb, var(--sol-red) 40%, transparent)", background: "color-mix(in srgb, var(--sol-red) 6%, transparent)" }}>
              {/* The one retire confirm (S16): the chief of staff's asks keep or retire. */}
              <RetireRoleConfirm
                role={role}
                lead={<>Retire <b>{role.name}</b>? Its {role.total} session{role.total === 1 ? "" : "s"} go back to their owners. Roles under it report to {parentName(tree, reportsTo)}.</>}
                onRetire={(choice) => onRetireRole(role._id, choice)}
                onCancel={() => setConfirmRetire(false)}
              />
            </div>
          )}
        </div>
      )}
    </>
  );
}

function PersonPanel({ tree, person, sessions, onOpenSession, now }: { tree: OrgTree; person: OrgTree["people"][number]; sessions: OrgSessionsSource; onOpenSession: (id: string) => void; now: number }) {
  const parentId = parentNodeId({ kind: "user", user_id: person.user_id });
  const roles = tree.roles.filter((r) => r.reports_to.kind === "user" && r.reports_to.user_id === person.user_id && r.status !== "retired");
  const anchors = tree.anchors.filter((a) => a.host_user_id === person.user_id);
  const rows = sessions.sessionsUnder(parentId).map<FeedRow>((s) => ({ kind: "session", id: `s:${s._id}`, title: s.title, at: s.updated_at, session: s }));
  return (
    <>
      <div className="flex items-center gap-3">
        <div className="rounded-full p-[2px]" style={{ background: person.is_me ? "linear-gradient(135deg, var(--sol-cyan), var(--sol-blue))" : "color-mix(in srgb, var(--sol-border) 45%, transparent)" }}>
          <div className="rounded-full p-[2px]" style={{ background: "var(--sol-card)" }}><Avatar name={person.name} image={person.image} size="md" /></div>
        </div>
        <div className="min-w-0">
          <div className="text-[20px] leading-tight font-semibold tracking-tight truncate" style={{ fontFamily: "var(--font-serif)", color: "var(--sol-text)" }}>{person.name}</div>
          <div className="text-[11px] flex items-center gap-1.5 mt-0.5" style={{ color: "var(--sol-text-dim)" }}>
            {person.role === "owner" ? <Crown className="w-3 h-3" /> : person.role === "admin" ? <Shield className="w-3 h-3" /> : <Users className="w-3 h-3" />}
            <span className="capitalize">{person.role}</span>
            {person.is_me && <span>· you</span>}
          </div>
        </div>
      </div>
      <SectionLabel right={<StateTally counts={person.counts} />}>Direct sessions</SectionLabel>
      <StateBar counts={person.counts} />
      <div className="mt-2 grid grid-cols-3 gap-2">
        <Stat label="sessions" value={person.total} />
        <Stat label="roles" value={roles.length} />
        <Stat label="anchors" value={anchors.length} />
      </div>
      <SectionLabel>Sessions</SectionLabel>
      <Feed rows={rows} now={now} onOpenSession={onOpenSession} more={<LoadMore parentId={parentId} sessions={sessions} />} />
    </>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg px-2.5 py-2 border" style={{ borderColor: "color-mix(in srgb, var(--sol-border) 30%, transparent)", background: "var(--sol-card)" }}>
      <div className="text-[16px] font-semibold tabular-nums leading-none" style={{ color: "var(--sol-text)" }}>{value}</div>
      <div className="text-[10px] mt-1" style={{ color: "var(--sol-text-dim)" }}>{label}</div>
    </div>
  );
}

function SessionPanel({ tree, session, parent, canEdit, onOpenSession, onMove, onSelectNode, now }: { tree: OrgTree; session: OrgSession; parent: OrgParentRef; canEdit: boolean; onOpenSession: (id: string) => void; onMove: OrgScopePanelProps["onMove"]; onSelectNode: (id: string) => void; now: number }) {
  const owner = session.owner_user_id ? tree.people.find((p) => p.user_id === session.owner_user_id) : null;
  return (
    <>
      <div className="flex items-start gap-2.5">
        <AgentIcon agentType={session.agent_type} className="w-6 h-6 mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="text-[17px] leading-snug font-semibold tracking-tight" style={{ fontFamily: "var(--font-serif)", color: "var(--sol-text)" }}>{session.title || "Untitled"}</div>
          <div className="mt-1 flex items-center gap-2 flex-wrap text-[11px]" style={{ color: "var(--sol-text-dim)", fontFamily: "var(--font-mono)" }}>
            <span>{session.short_id}</span>
            <StateChip state={session.state} />
            <span>{compactAge(now - session.updated_at)} ago</span>
          </div>
        </div>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2 text-[12px]">
        <KV k="agent" v={session.agent_type} />
        <KV k="subagents" v={String(session.subagent_count)} />
        {session.project_path && <KV k="project" v={session.project_path} mono />}
        {session.git_branch && <KV k="branch" v={session.git_branch} mono />}
      </div>
      <SectionLabel>Reports to</SectionLabel>
      <div className="flex items-center gap-2 flex-wrap text-[12.5px]">
        <button type="button" onClick={() => onSelectNode(parentNodeId(parent))} className="font-medium hover:underline" style={{ color: "var(--sol-text)" }}>{parentName(tree, parent)}</button>
        {parent.kind === "role" && owner && <span style={{ color: "var(--sol-text-dim)" }}>· owned by {owner.name}</span>}
      </div>
      <div className="mt-5 flex items-center gap-2">
        <OrgButton primary onClick={() => onOpenSession(session._id)}>
          <ExternalLink className="w-3.5 h-3.5" /> Open session
        </OrgButton>
        {canEdit && (
          <button type="button" onClick={() => onMove({ kind: "session", id: session._id, title: session.title || session.short_id })} className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border text-[12px] font-medium hover:bg-sol-bg-highlight/60" style={{ borderColor: "color-mix(in srgb, var(--sol-border) 45%, transparent)", color: "var(--sol-text-muted)" }}>
            <ArrowRightLeft className="w-3.5 h-3.5" /> Move to…
          </button>
        )}
      </div>
    </>
  );
}

function KV({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-[0.08em]" style={{ color: "var(--sol-text-dim)" }}>{k}</div>
      <div className="truncate mt-0.5" style={{ color: "var(--sol-text-secondary)", fontFamily: mono ? "var(--font-mono)" : undefined }} title={v}>{v}</div>
    </div>
  );
}

function AnchorPanel({ tree, anchor, onOpenSession }: { tree: OrgTree; anchor: OrgTree["anchors"][number]; onOpenSession: (id: string) => void }) {
  const host = tree.people.find((p) => p.user_id === anchor.host_user_id);
  const st = anchor.state ? ORG_STATE_META[anchor.state] : null;
  return (
    <>
      <div className="flex items-center gap-3">
        <span className="inline-flex items-center justify-center w-9 h-9 rounded-full" style={{ background: "color-mix(in srgb, var(--sol-orange) 16%, transparent)", color: "var(--sol-orange)" }}><AnchorGlyph className="w-4 h-4" /></span>
        <div className="min-w-0">
          <div className="text-[20px] leading-tight font-semibold tracking-tight truncate" style={{ fontFamily: "var(--font-serif)", color: "var(--sol-text)" }}>{anchor.name}</div>
          <div className="text-[11px] mt-0.5 flex items-center gap-1.5" style={{ color: "var(--sol-text-dim)" }}>
            <span>standing agent · {anchor.status}</span>
            {st && <span style={{ color: st.color }}>· {st.label}</span>}
          </div>
        </div>
      </div>
      <StandingLine standing={anchor} size="md" className="mt-3" />
      <SectionLabel>Hosted by</SectionLabel>
      <div className="text-[12.5px] font-medium" style={{ color: "var(--sol-text)" }}>{host?.name ?? "—"}</div>
      {anchor.conversation_id && (
        <OrgButton primary className="mt-5" onClick={() => onOpenSession(anchor.conversation_id!)}>
          <ExternalLink className="w-3.5 h-3.5" /> Open its session
        </OrgButton>
      )}
    </>
  );
}

// ---------------------------------------------------------------- shell

function PanelTab({ active, onClick, children, count }: { active: boolean; onClick: () => void; children: React.ReactNode; count?: number }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn("relative h-10 inline-flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-[0.08em] transition-colors", active ? "text-sol-text" : "text-sol-text-dim hover:text-sol-text-muted")}
    >
      {children}
      {count !== undefined && count > 0 && (
        <span className="inline-flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full text-[9.5px] font-semibold tabular-nums" style={{ background: "var(--sol-violet)", color: "var(--sol-bg)" }}>{count}</span>
      )}
      {active && <span className="absolute left-0 right-0 -bottom-px h-[2px] rounded-full" style={{ background: "var(--sol-violet)" }} />}
    </button>
  );
}

export function OrgScopePanel(props: OrgScopePanelProps) {
  const { node, onClose } = props;
  const now = useCoarseNow(30_000);
  // With nothing selected the node tab has no subject; the sheet is the
  // staffing pane alone.
  const mode: OrgPanelMode = node || props.mode === "history" ? props.mode : "staffing";
  // A proposal with nothing else selected is the page (org-staffing.md S19):
  // no tab strip, the conversation starts on the first line, and the asks
  // header carries the close. With a node selected too, the two tabs stay.
  const stripless = mode === "staffing" && !node && !!(props.staffingLead || props.staffingFill);
  return (
    <div className="h-full flex flex-col min-h-0" data-panel-strip={stripless ? "none" : "tabs"}>
      {!stripless && <div className="flex items-center justify-between h-10 px-4 shrink-0 border-b" style={{ borderColor: "color-mix(in srgb, var(--sol-border) 25%, transparent)" }}>
        <div className="flex items-center gap-4" role="tablist">
          {node && (
            <PanelTab active={mode === "node"} onClick={() => props.onMode("node")}>
              {node.kind === "cluster" ? "sessions" : node.kind}
            </PanelTab>
          )}
          <PanelTab active={mode === "staffing"} onClick={() => props.onMode("staffing")} count={props.staffingCount}>{staffingPaneWord((props.staffingCount ?? 0) > 0)}</PanelTab>
          {props.history && <PanelTab active={mode === "history"} onClick={() => props.onMode("history")}>history</PanelTab>}
        </div>
        <button type="button" onClick={onClose} className="w-7 h-7 -mr-2 inline-flex items-center justify-center rounded-md hover:bg-sol-bg-highlight" aria-label="Close panel" style={{ color: "var(--sol-text-dim)" }}>
          <X className="w-4 h-4" />
        </button>
      </div>}
      <div className="flex-1 min-h-0 flex">
      {mode === "staffing" && props.staffingLead && (
        <div className="min-w-0 min-h-0 border-r flex flex-col" style={{ width: props.staffingLeadWidth ?? STAFFING_LEAD_W.tight, flex: "1 1 auto", borderColor: "color-mix(in srgb, var(--sol-border) 25%, transparent)" }} data-staffing-lead>
          {props.staffingLead}
        </div>
      )}
      <div className={cn("min-w-0 min-h-0", mode === "staffing" && props.staffingLead ? "shrink-0" : "flex-1", mode === "staffing" && props.staffingFill ? "flex flex-col overflow-hidden" : "overflow-y-auto px-4 pt-4 pb-8")} style={mode === "staffing" && props.staffingLead ? { width: STAFFING_ASKS_W } : undefined} data-main-scroll data-panel-mode={mode}>
        {mode === "staffing" ? props.staffing : mode === "history" ? props.history : node && (
          <>
            {node.kind === "role" && <RolePanel tree={props.tree} role={node.role} sessions={props.sessions} canEdit={props.canEdit} onOpenSession={props.onOpenSession} onMove={props.onMove} onUpdateRole={props.onUpdateRole} onRetireRole={props.onRetireRole} onSelectNode={props.onSelectNode} now={now} changes={props.changes} focusChangeId={props.focusChangeId} onSelectChange={props.onSelectChange} />}
            {node.kind === "person" && <PersonPanel tree={props.tree} person={node.person} sessions={props.sessions} onOpenSession={props.onOpenSession} now={now} />}
            {node.kind === "session" && <SessionPanel tree={props.tree} session={node.session} parent={node.parent} canEdit={props.canEdit} onOpenSession={props.onOpenSession} onMove={props.onMove} onSelectNode={props.onSelectNode} now={now} />}
            {node.kind === "anchor" && <AnchorPanel tree={props.tree} anchor={node.anchor} onOpenSession={props.onOpenSession} />}
            {node.kind === "cluster" && <p className="text-[12px]" style={{ color: "var(--sol-text-dim)" }}>Click the card to load more sessions.</p>}
          </>
        )}
      </div>
      </div>
    </div>
  );
}

/** The asks column (S19): the panel's own 380px. */
export const STAFFING_ASKS_W = 380;
/** The conversation's column to its left: wider, as the eye should land
 *  there; `roomy` when the window leaves a strip of chart beside both,
 *  `tight` when it does not. */
export const STAFFING_LEAD_W = { roomy: 600, tight: 420 } as const;


