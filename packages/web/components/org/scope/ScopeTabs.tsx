"use client";
// The scope page's store-fed tabs (docs/architecture/scopes-and-feed.md F3):
// plans, pages, sessions and decisions in scope, painted from the local store
// and the org tree, plus the brief and charter documents.
import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { CheckSquare, ExternalLink, Layers, MessageCircleQuestionMark } from "lucide-react";
import { useWorkspaceCollection } from "../../../hooks/useWorkspaceCollection";
import { useCoarseNow } from "../../../hooks/useCoarseNow";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import { useOrgSessionsUnder } from "../../../hooks/useOrgSessionsUnder";
import type { ScopeRef } from "../../../hooks/useScopeQueries";
import { ScopeFeed } from "./ScopeFeed";
import { useOpenLinkedSession } from "../../../hooks/useOpenLinkedSession";
import { useSyncDocDetail } from "../../../hooks/useSyncDocs";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore, type DecisionStackItem, type DocItem, type PlanItem, type SessionDecisionItem, type TaskItem } from "../../../store/inboxStore";
import { useCollectionRows } from "../../../hooks/useCollectionRows";
import { useSyncDecisionStacks } from "../../../hooks/useSyncDecisionStacks";
import { useQueryNoThrow } from "../../../hooks/useQueryNoThrow";
import { StackChecklist } from "../../decisions/StackChecklist";
import { DecisionCompactCard } from "../../decisions/DecisionCompactCard";
import { compactAge } from "../../../lib/threadState";
import { cn } from "../../../lib/utils";
import { DocumentDetailLayout } from "../../DocumentDetailLayout";
import { MarkdownRenderer } from "../../tools/MarkdownRenderer";
import { DocRow, InlineEdit } from "../OrgScopePanel";
import { StateBar, StateTally } from "../OrgNodeCards";
import { AgentIcon } from "../../ConversationList";
import { ORG_STATE_META } from "../orgMeta";
import { ORG_TOP_N, sortOrgSessions, type OrgRole, type OrgSession, type OrgTree } from "../orgTypes";
import { boundTaskOf, groupHands, subtaskCounts } from "../../../lib/scopePage";
import type { BriefFacts, BriefHand } from "./scopeTypes";
import { PersonGoals } from "./PersonGoals";
import { inScope, useScopeIds, type ScopeIds } from "../../../hooks/useScopeIds";
import { decisionHref } from "../../../lib/decisionLinks";

const api = _api as any;

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="py-14 text-center">
      <p className="text-[13px]" style={{ color: "var(--sol-text-muted)" }}>{title}</p>
      {hint && <p className="mt-1 text-[11.5px]" style={{ color: "var(--sol-text-dim)" }}>{hint}</p>}
    </div>
  );
}

// ---------------------------------------------------------------- plans

const PLAN_STATUS_TONE: Record<string, string> = { active: "var(--sol-green)", draft: "var(--sol-text-dim)", done: "var(--sol-cyan)", dropped: "var(--sol-red)", paused: "var(--sol-yellow)" };

