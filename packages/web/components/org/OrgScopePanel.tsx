"use client";
// The right panel for the selected org node. A role shows its handle, name,
// charter, editable scope (project and plan chips) and ONE feed of everything
// under the scope: sessions filed under the role, tasks and docs whose
// project_id or plan_id is in scope, newest first. A person shows counts and
// their sessions. A session shows what it is, its parent, and an open link.
import { useMemo } from "react";
import { ShortId } from "../ShortId";
import Link from "next/link";
import { X, ExternalLink, ArrowRightLeft, CheckSquare, Users, Crown, Shield } from "lucide-react";
import { useWorkspaceCollection } from "../../hooks/useWorkspaceCollection";
import type { TaskItem, DocItem } from "../../store/inboxStore";
import { compactAge, agoOf } from "../../lib/threadState";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { SessionIdentityLine, SessionMark } from "../identity";
import { Avatar } from "../tasks/TaskCommentStream";
import { cn } from "../../lib/utils";
import { StateBar, StateTally, StandingLine } from "./OrgNodeCards";
import { ORG_STATE_META, parentName, staffingPaneWord } from "./orgMeta";
import { OrgButton } from "./OrgButton";
import type { OrgLayoutNode } from "./orgLayout";
import { parentNodeId } from "./orgLayout";
import type { OrgParentRef, OrgRole, OrgSession, OrgTree } from "./orgTypes";
import { isHeadOfPeopleRole, type OrgProposalChange } from "./orgStaffingTypes";
import type { OrgUpdateRoleInput } from "../../store/orgSlice";
import { STAFFING_ASKS_W, STAFFING_LEAD_W } from "../../lib/orgPanelLayout";
import { DocRow, GatedScopeEditor, InlineEdit, SectionLabel } from "./scope/ScopeEditors";

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
   *  chip on the scope row it names (org-staffing.md S5). */
  changes?: OrgProposalChange[];
  focusChangeId?: string | null;
  onSelectChange?: (changeId: string) => void;
};

type FeedRow =
  | { kind: "session"; id: string; title: string; at: number; session: OrgSession }
  | { kind: "task"; id: string; title: string; at: number; task: TaskItem }
  | { kind: "doc"; id: string; title: string; at: number; doc: DocItem };

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
      <SessionMark session={s as any} iconClassName="w-4 h-4" />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 text-[12.5px]"><SessionIdentityLine row={s as any} title={s.title || "Untitled"} titleClassName="font-medium" /></span>
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

