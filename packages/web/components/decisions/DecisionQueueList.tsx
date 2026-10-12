"use client";

import { useAssistantConversationIds, useAssistantScope, useModeWords, useSurface } from "../../lib/surfaces";
import { HOSTED_PAGE_FRAME, HOSTED_PAGE_PAD, HOSTED_PAGE_TOP } from "../../lib/hostedPage";
import { AssistantScopeSwitch, MoreInEverything } from "../AssistantScopeSwitch";
import { PageHeading } from "../PageHeading";
import { useCallback, useMemo, useState } from "react";
import { ShortId } from "../ShortId";
import Link from "next/link";
import { toast } from "sonner";
import { decisionAnswerLabel } from "@codecast/shared/contracts";
import { ChevronDown, ChevronRight, Layers, ShieldCheck, Undo2, Terminal, ListChecks } from "lucide-react";
import { useInboxStore, useTrackedStore, getProjectName, type SessionDecisionItem, type HandledDecisionItem } from "../../store/inboxStore";
import { useCollectionRows } from "../../hooks/useCollectionRows";
import { useDecisionQueue, useScopedDecisionQueue } from "../../hooks/useDecisionQueue";
import { useSyncDecisionStacks } from "../../hooks/useSyncDecisionStacks";
import { useSyncHandledDecisions } from "../../hooks/useSyncHandledDecisions";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { formatTimeAgo } from "../../lib/messageNavigator";
import { groupDecisions, stackDue, type DecisionGroup } from "../../lib/decisionGroups";
import { DecisionCompactCard } from "./DecisionCompactCard";
import { decisionHref } from "../../lib/decisionLinks";
import { answeredLabel, answeredLine, answerSaid, isStackedAsk, questionAsStatement } from "../../lib/decisionQueue";
import { useWaitingOnPerson } from "../../hooks/useNeedsInputCount";
import { sessionCardTitle } from "../../lib/sessionCard";
import { StackChecklist } from "./StackChecklist";
import { QueueEmpty, type LastClosed } from "./QueueEmpty";
import { cardOutcome, settledAgo } from "./ChangeCardView";

import { api as _api } from "@codecast/convex/convex/_generated/api";
import { FeatureUpsell } from "../agentFeatures/FeatureUpsell";
const api = _api as any;

const pendingWhere = isStackedAsk;
const pendingSig = (d: SessionDecisionItem) => `${d.blocking}:${d.created_at}:${d.updated_at ?? 0}:${d.stack_id ?? ""}:${d.holder_key ?? ""}:${d.task_id ?? ""}`;
const handledSig = (d: HandledDecisionItem) => `${d.status}:${d.resolved_at ?? 0}`;
const answeredWhere = (d: SessionDecisionItem) => d.status === "answered" && !!d.resolved_at;
const answeredSig = (d: SessionDecisionItem) => `${d.resolved_at ?? 0}:${d.answer_index ?? ""}`;

