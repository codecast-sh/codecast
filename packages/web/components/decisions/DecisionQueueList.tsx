"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { useMutation } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { toast } from "sonner";
import { ChevronDown, ChevronRight, Layers, ShieldCheck, Undo2, Terminal, ListChecks } from "lucide-react";
import { useInboxStore, useTrackedStore, getProjectName, type SessionDecisionItem, type HandledDecisionItem } from "../../store/inboxStore";
import { useCollectionRows } from "../../hooks/useCollectionRows";
import { useDecisionQueue } from "../../hooks/useDecisionQueue";
import { useSyncDecisionStacks } from "../../hooks/useSyncDecisionStacks";
import { useSyncHandledDecisions } from "../../hooks/useSyncHandledDecisions";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { formatTimeAgo } from "../../lib/messageNavigator";
import { groupDecisions, type DecisionGroup } from "../../lib/decisionGroups";
import { DecisionCompactCard } from "./DecisionCompactCard";
import { decisionHref } from "../../lib/decisionLinks";
import { StackChecklist } from "./StackChecklist";

const api = _api as any;

const pendingWhere = (d: SessionDecisionItem) => d.status === "pending";
const pendingSig = (d: SessionDecisionItem) => `${d.created_at}:${d.updated_at ?? 0}:${d.stack_id ?? ""}:${d.holder_key ?? ""}:${d.task_id ?? ""}`;
const handledSig = (d: HandledDecisionItem) => `${d.status}:${d.resolved_at ?? 0}`;