export function ScopePlansTab({ ids }: { ids: ScopeIds }) {
  const plans = useWorkspaceCollection<PlanItem>("plans");
  const now = useCoarseNow(30_000);
  const rows = useMemo(() => plans.filter((p) => ids.whole || ids.planIds.includes(p._id)).sort((a, b) => ((b as any).updated_at ?? 0) - ((a as any).updated_at ?? 0)), [plans, ids]);
  if (rows.length === 0) return <Empty title="No plans in this scope." hint="Add a plan or a project to the scope in Settings." />;
  return (
    <ul className="space-y-1">
      {rows.map((p) => {
        const pr = p.progress;
        const pct = pr && pr.total > 0 ? Math.round((pr.done / pr.total) * 100) : 0;
        const tone = PLAN_STATUS_TONE[p.status] ?? "var(--sol-text-dim)";
        return (
          <li key={p._id}>
            <Link href={`/plans/${p.short_id ?? p._id}`} className="group flex items-center gap-2.5 px-2.5 py-2 rounded-xl transition-colors hover:bg-sol-bg-highlight/70">
              <span className="w-[3px] self-stretch rounded-full shrink-0" style={{ background: tone }} />
              <Layers className="w-4 h-4 shrink-0" style={{ color: "var(--sol-magenta)" }} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium" style={{ color: "var(--sol-text)" }}>{p.title}</span>
                <span className="block truncate text-[10.5px] mt-[1px]" style={{ color: "var(--sol-text-dim)", fontFamily: "var(--font-mono)" }}>{p.short_id} · {p.status}{pr ? ` · ${pr.done}/${pr.total} done` : ""}</span>
              </span>
              {pr && pr.total > 0 && (
                <span className="hidden sm:flex items-center gap-2 shrink-0">
                  <span className="w-20 h-1 rounded-full overflow-hidden" style={{ background: "color-mix(in srgb, var(--sol-border) 30%, transparent)" }}>
                    <span className="block h-full" style={{ width: `${pct}%`, background: "var(--sol-green)" }} />
                  </span>
                  <span className="text-[10.5px] tabular-nums w-8 text-right" style={{ color: "var(--sol-text-dim)" }}>{pct}%</span>
                </span>
              )}
              <span className="text-[10.5px] tabular-nums shrink-0" style={{ color: "var(--sol-text-dim)" }}>{compactAge(now - ((p as any).updated_at ?? now))}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------- docs

export function ScopeDocsTab({ ids }: { ids: ScopeIds }) {
  const docs = useWorkspaceCollection<DocItem>("docs");
  const now = useCoarseNow(30_000);
  const rows = useMemo(() => docs.filter((d) => inScope(ids, d as any) && !(d as any).parent_id).sort((a, b) => b.updated_at - a.updated_at), [docs, ids]);
  if (rows.length === 0) return <Empty title="No pages in this scope." hint="Pages filed under a project or plan in scope show here." />;
  return <ul className="space-y-1">{rows.map((d) => <li key={d._id}><DocRow d={d} now={now} /></li>)}</ul>;
}

// ---------------------------------------------------------------- sessions

/** One page of org.sessionsUnder for a role; reports once and stays mounted. */
function RoleSessionsPage({ roleId, teamId, cursor, onPage }: { roleId: string; teamId?: string; cursor?: string; onPage: (cursor: string | undefined, rows: OrgSession[], next?: string) => void }) {
  const { data } = useOrgSessionsUnder({ parent: { kind: "role", role_id: roleId }, ...(teamId ? { team_id: teamId } : {}), ...(cursor ? { cursor } : {}), limit: 50 });
  useWatchEffect(() => { if (data) onPage(cursor, (data.sessions ?? []) as OrgSession[], data.next_cursor ?? undefined); }, [data, cursor, onPage]);
  return null;
}

/** One hand (F4.3): its title, its one line state, its age, and its task's
 *  open and closed subtask counts when it is bound to a task that has them. */
export function HandRow({ s, stateLine, task, progress, now, onOpen }: {
  s: OrgSession;
  stateLine: string | null;
  task: { short_id: string; title: string } | null;
  progress: { open: number; closed: number } | null;
  now: number;
  onOpen: () => void;
}) {
  const m = ORG_STATE_META[s.state] ?? ORG_STATE_META.idle;
  const total = progress ? progress.open + progress.closed : 0;
  return (
    <button type="button" onClick={onOpen} className="group w-full text-left flex items-center gap-2.5 px-2.5 py-2 rounded-lg transition-colors hover:bg-sol-bg-highlight/70" data-hand={s._id} data-hand-state={s.state}>
      <span className="w-[3px] self-stretch rounded-full shrink-0" style={{ background: m.color }} />
      <AgentIcon agentType={s.agent_type} className="w-4 h-4 shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] font-medium" style={{ color: "var(--sol-text)" }}>{s.title || "Untitled"}</span>
        <span className="block truncate text-[11px] mt-[1px]" style={{ color: stateLine ? "var(--sol-text-muted)" : "var(--sol-text-dim)" }} data-hand-line>{stateLine ?? m.label}</span>
        {task && (
          <span className="block truncate text-[10.5px] mt-[1px]" style={{ color: "var(--sol-text-dim)", fontFamily: "var(--font-mono)" }} data-hand-task={task.short_id}>
            {task.short_id} · {task.title}
          </span>
        )}
      </span>
      {progress && total > 0 && (
        <span className="shrink-0 inline-flex items-center gap-1.5" title={`${progress.closed} of ${total} subtasks done, ${progress.open} open`} data-hand-progress={`${progress.closed}/${total}`}>
          <span className="w-12 h-1 rounded-full overflow-hidden" style={{ background: "color-mix(in srgb, var(--sol-border) 30%, transparent)" }}>
            <span className="block h-full" style={{ width: `${Math.round((progress.closed / total) * 100)}%`, background: "var(--sol-green)" }} />
          </span>
          <span className="text-[10.5px] tabular-nums" style={{ color: "var(--sol-text-dim)" }}>{progress.closed}/{total}</span>
        </span>
      )}
      <span className="text-[10.5px] tabular-nums shrink-0" style={{ color: "var(--sol-text-dim)" }}>{compactAge(now - s.updated_at)}</span>
      <ExternalLink className="w-3 h-3 shrink-0 opacity-0 group-hover:opacity-70 transition-opacity" style={{ color: "var(--sol-text-dim)" }} />
    </button>
  );
}

/** The hands grouped by who acts next (F4.3), the inbox's groups in the
 *  inbox's order. The state line and the task come from the store when it
 *  holds the session (the row's own `thread_state` and `active_task_id`),
 *  else from the brief's facts; subtask counts derive live from the tasks
 *  collection, never a stored twin. */
export function HandGroups({ rows, hands, now, onOpen }: { rows: OrgSession[]; hands?: BriefHand[] | null; now: number; onOpen: (s: OrgSession) => void }) {
  const tasks = useWorkspaceCollection<TaskItem>("tasks");
  // Subscribe to the two fields a row shows, never the session rows: a
  // heartbeat on any hand would otherwise repaint the whole list.
  const storeSig = useInboxStore((st) => rows.map((r) => { const row = st.sessions[r._id] as any; return `${row?.thread_state ? String(row.thread_state).split("\n")[0] : ""}|${row?.active_task_id ?? ""}`; }).join("\n"));
  const groups = useMemo(() => groupHands(rows), [rows]);
  const factsById = useMemo(() => new Map((hands ?? []).map((h) => [h._id, h])), [hands]);
  const detail = useMemo(() => {
    const st = useInboxStore.getState();
    const out = new Map<string, { stateLine: string | null; task: { short_id: string; title: string } | null; progress: { open: number; closed: number } | null }>();
    for (const r of rows) {
      const row = st.sessions[r._id] as any;
      const fact = factsById.get(r._id);
      const stateLine = (row?.thread_state ? String(row.thread_state).split("\n")[0].trim() : "") || fact?.state_line || null;
      const bound = boundTaskOf(r._id, row?.active_task_id ? String(row.active_task_id) : null, tasks as any[]);
      const task = bound ? { short_id: bound.short_id, title: bound.title } : fact?.task ? { short_id: fact.task.short_id, title: fact.task.title } : null;
      out.set(r._id, { stateLine, task, progress: bound ? subtaskCounts(bound._id, tasks as any[]) : null });
    }
    return out;
  }, [rows, tasks, factsById, storeSig]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="space-y-4" data-hand-groups={groups.length}>
      {groups.map((g) => (
        <section key={g.state} data-hand-group={g.state}>
          <h3 className="px-2.5 mb-1 flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-[0.08em]" style={{ color: g.color }}>
            <span className="w-[6px] h-[6px] rounded-full" style={{ background: g.color }} />
            {g.label}
            <span className="tabular-nums font-normal" style={{ color: "var(--sol-text-dim)" }}>{g.rows.length}</span>
          </h3>
          <ul className="space-y-0.5">
            {g.rows.map((s) => {
              const d = detail.get(s._id)!;
              return <li key={s._id}><HandRow s={s} stateLine={d.stateLine} task={d.task} progress={d.progress} now={now} onOpen={() => onOpen(s)} /></li>;
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

export function ScopeSessionsTab({ tree, role, scope, hands }: { tree: OrgTree; role: OrgRole | null; scope: ScopeRef | null; hands?: BriefHand[] | null }) {
  const now = useCoarseNow(30_000);
  const openLinked = useOpenLinkedSession();
  const [pages, setPages] = useState<Record<string, { rows: OrgSession[]; next?: string }>>({});
  const [requested, setRequested] = useState<string[]>([]);
  const onPage = useCallback((cursor: string | undefined, rows: OrgSession[], next?: string) => {
    setPages((prev) => ({ ...prev, [cursor ?? String(ORG_TOP_N)]: { rows, next } }));
  }, []);
  const teamId = tree.workspace.kind === "team" ? tree.workspace.id : undefined;

  const rows = useMemo(() => {
    if (!role) {
      // The root: every session in the tree, people and roles alike.
      const all = [...tree.people.flatMap((p) => p.sessions), ...tree.roles.flatMap((r) => r.sessions)];
      return sortOrgSessions(all);
    }
    const byId = new Map<string, OrgSession>();
    for (const s of role.sessions) byId.set(s._id, s);
    let key = String(ORG_TOP_N);
    for (let guard = 0; guard < 100; guard++) {
      const page = pages[key];
      if (!page) break;
      for (const s of page.rows) byId.set(s._id, s);
      if (!page.next) break;
      key = page.next;
    }
    return sortOrgSessions(Array.from(byId.values()));
  }, [tree, role, pages]);

  const counts = role ? role.counts : tree.people.concat(tree.roles as any).reduce((acc: any, b: any) => { for (const k of Object.keys(b.counts)) acc[k] = (acc[k] ?? 0) + b.counts[k]; return acc; }, { working: 0, needs_input: 0, done: 0, dormant: 0, idle: 0 });
  const total = role ? role.total : rows.length;
  // The tree carries the top ORG_TOP_N; the rest page in through sessionsUnder,
  // whose cursor is an offset, so the first extra page starts at ORG_TOP_N.
  const nextCursor = useMemo(() => {
    if (!role) return undefined;
    let key = "";
    let next: string | undefined = String(ORG_TOP_N);
    for (let g = 0; g < 100; g++) {
      const p = pages[key === "" ? String(ORG_TOP_N) : key];
      if (!p) break;
      next = p.next;
      if (!p.next) break;
      key = p.next;
    }
    return next;
  }, [role, pages]);
  const pending = requested.some((c) => !pages[c]);
  const canLoad = !!role && !!nextCursor && !requested.includes(nextCursor) && rows.length < total;

  return (
    <div>
      <div className="flex items-center justify-between px-2.5 pb-2">
        <StateTally counts={counts} />
        <span className="text-[11px] tabular-nums" style={{ color: "var(--sol-text-dim)" }}>{rows.length} of {total} session{total === 1 ? "" : "s"}</span>
      </div>
      <StateBar counts={counts} className="mx-2.5 mb-3" />
      {role && requested.map((c) => <RoleSessionsPage key={c} roleId={role._id} teamId={teamId} cursor={c} onPage={onPage} />)}
      {rows.length === 0 ? (
        <Empty title={role ? "No sessions under this role yet." : "No sessions in the last 30 days."} hint={role ? "Ask the role for something in the conversation: the session it starts for the work shows here, grouped by who acts next." : undefined} />
      ) : (
        <HandGroups rows={rows} hands={hands} now={now} onOpen={(s) => openLinked({ _id: s._id, short_id: s.short_id, title: s.title, agent_type: s.agent_type })} />
      )}
      {canLoad && (
        <div className="pt-2 text-center">
          <button type="button" disabled={pending} onClick={() => nextCursor && setRequested((r) => [...r, nextCursor])} className="text-[11.5px] hover:underline disabled:opacity-50" style={{ color: "var(--sol-text-muted)" }}>
            {pending ? "Loading…" : `Load ${Math.min(50, total - rows.length)} more`}
          </button>
        </div>
      )}
      {role && scope && (
        <section className="mt-6">
          <h3 className="px-2.5 mb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.08em]" style={{ color: "var(--sol-text-dim)" }}>In scope · bound to a task or plan here, or on a scope project's path</h3>
          <ScopeFeed scope={scope} lockKinds={["session"]} />
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- decisions

const DECISION_TONE: Record<string, string> = { pending: "var(--sol-yellow)", answered: "var(--sol-cyan)", dismissed: "var(--sol-text-dim)", withdrawn: "var(--sol-text-dim)" };

const stackSig = (st: DecisionStackItem) => `${st.status}|${st.title}|${st.decision_ids.join(",")}|${(st as any).policy?.due_at ?? ""}`;

/** Stacks that hold at least one decision bound to a task in scope (the-line.md L10). */
export function stacksInScope(stacks: DecisionStackItem[], decisionIds: Set<string>): DecisionStackItem[] {
  return stacks.filter((st) => st.status === "open" && st.decision_ids.some((id) => decisionIds.has(id)));
}

export function ScopeDecisionsTab({ ids, roleId }: { ids: ScopeIds; roleId?: string | null }) {
  const tasks = useWorkspaceCollection<TaskItem>("tasks");
  const decisions = useInboxStore((s) => s.sessionDecisions);
  const now = useCoarseNow(30_000);
  // Stacks (D5) paint from the store; the feeder is the same one the queue
  // mounts. The role's ladder rows are a per view enrichment: pending
  // decisions the role sits on the ladder of, read once for this tab.
  useSyncDecisionStacks();
  const stackRows = useCollectionRows<DecisionStackItem>("decisionStacks", { sig: stackSig });
  const { data: ladderRows } = useQueryNoThrow(api.sessionDecisions.listForRole, roleId ? { role_id: roleId } : "skip");
  const { open, answered, stacks, ladder } = useMemo(() => {
    const taskIds = new Set(tasks.filter((t) => inScope(ids, t as any)).map((t) => t._id));
    const rows = (Object.values(decisions) as Array<SessionDecisionItem & { short_id?: string; task_id?: string }>)
      .filter((d) => d.task_id && taskIds.has(d.task_id));
    const stacks = stacksInScope(stackRows, new Set(rows.map((d) => d._id)));
    const stacked = new Set(stacks.flatMap((st) => st.decision_ids));
    const ladder = ((ladderRows ?? []) as SessionDecisionItem[]).filter((d) => d.status === "pending" && !stacked.has(d._id)).sort((a, b) => b.created_at - a.created_at);
    const shown = new Set([...stacked, ...ladder.map((d) => d._id)]);
    const open = rows.filter((d) => d.status === "pending" && !shown.has(d._id)).sort((a, b) => b.created_at - a.created_at);
    const answered = rows.filter((d) => d.status !== "pending").sort((a, b) => (b.resolved_at ?? b.created_at) - (a.resolved_at ?? a.created_at));
    return { open, answered, stacks, ladder };
  }, [tasks, decisions, ids, stackRows, ladderRows]);
  const taskById = useMemo(() => new Map(tasks.map((t) => [t._id, t])), [tasks]);
  if (open.length === 0 && answered.length === 0 && stacks.length === 0 && ladder.length === 0) return <Empty title="No decisions on tasks in this scope." hint="A cast decide raised from a session bound to a task in scope shows here, open first." />;
  const Row = ({ d }: { d: SessionDecisionItem & { short_id?: string; task_id?: string } }) => {
    const tone = DECISION_TONE[d.status] ?? "var(--sol-text-dim)";
    const task = d.task_id ? taskById.get(d.task_id) : undefined;
    const answer = d.status === "answered" ? (d.answer_text ?? (d.answer_index !== undefined ? d.options[d.answer_index]?.label : undefined)) : undefined;
    return (
      <li>
        <Link href={decisionHref(d)} className="group flex items-start gap-2.5 px-2.5 py-2 rounded-xl transition-colors hover:bg-sol-bg-highlight/70">
          <span className="w-[3px] self-stretch rounded-full shrink-0" style={{ background: tone }} />
          <MessageCircleQuestionMark className="w-4 h-4 shrink-0 mt-[2px]" style={{ color: tone }} />
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] font-medium leading-snug line-clamp-2" style={{ color: "var(--sol-text)" }}>{d.question}</span>
            <span className="mt-[3px] flex items-center gap-1.5 text-[10.5px] min-w-0" style={{ color: "var(--sol-text-dim)" }}>
              {d.short_id && <span style={{ fontFamily: "var(--font-mono)" }}>{d.short_id}</span>}
              <span className="px-1.5 h-[16px] inline-flex items-center rounded-md border" style={{ borderColor: `color-mix(in srgb, ${tone} 45%, transparent)`, color: tone }}>{d.status}</span>
              {d.blocking && d.status === "pending" && <span style={{ color: "var(--sol-yellow)" }}>blocking</span>}
              {task && <span className="truncate inline-flex items-center gap-1"><CheckSquare className="w-3 h-3" />{task.short_id} {task.title}</span>}
              {answer && <span className="truncate">→ {answer}</span>}
            </span>
          </span>
          <span className="text-[10.5px] tabular-nums shrink-0" style={{ color: "var(--sol-text-dim)" }}>{compactAge(now - (d.resolved_at ?? d.created_at))}</span>
        </Link>
      </li>
    );
  };
  return (
    <div className="space-y-5">
      {stacks.length > 0 && (
        <section data-scope-stacks>
          <h3 className="px-2.5 mb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.08em]" style={{ color: "var(--sol-text-dim)" }}>Stacks · {stacks.length}</h3>
          <div className="space-y-3">{stacks.map((st) => <StackChecklist key={st._id} stack={st} />)}</div>
        </section>
      )}
      {ladder.length > 0 && (
        <section data-scope-ladder>
          <h3 className="px-2.5 mb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.08em]" style={{ color: "var(--sol-text-dim)" }}>On this role's ladder · {ladder.length}</h3>
          <div className="space-y-2">{ladder.map((d) => <DecisionCompactCard key={d._id} decision={d} />)}</div>
        </section>
      )}
      <section>
        <h3 className="px-2.5 mb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.08em]" style={{ color: "var(--sol-text-dim)" }}>Open · {open.length}</h3>
        {open.length === 0 ? <p className="px-2.5 text-[12px]" style={{ color: "var(--sol-text-dim)" }}>Nothing waiting on a person.</p> : <ul className="space-y-1">{open.map((d) => <Row key={d._id} d={d} />)}</ul>}
      </section>
      {answered.length > 0 && (
        <section>
          <h3 className="px-2.5 mb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.08em]" style={{ color: "var(--sol-text-dim)" }}>Answered · {answered.length}</h3>
          <ul className="space-y-1">{answered.map((d) => <Row key={d._id} d={d} />)}</ul>
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- brief and charter

/** A role document by id through the doc editor; the same layout /docs/[id] mounts. */
function RoleDoc({ docId, editable, backHref }: { docId: string; editable: boolean; backHref: string }) {
  useSyncDocDetail(docId);
  const detail = useInboxStore((s) => s.docDetails[docId]) as any;
  const listItem = useInboxStore((s) => s.docs[docId]) as any;
  const doc = detail || listItem;
  if (!doc) return <div className="h-40 rounded-xl animate-pulse" style={{ background: "color-mix(in srgb, var(--sol-border) 14%, transparent)" }} aria-busy />;
  return (
    <div className="rounded-xl border overflow-hidden min-h-[420px] flex flex-col" style={{ borderColor: "color-mix(in srgb, var(--sol-border) 30%, transparent)", background: "var(--sol-card)" }}>
      <DocumentDetailLayout
        docId={doc._id}
        title={doc.display_title ?? doc.title}
        markdownContent={listItem?.content || doc.content || ""}
        editable={editable}
        defaultEditing={false}
        embedded
        titleInBody
        backHref={backHref}
        linkedObjectId={doc._id}
        ownerConversationId={doc.conversation_id}
        cliEditedAt={doc.cli_edited_at}
        contentReady={!!detail}
      />
    </div>
  );
}

function Fact({ label, value, sub, tone }: { label: string; value: React.ReactNode; sub?: string; tone?: string }) {
  return (
    <div className="rounded-xl px-3 py-2.5 border" style={{ borderColor: "color-mix(in srgb, var(--sol-border) 28%, transparent)", background: "var(--sol-card)" }}>
      <div className="text-[10.5px] uppercase tracking-[0.08em] font-semibold" style={{ color: "var(--sol-text-dim)" }}>{label}</div>
      <div className="mt-0.5 text-[18px] font-semibold tabular-nums leading-tight" style={{ color: tone ?? "var(--sol-text)", fontFamily: "var(--font-serif)" }}>{value}</div>
      {sub && <div className="text-[10.5px] mt-0.5 truncate" style={{ color: "var(--sol-text-dim)" }}>{sub}</div>}
    </div>
  );
}

const fmtTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

export function BriefFactsBlock({ facts, roleHandle }: { facts: BriefFacts; roleHandle: string }) {
  const u = facts.usage;
  const now = useCoarseNow(30_000);
  const openLinked = useOpenLinkedSession();
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Fact label="Open tasks" value={facts.tasks.open} sub={`${facts.tasks.total} total · ${facts.tasks.by_status.in_progress ?? 0} in progress`} />
        <Fact label="Plans" value={facts.plans.length} sub={facts.plans.filter((p) => p.status === "active").length + " active"} />
        <Fact label="Decisions" value={facts.decisions.open} sub={`${facts.decisions.answered_today} answered today`} tone={facts.decisions.open > 0 ? "var(--sol-yellow)" : undefined} />
        <Fact label="Today" value={`${u.wakes}/${u.caps.wakes_per_day}`} sub={`wakes · ${u.hands}/${u.caps.hands_per_day} sessions started · ${fmtTokens(u.tokens)}/${fmtTokens(u.caps.tokens_per_day)} tokens${u.uncounted_sessions ? ` · ${u.uncounted_sessions} uncounted` : ""}`} />
      </div>
      {facts.hands.length > 0 && (
        <section>
          <h3 className="px-1 mb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.08em]" style={{ color: "var(--sol-text-dim)" }}>Sessions say</h3>
          <ul className="space-y-1">
            {facts.hands.map((h) => (
              <li key={h._id}>
                <button type="button" onClick={() => openLinked({ _id: h._id, short_id: h.short_id, title: h.title })} className="w-full text-left flex items-start gap-2.5 px-2.5 py-2 rounded-xl hover:bg-sol-bg-highlight/70">
                  <span className="w-[3px] self-stretch rounded-full shrink-0" style={{ background: h.state === "needs_input" ? "var(--sol-yellow)" : h.state === "working" ? "var(--sol-green)" : h.state === "done" ? "var(--sol-cyan)" : h.state === "dormant" ? "var(--sol-blue)" : "var(--sol-text-dim)" }} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px] font-medium" style={{ color: "var(--sol-text)" }}>{h.title || "Untitled"}</span>
                    <span className="block truncate text-[11px]" style={{ color: "var(--sol-text-muted)" }}>{h.state_line ?? "no state pinned"}</span>
                    {h.task && <span className="block truncate text-[10.5px] mt-[1px]" style={{ color: "var(--sol-text-dim)", fontFamily: "var(--font-mono)" }}>{h.task.short_id} · {h.task.status}{h.task.review_verdict ? ` · ${h.task.review_verdict}` : ""}</span>}
                  </span>
                  <span className="text-[10.5px] tabular-nums shrink-0" style={{ color: "var(--sol-text-dim)" }}>{compactAge(now - h.updated_at)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {/* The people who report to the role (R6): each one's goals from the
          narrative below, read against the live rows. */}
      {(facts.people ?? []).map((person) => (
        <section key={person.user_id} data-brief-person={person.user_id}>
          <h3 className="px-1 mb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.08em]" style={{ color: "var(--sol-text-dim)" }}>Goals: {person.name}</h3>
          <PersonGoals person={person} roleHandle={roleHandle} now={now} own={false} />
        </section>
      ))}
      {facts.changed.length > 0 && (
        <section>
          <h3 className="px-1 mb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.08em]" style={{ color: "var(--sol-text-dim)" }}>Moved lately</h3>
          <ul className="grid sm:grid-cols-2 gap-x-4">
            {facts.changed.slice(0, 12).map((c, i) => (
              <li key={`${c.kind}:${c.short_id ?? i}`} className="flex items-center gap-2 px-1 py-1 text-[12px] min-w-0">
                {c.kind === "task" ? <CheckSquare className="w-3.5 h-3.5 shrink-0" style={{ color: "var(--sol-cyan)" }} /> : <Layers className="w-3.5 h-3.5 shrink-0" style={{ color: "var(--sol-magenta)" }} />}
                <Link href={c.kind === "task" ? `/tasks/${c.short_id}` : `/plans/${c.short_id}`} className="truncate hover:underline" style={{ color: "var(--sol-text)" }}>{c.title}</Link>
                <span className="text-[10.5px] shrink-0" style={{ color: "var(--sol-text-dim)" }}>{c.status.replace(/_/g, " ")} · {compactAge(now - c.updated_at)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

export function ScopeBriefTab({ role, facts, factsProblem, narrative, canEdit, backHref }: { role: OrgRole; facts: BriefFacts | null; factsProblem: string | null; narrative: string; canEdit: boolean; backHref: string }) {
  return (
    <div className="space-y-5">
      {facts ? <BriefFactsBlock facts={facts} roleHandle={role.handle} /> : (
        <p className="px-1 text-[12px]" style={{ color: "var(--sol-text-dim)" }}>{factsProblem ?? "Facts load when the connection returns."}</p>
      )}
      <section>
        <h3 className="px-1 mb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.08em]" style={{ color: "var(--sol-text-dim)" }}>Narrative · the role's own words</h3>
        {role.brief_doc_id ? (
          <RoleDoc docId={role.brief_doc_id} editable={canEdit} backHref={backHref} />
        ) : narrative ? (
          <div className="rounded-xl border px-4 py-3" style={{ borderColor: "color-mix(in srgb, var(--sol-border) 30%, transparent)", background: "var(--sol-card)" }}><MarkdownRenderer content={narrative} /></div>
        ) : (
          <Empty title="No brief yet." hint="The role writes its brief with cast brief edit at the end of a turn that changed its understanding. Provision a standing session first." />
        )}
      </section>
    </div>
  );
}

export function ScopeCharterTab({ role, charter, canEdit, backHref, onUpdateCharter }: { role: OrgRole; charter: string; canEdit: boolean; backHref: string; onUpdateCharter: (v: string) => void }) {
  if (role.charter_doc_id) return <RoleDoc docId={role.charter_doc_id} editable={canEdit} backHref={backHref} />;
  return (
    <div className="rounded-xl border px-4 py-3" style={{ borderColor: "color-mix(in srgb, var(--sol-border) 30%, transparent)", background: "var(--sol-card)" }}>
      <p className="text-[11.5px] mb-2" style={{ color: "var(--sol-text-dim)" }}>The charter is the humans' statement of what this seat owns. It becomes a document when the role's standing session is provisioned.</p>
      <InlineEdit canEdit={canEdit} multiline value={charter} placeholder="What this seat owns, in a sentence or two." onSave={onUpdateCharter} className={cn("text-[13px] leading-relaxed")} style={{ color: "var(--sol-text-secondary)" }} />
    </div>
  );
}