// The queue (D5): every pending decision the viewer holds, grouped by stack,
// then by scope, with the rows a lead holds under a grant folded away, then
// "Handled without you". Compact cards; each links to its document page.
// Sessions parked on a terminal question (an AskUserQuestion, a permission
// prompt) have no authored row and keep the one-at-a-time stepper.
export function DecisionQueueList() {
  // The same argument set the stacks index and the stack page use: the feed
  // is a snapshot, so two feeders that disagree on include_done would drop
  // and restore each other's done rows while both are mounted. Done stacks
  // in the store cost the queue nothing: a group renders only for a stack
  // with pending members.
  useSyncDecisionStacks({ includeDone: true });
  useSyncHandledDecisions();
  // Hosted mode's Assistant scope (lib/assistantScope) lists the assistant's
  // asks alone, as the rail count does (useScopedDecisionQueue); what it
  // leaves out is one line at the foot.
  const scope = useAssistantScope();
  const assistantIds = useAssistantConversationIds();
  const inScope = useCallback((conversationId: string) => !scope.only || assistantIds.has(conversationId), [scope.only, assistantIds]);
  const pendingAll = useCollectionRows<SessionDecisionItem>("sessionDecisions", { where: pendingWhere, sig: pendingSig });
  const pending = useMemo(() => pendingAll.filter((d) => inScope(d.conversation_id)), [pendingAll, inScope]);
  const stacks = useInboxStore((s) => s.decisionStacks);
  const handledAll = useCollectionRows<HandledDecisionItem>("handledDecisions", { sig: handledSig, sort: (a, b) => (b.resolved_at ?? 0) - (a.resolved_at ?? 0) });
  const handled = useMemo(() => handledAll.filter((d) => inScope(d.conversation_id)), [handledAll, inScope]);
  // Overdue stacks sort first (the-line.md L10), so the grouping follows the
  // clock: a coarse tick re-sorts when a due passes.
  const now = useCoarseNow(60_000);
  const groups = useMemo(() => groupDecisions(pending, stacks, now), [pending, stacks, now]);
  const terminal = useScopedDecisionQueue().filter((i) => i.source !== "decide");
  const terminalAll = useDecisionQueue().filter((i) => i.source !== "decide").length;
  const outOfScope = pendingAll.length - pending.length + terminalAll - terminal.length;

  // Stack creation from selected cards: tick, name, group.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selecting, setSelecting] = useState(false);
  const toggle = useCallback((id: string) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; }), []);
  // One store action: a stub stack row keyed by client_key paints at once
  // with the members moved under it; the createStackWith side effect makes
  // the server row, which supersedes the stub through the feed's altKey.
  const createStackWith = useInboxStore((s) => s.createStackWith);
  const activeTeamId = useInboxStore((s) => s.clientState.ui?.active_team_id as string | undefined);
  const [title, setTitle] = useState("");
  const groupIntoStack = useCallback(() => {
    if (!title.trim() || selected.size === 0) return;
    const client_key = `ds_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    createStackWith({ title: title.trim(), decision_ids: [...selected], team_id: activeTeamId, client_key });
    toast.success(`Stacked ${selected.size}`);
    setSelected(new Set()); setSelecting(false); setTitle("");
  }, [title, selected, createStackWith, activeTeamId]);

  const empty = groups.length === 0 && terminal.length === 0;
  // The last answer on record, for the empty state: a card says what
  // happened to its change (cardOutcome), any other decision that it was answered.
  const answered = useCollectionRows<SessionDecisionItem>("sessionDecisions", { where: answeredWhere, sig: answeredSig });
  const last = useMemo<LastClosed | null>(() => {
    const d = answered.reduce<SessionDecisionItem | null>((m, x) => (inScope(x.conversation_id) && (x.resolved_at ?? 0) > (m?.resolved_at ?? 0) ? x : m), null);
    if (!d) return null;
    const outcome = d.card ? cardOutcome(d, "you", now) : null;
    if (outcome) return { verdict: outcome.verdict, title: d.card!.change, ago: settledAgo(d.resolved_at, now), href: decisionHref(d) };
    // Lead with what was answered, so "did I just let it do something?" is
    // read off the line: 'You said no to the routine "Take vitamins"'.
    const label = answeredLabel(d);
    return label
      ? { verdict: answerSaid(label), title: questionAsStatement(d.question), line: answeredLine(label, d.question), ago: settledAgo(d.resolved_at, now), href: decisionHref(d) }
      : { verdict: "Answered", title: d.question, ago: settledAgo(d.resolved_at, now), href: decisionHref(d) };
  }, [answered, now, inScope]);
  // "Waiting on you" counts what a person must answer. Rows a lead holds
  // under a grant stay pending in the inbox (a person may still answer first)
  // but they are the lead's to clear, so they count on their own group header.
  const mine = pending.filter((d) => d.holder?.kind !== "role").length;
  const withLead = pending.length - mine;
  // Exactly one surface claims the digit keys: the group on top (a lead's
  // fold only when nothing else is waiting), and inside it its first row, so
  // the KeyCaps show on the row the digits answer.
  const keysGroup = (groups.find((g) => g.kind !== "role") ?? groups[0])?.key;
  // Hosted mode calls this page Approvals and leaves the queue's machinery
  // (stacks, stepping, grouping) to developer mode.
  const words = useModeWords();
  const internals = useSurface("questions.internals");

  return (
    <div className="h-full overflow-y-auto" data-main-scroll>
      <div className={`${HOSTED_PAGE_FRAME} ${HOSTED_PAGE_PAD} ${HOSTED_PAGE_TOP} pb-6`}>
        <div className="flex items-center gap-x-3 gap-y-2 flex-wrap mb-5">
          <PageHeading title={words.questionsPage} />
          {/* Under the title on a phone, beside it from sm up. */}
          <div className="order-last basis-full sm:order-none sm:basis-auto empty:hidden">
            <AssistantScopeSwitch label="Which approvals this lists" hidden={outOfScope} />
          </div>
          {/* A count of nothing says what the empty state below says better. */}
          {(mine > 0 || withLead > 0 || terminal.length > 0) && <span className="text-[12px] text-sol-text-dim">{mine} waiting on you{withLead ? ` · ${withLead} with a lead` : ""}{terminal.length ? ` · ${terminal.length} in a terminal` : ""}</span>}
          {internals && <div className="ml-auto flex items-center gap-2 text-[11px]">
            <Link href="/decisions/stacks" className="flex items-center gap-1.5 px-2 py-1 rounded border border-sol-border text-sol-text-muted hover:text-sol-text transition-colors" title="Every stack: open and done, progress, due">
              <Layers className="w-3.5 h-3.5" />stacks
            </Link>
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
          </div>}
        </div>

        <FeatureUpsell
          slug="decide"
          className="mb-5"
          reason="Agents can bring their judgment calls here as one clear question with options, and keep working while you decide."
        />

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
            <button onClick={groupIntoStack} disabled={!title.trim() || selected.size === 0} className="px-2.5 py-1 rounded border border-sol-violet/50 text-sol-violet hover:bg-sol-violet hover:text-sol-bg transition-colors disabled:opacity-40">
              create the stack
            </button>
          </div>
        )}

        {empty && (
          <QueueEmpty last={last} title={words.queueEmptyTitle} lede={words.queueEmptyLede} top={!internals}>
            {!internals && <WaitingOnReplyLine />}
            {/* An empty list's overflow belongs under its words, not at the page's foot. */}
            {handled.length === 0 && <MoreInEverything hidden={outOfScope} centered />}
          </QueueEmpty>
        )}

        <div className="space-y-7">
          {groups.map((g) => (
            <QueueGroup key={g.key} group={g} selecting={selecting} selected={selected} onToggle={toggle} keys={internals && g.key === keysGroup} />
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
        {!(empty && handled.length === 0) && <MoreInEverything hidden={outOfScope} />}
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

function ScopeLabel({ scopeKey, sample }: { scopeKey: string; sample?: SessionDecisionItem }) {
  const [kind, id] = scopeKey.split(":");
  // Hosted mode names the group alone, without its kind as a kicker.
  const internals = useSurface("questions.internals");
  const st = useTrackedStore([
    (s) => kind === "project" ? (s.projects as any)?.[id]?.title : kind === "plan" ? (s.plans as any)?.[id]?.title : kind === "session" ? s.sessions[id]?.title : undefined,
  ]);
  const name: string | undefined = kind === "project" ? (st.projects as any)?.[id]?.title : kind === "plan" ? (st.plans as any)?.[id]?.title : kind === "session" ? st.sessions[id]?.title : undefined;
  if (kind === "role") return <><RoleName roleId={id} />'s scope</>;
  // The live session row wins; the decision's snapshot (session_title) covers a
  // device whose sessions collection does not hold the asking conversation.
  if (kind === "session") return <>{name || sample?.session_title || "a session"}</>;
  return internals ? <>{kind} · {name || id.slice(0, 8)}</> : <>{name || kind}</>;
}

// A role's name, for the "with a lead" fold. Enrichment: the row carries
// only the role id, and a missing brief degrades to "a lead".
function RoleName({ roleId }: { roleId: string }) {
  const { data } = useQueryNoThrow(api.org.brief, { role_id: roleId });
  return <>{data?.role?.name ?? "a lead"}</>;
}

function QueueGroup({ group, selecting, selected, onToggle, keys }: { group: DecisionGroup; selecting: boolean; selected: Set<string>; onToggle: (id: string) => void; keys: boolean }) {
  const [open, setOpen] = useState(group.kind !== "role");
  const internals = useSurface("questions.internals");
  const now = useCoarseNow(60_000);
  if (group.kind === "stack") {
    // Due (the-line.md L10) on the header: red once it has passed.
    const due = stackDue(group.stack.policy, now);
    return (
      <section>
        <GroupHeader
          icon={<Layers className="w-3.5 h-3.5 text-sol-cyan" />}
          title={<Link href={`/decisions/stacks/${group.stack.short_id ?? group.stack._id}`} className="hover:text-sol-cyan">{group.stack.title}</Link>}
          count={group.stack.pending}
          hint={group.stack.policy.auto_default_after_ms ? `defaults apply after ${Math.round(group.stack.policy.auto_default_after_ms / 3_600_000)}h` : group.stack.policy.delegate_role_id ? "delegated to a role" : "a stack"}
          right={
            <span className="flex items-center gap-2 text-[11px]">
              {due && <span data-stack-due={due.overdue ? "overdue" : "due"} className={due.overdue ? "text-sol-red" : "text-sol-text-dim"}>{due.text}</span>}
              <ShortId id={group.stack.short_id} className="text-sol-text-dim" />
            </span>
          }
        />
        <StackChecklist stack={group.stack} keys={keys} />
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
        {open && <div className="space-y-2">{group.items.map((d, i) => <DecisionCompactCard key={d._id} decision={d} keys={keys && i === 0} selected={selected.has(d._id)} onToggleSelect={selecting ? () => onToggle(d._id) : undefined} />)}</div>}
      </section>
    );
  }
  // Hosted mode names a group only when it gathers several asks: one card
  // already names its conversation.
  const named = internals || group.items.length > 1;
  return (
    <section>
      {named && <GroupHeader icon={<span className="w-1.5 h-1.5 rounded-full bg-sol-yellow inline-block" />} title={<ScopeLabel scopeKey={group.scopeKey} sample={group.items[0]} />} count={group.items.length} />}
      <div className="space-y-2">
        {group.items.map((d, i) => <DecisionCompactCard key={d._id} decision={d} keys={keys && i === 0} selected={selected.has(d._id)} onToggleSelect={selecting ? () => onToggle(d._id) : undefined} />)}
      </div>
    </section>
  );
}

// "Handled without you" (D2): a role answered these under a grant. Disagree
// and reopen puts the row back in the queue held by the people; a second
// override in a row revokes the grant (scored server side).
function HandledSection({ rows }: { rows: HandledDecisionItem[] }) {
  const [open, setOpen] = useState(true);
  // The store action moves the row back to the queue on the draft; the
  // reopenDecision side effect does the server write.
  const reopenDecision = useInboxStore((s) => s.reopenDecision);
  const now = useCoarseNow(60_000);
  const onReopen = useCallback((id: string) => {
    reopenDecision(id);
    toast.success("Reopened — it is back in your queue.");
  }, [reopenDecision]);
  return (
    <section>
      <GroupHeader icon={<ShieldCheck className="w-3.5 h-3.5 text-sol-green" />} title="Handled without you" count={rows.length} hint="a role answered under a grant" onToggle={() => setOpen((v) => !v)} open={open} />
      {open && (
        <ul className="space-y-1.5">
          {rows.map((d) => {
            const answer = decisionAnswerLabel(d, d);
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

/** Under hosted mode's empty Approvals: a conversation waiting on a reply is
 *  a question, not an approval, so the queue is honestly empty; this line
 *  says where the person's move is, so the home's "Your move" and an empty
 *  Approvals never read as a contradiction. */
function WaitingOnReplyLine() {
  const rows = useWaitingOnPerson();
  const first = rows[0];
  if (!first) return null;
  const open = () => useInboxStore.getState().navigateToSession(first._id);
  const more = rows.length - 1;
  return (
    <button type="button" onClick={open} data-queue-waiting-reply className="max-w-md truncate px-4 text-[12px] text-sol-text-dim transition-colors hover:text-sol-text">
      {`${sessionCardTitle(first)}${more > 0 ? ` and ${more} more` : ""} ${more > 0 ? "are" : "is"} waiting on your answer.`}
    </button>
  );
}