// The queue (D5): every pending decision the viewer holds, grouped by stack,
// then by scope, with the rows a lead holds under a grant folded away, then
// "Handled without you". Compact cards; each links to its document page.
// Sessions parked on a terminal question (an AskUserQuestion, a permission
// prompt) have no authored row and keep the one-at-a-time stepper.
export function DecisionQueueList() {
  useSyncDecisionStacks();
  useSyncHandledDecisions();
  const pending = useCollectionRows<SessionDecisionItem>("sessionDecisions", { where: pendingWhere, sig: pendingSig });
  const stacks = useInboxStore((s) => s.decisionStacks);
  const handled = useCollectionRows<HandledDecisionItem>("handledDecisions", { sig: handledSig, sort: (a, b) => (b.resolved_at ?? 0) - (a.resolved_at ?? 0) });
  const groups = useMemo(() => groupDecisions(pending, stacks), [pending, stacks]);
  const terminal = useDecisionQueue().filter((i) => i.source !== "decide");

  // Stack creation from selected cards: tick, name, group.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selecting, setSelecting] = useState(false);
  const toggle = useCallback((id: string) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; }), []);
  const createStack = useMutation(api.decisionStacks.createStack);
  const addToStack = useMutation(api.decisionStacks.addToStack);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const groupIntoStack = useCallback(async () => {
    if (!title.trim() || selected.size === 0) return;
    setBusy(true);
    try {
      const r = await createStack({ title: title.trim() });
      if (r?.error) { toast.error(r.error); return; }
      for (const id of selected) {
        const a = await addToStack({ stack: r.id, decision: id });
        if (a?.error) toast.error(a.error);
      }
      toast.success(`Stacked ${selected.size} into ${r.short_id ?? "a stack"}`);
      setSelected(new Set()); setSelecting(false); setTitle("");
    } catch (e: any) {
      toast.error(e?.message ?? "Could not create the stack");
    } finally {
      setBusy(false);
    }
  }, [title, selected, createStack, addToStack]);

  const empty = groups.length === 0 && terminal.length === 0;

  return (
    <div className="h-full overflow-y-auto" data-main-scroll>
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6">
        <div className="flex items-center gap-3 flex-wrap mb-5">
          <h1 className="text-lg text-sol-text">Questions</h1>
          <span className="text-[12px] text-sol-text-dim">{pending.length} waiting on you{terminal.length ? ` · ${terminal.length} in a terminal` : ""}</span>
          <div className="ml-auto flex items-center gap-2 text-[11px]">
            {pending.length > 0 && (
              <Link href="/questions?mode=step" className="flex items-center gap-1.5 px-2 py-1 rounded border border-sol-border text-sol-text-muted hover:text-sol-text transition-colors">
                <ListChecks className="w-3.5 h-3.5" />one at a time
              </Link>
            )}
            {pending.length > 1 && (
              <button onClick={() => { setSelecting((v) => !v); setSelected(new Set()); }} className={`flex items-center gap-1.5 px-2 py-1 rounded border transition-colors ${selecting ? "border-sol-violet text-sol-violet" : "border-sol-border text-sol-text-muted hover:text-sol-text"}`}>
                <Layers className="w-3.5 h-3.5" />{selecting ? "cancel" : "group into a stack"}
              </button>
            )}
          </div>
        </div>

        {selecting && (
          <div className="mb-4 flex items-center gap-2 flex-wrap rounded-lg border border-sol-violet/40 bg-sol-violet/5 px-3 py-2 text-[12px]">
            <span className="text-sol-text-muted">{selected.size} selected</span>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Stack title, e.g. Launch checklist"
              className="flex-1 min-w-[10rem] bg-sol-card border border-sol-border rounded px-2 py-1 text-sm text-sol-text placeholder:text-sol-text-dim focus:outline-none focus:border-sol-violet/50"
              onKeyDown={(e) => { if (e.key === "Enter") void groupIntoStack(); }}
            />
            <button onClick={groupIntoStack} disabled={busy || !title.trim() || selected.size === 0} className="px-2.5 py-1 rounded border border-sol-violet/50 text-sol-violet hover:bg-sol-violet hover:text-sol-bg transition-colors disabled:opacity-40">
              create the stack
            </button>
          </div>
        )}

        {empty && (
          <div className="flex flex-col items-center justify-center py-24 gap-3 text-center">
            <div className="text-2xl text-sol-text">Nothing needs you.</div>
            <div className="text-sm text-sol-text-muted max-w-md">Your agents are working. New decisions appear here the moment an agent asks.</div>
          </div>
        )}

        <div className="space-y-7">
          {groups.map((g) => (
            <QueueGroup key={g.key} group={g} selecting={selecting} selected={selected} onToggle={toggle} />
          ))}

          {terminal.length > 0 && (
            <section>
              <GroupHeader icon={<Terminal className="w-3.5 h-3.5" />} title="Waiting in a terminal" count={terminal.length} hint="answered in the session" />
              <ul className="space-y-1.5">
                {terminal.map((item) => (
                  <li key={item.key}>
                    <Link href={`/questions?s=${item.conversationId}`} className="flex items-center gap-2 rounded-lg border border-sol-border/70 hover:border-sol-border bg-sol-card/40 px-4 py-2.5 text-sm">
                      <span className="w-1.5 h-1.5 rounded-full bg-sol-yellow animate-pulse shrink-0" />
                      <span className="text-sol-text truncate">{item.session?.title || "Session"}</span>
                      {item.session?.project_path && <span className="text-[11px] text-sol-text-dim truncate">{getProjectName(item.session.project_path)}</span>}
                      <span className="ml-auto text-[11px] text-sol-text-dim shrink-0">{item.source === "permission" ? "permission prompt" : "a question"}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {handled.length > 0 && <HandledSection rows={handled} />}
        </div>
      </div>
    </div>
  );
}

function GroupHeader({ icon, title, count, hint, right, onToggle, open }: { icon: React.ReactNode; title: React.ReactNode; count: number; hint?: string; right?: React.ReactNode; onToggle?: () => void; open?: boolean }) {
  const inner = (
    <>
      {onToggle && (open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />)}
      <span className="text-sol-text-dim">{icon}</span>
      <span className="text-sol-text">{title}</span>
      <span className="text-sol-text-dim">{count}</span>
      {hint && <span className="text-sol-text-dim hidden sm:inline">· {hint}</span>}
    </>
  );
  return (
    <div className="flex items-center gap-2 text-[12px] mb-2 min-w-0">
      {onToggle ? <button onClick={onToggle} className="flex items-center gap-2 min-w-0 hover:text-sol-text">{inner}</button> : <div className="flex items-center gap-2 min-w-0">{inner}</div>}
      {right && <div className="ml-auto">{right}</div>}
    </div>
  );
}

function ScopeLabel({ scopeKey }: { scopeKey: string }) {
  const [kind, id] = scopeKey.split(":");
  const st = useTrackedStore([
    (s) => kind === "project" ? (s.projects as any)?.[id]?.title : kind === "plan" ? (s.plans as any)?.[id]?.title : kind === "session" ? s.sessions[id]?.title : undefined,
  ]);
  const name: string | undefined = kind === "project" ? (st.projects as any)?.[id]?.title : kind === "plan" ? (st.plans as any)?.[id]?.title : kind === "session" ? st.sessions[id]?.title : undefined;
  if (kind === "role") return <><RoleName roleId={id} />'s scope</>;
  if (kind === "session") return <>{name || "a session"}</>;
  return <>{kind} · {name || id.slice(0, 8)}</>;
}

// A role's name, for the "with a lead" fold. Enrichment: the row carries
// only the role id, and a missing brief degrades to "a lead".
function RoleName({ roleId }: { roleId: string }) {
  const { data } = useQueryNoThrow(api.org.brief, { role_id: roleId });
  return <>{data?.role?.name ?? "a lead"}</>;
}

function QueueGroup({ group, selecting, selected, onToggle }: { group: DecisionGroup; selecting: boolean; selected: Set<string>; onToggle: (id: string) => void }) {
  const [open, setOpen] = useState(group.kind !== "role");
  if (group.kind === "stack") {
    return (
      <section>
        <GroupHeader
          icon={<Layers className="w-3.5 h-3.5 text-sol-cyan" />}
          title={<Link href={`/decisions/stacks/${group.stack.short_id ?? group.stack._id}`} className="hover:text-sol-cyan">{group.stack.title}</Link>}
          count={group.stack.pending}
          hint={group.stack.policy.auto_default_after_ms ? `defaults apply after ${Math.round(group.stack.policy.auto_default_after_ms / 3_600_000)}h` : group.stack.policy.delegate_role_id ? "delegated to a role" : "a stack"}
          right={<span className="font-mono text-[11px] text-sol-text-dim">{group.stack.short_id}</span>}
        />
        <StackChecklist stack={group.stack} />
      </section>
    );
  }
  if (group.kind === "role") {
    return (
      <section>
        <GroupHeader
          icon={<ShieldCheck className="w-3.5 h-3.5 text-sol-green" />}
          title={<>With a lead · <RoleName roleId={group.roleId} /></>}
          count={group.items.length}
          hint="a role holds these under a grant; a person's answer still wins"
          onToggle={() => setOpen((v) => !v)}
          open={open}
        />
        {open && <div className="space-y-2">{group.items.map((d) => <DecisionCompactCard key={d._id} decision={d} selected={selected.has(d._id)} onToggleSelect={selecting ? () => onToggle(d._id) : undefined} />)}</div>}
      </section>
    );
  }
  return (
    <section>
      <GroupHeader icon={<span className="w-1.5 h-1.5 rounded-full bg-sol-yellow inline-block" />} title={<ScopeLabel scopeKey={group.scopeKey} />} count={group.items.length} />
      <div className="space-y-2">
        {group.items.map((d) => <DecisionCompactCard key={d._id} decision={d} selected={selected.has(d._id)} onToggleSelect={selecting ? () => onToggle(d._id) : undefined} />)}
      </div>
    </section>
  );
}

// "Handled without you" (D2): a role answered these under a grant. Disagree
// and reopen puts the row back in the queue held by the people; a second
// override in a row revokes the grant (scored server side).
function HandledSection({ rows }: { rows: HandledDecisionItem[] }) {
  const [open, setOpen] = useState(true);
  const reopen = useMutation(api.sessionDecisions.reopen);
  const now = useCoarseNow(60_000);
  const onReopen = useCallback(async (id: string) => {
    try {
      const r = await reopen({ decision_id: id });
      if (r?.reopened) toast.success("Reopened — it is back in your queue.");
      else toast.error(r?.reason ?? "Could not reopen");
    } catch (e: any) {
      toast.error(e?.message ?? "Could not reopen");
    }
  }, [reopen]);
  return (
    <section>
      <GroupHeader icon={<ShieldCheck className="w-3.5 h-3.5 text-sol-green" />} title="Handled without you" count={rows.length} hint="a role answered under a grant" onToggle={() => setOpen((v) => !v)} open={open} />
      {open && (
        <ul className="space-y-1.5">
          {rows.map((d) => {
            const answer = d.answer_text ?? (d.answer_index !== undefined ? d.options[d.answer_index]?.label : undefined);
            return (
              <li key={d._id} className="rounded-lg border border-sol-border/60 bg-sol-card/30 px-4 py-2.5">
                <div className="flex items-center gap-2 flex-wrap text-[11px] text-sol-text-dim">
                  <span className="text-sol-green">{d.role?.name ?? "a role"}</span>
                  <span>answered {d.resolved_at ? formatTimeAgo(d.resolved_at, now) : ""}</span>
                  {d.category && <span className="px-1.5 py-0.5 rounded border border-sol-border">{d.category}</span>}
                  {d.grant?.revoked_at && <span className="text-sol-red">grant revoked</span>}
                  <Link href={decisionHref(d)} className="ml-auto font-mono hover:text-sol-text">{d.short_id ?? "open"}</Link>
                </div>
                <Link href={decisionHref(d)} className="block mt-1 text-sm text-sol-text hover:text-sol-blue">{d.question}</Link>
                <div className="mt-1 flex items-center gap-3 flex-wrap text-[12px]">
                  <span className="text-sol-text-muted">→ {answer}</span>
                  {d.status === "answered" && d.answered_by?.kind === "role" && (
                    <button onClick={() => onReopen(d._id)} className="inline-flex items-center gap-1 text-sol-orange hover:underline">
                      <Undo2 className="w-3 h-3" />disagree and reopen
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
