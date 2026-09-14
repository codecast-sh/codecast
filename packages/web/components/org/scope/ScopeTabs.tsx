"use client";
// The scope page's store-fed tabs (docs/architecture/scopes-and-feed.md F3):
// plans, pages, sessions and decisions in scope, painted from the local store
// and the org tree, plus the brief and charter documents.
import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { CheckSquare, Layers, MessageCircleQuestionMark } from "lucide-react";
import { useWorkspaceCollection } from "../../../hooks/useWorkspaceCollection";
import { useCoarseNow } from "../../../hooks/useCoarseNow";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import { useOrgSessionsUnder } from "../../../hooks/useOrgSessionsUnder";
import type { ScopeRef } from "../../../hooks/useScopeQueries";
import { ScopeFeed } from "./ScopeFeed";
import { useOpenLinkedSession } from "../../../hooks/useOpenLinkedSession";
import { useSyncDocDetail } from "../../../hooks/useSyncDocs";
import { useInboxStore, type DocItem, type PlanItem, type SessionDecisionItem, type TaskItem } from "../../../store/inboxStore";
import { compactAge } from "../../../lib/threadState";
import { cn } from "../../../lib/utils";
import { DocumentDetailLayout } from "../../DocumentDetailLayout";
import { MarkdownRenderer } from "../../tools/MarkdownRenderer";
import { DocRow, SessionRow, InlineEdit } from "../OrgScopePanel";
import { StateBar, StateTally } from "../OrgNodeCards";
import { ORG_TOP_N, sortOrgSessions, type OrgRole, type OrgSession, type OrgTree } from "../orgTypes";
import type { BriefFacts } from "./scopeTypes";
import { inScope, useScopeIds, type ScopeIds } from "../../../hooks/useScopeIds";
import { decisionHref } from "../../../lib/decisionLinks";

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

export function ScopeSessionsTab({ tree, role, scope }: { tree: OrgTree; role: OrgRole | null; scope: ScopeRef | null }) {
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
      {role && <h3 className="px-2.5 mb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.08em]" style={{ color: "var(--sol-text-dim)" }}>Report to this role</h3>}
      {rows.length === 0 ? (
        <Empty title={role ? "No sessions report to this role yet." : "No sessions in the last 30 days."} hint={role ? "A session started with cast spawn from the role, or moved under it on the org page, shows here." : undefined} />
      ) : (
        <ul className="space-y-1">
          {rows.map((s) => <li key={s._id}><SessionRow s={s} now={now} onOpen={() => openLinked({ _id: s._id, short_id: s.short_id, title: s.title, agent_type: s.agent_type })} /></li>)}
        </ul>
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

export function ScopeDecisionsTab({ ids }: { ids: ScopeIds }) {
  const tasks = useWorkspaceCollection<TaskItem>("tasks");
  const decisions = useInboxStore((s) => s.sessionDecisions);
  const now = useCoarseNow(30_000);
  const { open, answered } = useMemo(() => {
    const taskIds = new Set(tasks.filter((t) => inScope(ids, t as any)).map((t) => t._id));
    const rows = (Object.values(decisions) as Array<SessionDecisionItem & { short_id?: string; task_id?: string }>)
      .filter((d) => d.task_id && taskIds.has(d.task_id));
    const open = rows.filter((d) => d.status === "pending").sort((a, b) => b.created_at - a.created_at);
    const answered = rows.filter((d) => d.status !== "pending").sort((a, b) => (b.resolved_at ?? b.created_at) - (a.resolved_at ?? a.created_at));
    return { open, answered };
  }, [tasks, decisions, ids]);
  const taskById = useMemo(() => new Map(tasks.map((t) => [t._id, t])), [tasks]);
  if (open.length === 0 && answered.length === 0) return <Empty title="No decisions on tasks in this scope." hint="A cast decide raised from a session bound to a task in scope shows here, open first." />;
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

export function BriefFactsBlock({ facts }: { facts: BriefFacts }) {
  const u = facts.usage;
  const now = useCoarseNow(30_000);
  const openLinked = useOpenLinkedSession();
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Fact label="Open tasks" value={facts.tasks.open} sub={`${facts.tasks.total} total · ${facts.tasks.by_status.in_progress ?? 0} in progress`} />
        <Fact label="Plans" value={facts.plans.length} sub={facts.plans.filter((p) => p.status === "active").length + " active"} />
        <Fact label="Decisions" value={facts.decisions.open} sub={`${facts.decisions.answered_today} answered today`} tone={facts.decisions.open > 0 ? "var(--sol-yellow)" : undefined} />
        <Fact label="Today" value={`${u.wakes}/${u.caps.wakes_per_day}`} sub={`wakes · ${u.hands}/${u.caps.hands_per_day} hands · ${fmtTokens(u.tokens)}/${fmtTokens(u.caps.tokens_per_day)} tokens${u.uncounted_sessions ? ` · ${u.uncounted_sessions} uncounted` : ""}`} />
      </div>
      {facts.hands.length > 0 && (
        <section>
          <h3 className="px-1 mb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.08em]" style={{ color: "var(--sol-text-dim)" }}>Hands say</h3>
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
      {facts ? <BriefFactsBlock facts={facts} /> : (
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