function Feed({ rows, now, onOpenSession, more }: { rows: FeedRow[]; now: number; onOpenSession: (id: string) => void; more?: React.ReactNode }) {
  if (rows.length === 0 && !more) {
    return <p className="text-[12px] px-2.5 py-3" style={{ color: "var(--sol-text-dim)" }}>Nothing here yet.</p>;
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

function RolePanel({ tree, role, sessions, canEdit, onOpenSession, onMove, onUpdateRole, onSelectNode, now, changes, focusChangeId, onSelectChange }: {
  tree: OrgTree; role: OrgRole; sessions: OrgSessionsSource; canEdit: boolean; now: number;
  onOpenSession: (id: string) => void; onMove: OrgScopePanelProps["onMove"]; onUpdateRole: OrgScopePanelProps["onUpdateRole"]; onSelectNode: (id: string) => void;
  changes?: OrgProposalChange[]; focusChangeId?: string | null; onSelectChange?: (changeId: string) => void;
}) {
  const parentId = parentNodeId({ kind: "role", role_id: role._id });
  const tasks = useWorkspaceCollection<TaskItem>("tasks");
  const docs = useWorkspaceCollection<DocItem>("docs");
  const inScope = (row: { project_id?: string | null; plan_id?: string | null }) => {
    const empty = role.scope.project_ids.length === 0 && role.scope.plan_ids.length === 0;
    // With no area named, only the Head of People covers everything (S26).
    if (empty) return isHeadOfPeopleRole(role);
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
        <Link href={`/org/${role.short_id}`} className="ml-auto inline-flex items-center gap-1 text-[11px] px-1.5 h-[20px] rounded-md hover:bg-sol-bg-highlight" style={{ color: "var(--sol-violet)" }}>
          Open its page <ExternalLink className="w-3 h-3" />
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

      {/* What it is for is written on its page; here it is read. */}
      {role.charter?.trim() && (
        <>
          <SectionLabel>What it is for</SectionLabel>
          <p className="text-[12.5px] leading-relaxed whitespace-pre-wrap" style={{ color: "var(--sol-text-secondary)" }} data-role-charter>{role.charter.trim()}</p>
        </>
      )}

      <SectionLabel>Area</SectionLabel>
      <GatedScopeEditor workspace={tree.workspace} role={role} canEdit={canEdit} onChange={(scope, opts) => onUpdateRole(role._id, { scope }, opts)} changes={changes} focusChangeId={focusChangeId} onSelectChange={onSelectChange} />

      <SectionLabel right={<StateTally counts={role.counts} />}>Sessions</SectionLabel>
      <StateBar counts={role.counts} />

      <SectionLabel right={<span className="text-[10.5px] tabular-nums" style={{ color: "var(--sol-text-dim)" }}>{counts.sessions} sessions · {counts.tasks} tasks · {counts.docs} pages</span>}>In its area</SectionLabel>
      <Feed rows={rows} now={now} onOpenSession={onOpenSession} more={<LoadMore parentId={parentId} sessions={sessions} />} />

    </>
  );
}

function PersonPanel({ tree, person, sessions, onOpenSession, now }: { tree: OrgTree; person: OrgTree["people"][number]; sessions: OrgSessionsSource; onOpenSession: (id: string) => void; now: number }) {
  const parentId = parentNodeId({ kind: "user", user_id: person.user_id });
  const roles = tree.roles.filter((r) => r.reports_to.kind === "user" && r.reports_to.user_id === person.user_id && r.status !== "retired");
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
      <div className="mt-2 grid grid-cols-2 gap-2">
        <Stat label="sessions" value={person.total} />
        <Stat label="roles" value={roles.length} />
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
        <SessionMark session={session as any} size={24} iconClassName="w-6 h-6" className="shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="text-[17px] leading-snug font-semibold tracking-tight" style={{ fontFamily: "var(--font-serif)", color: "var(--sol-text)" }}>{session.title || "Untitled"}</div>
          <div className="mt-1 flex items-center gap-2 flex-wrap text-[11px]" style={{ color: "var(--sol-text-dim)", fontFamily: "var(--font-mono)" }}>
            <ShortId id={session.short_id} />
            <StateChip state={session.state} />
            <span>{agoOf(now - session.updated_at)}</span>
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
  // no tab strip, the conversation starts on the first line, and the page's
  // own header names the proposal and the way back. With a node selected
  // too, the two tabs stay.
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
            {node.kind === "role" && <RolePanel tree={props.tree} role={node.role} sessions={props.sessions} canEdit={props.canEdit} onOpenSession={props.onOpenSession} onMove={props.onMove} onUpdateRole={props.onUpdateRole} onSelectNode={props.onSelectNode} now={now} changes={props.changes} focusChangeId={props.focusChangeId} onSelectChange={props.onSelectChange} />}
            {node.kind === "person" && <PersonPanel tree={props.tree} person={node.person} sessions={props.sessions} onOpenSession={props.onOpenSession} now={now} />}
            {node.kind === "session" && <SessionPanel tree={props.tree} session={node.session} parent={node.parent} canEdit={props.canEdit} onOpenSession={props.onOpenSession} onMove={props.onMove} onSelectNode={props.onSelectNode} now={now} />}
            {node.kind === "cluster" && <p className="text-[12px]" style={{ color: "var(--sol-text-dim)" }}>Click the card to load more sessions.</p>}
          </>
        )}
      </div>
      </div>
    </div>
  );
}
