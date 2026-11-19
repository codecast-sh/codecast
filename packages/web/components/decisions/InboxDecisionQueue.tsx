"use client";

import { useMemo } from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { getProjectName, type InboxSession, type SessionDecisionItem } from "../../store/inboxStore";
import { useInboxStore } from "../../store/inboxStore";
import { useCollectionRows } from "../../hooks/useCollectionRows";
import { useDecisionQueue } from "../../hooks/useDecisionQueue";
import { useDecisionQueueCursor } from "../../lib/decisionQueueCursor";
import { SectionHeader } from "../inbox/SectionHeader";
import { askedOfViewer, isStackedAsk, type QueueItem } from "../../lib/decisionQueue";
import { WorkspaceTile } from "../identity/WorkspaceTile";
import { ACTIVE_CARD_CLASS } from "../inbox/sessionCardTypes";

// The inbox panel's Decisions section IS the decision queue: one row per
// decision waiting on the viewer, numbered in the order the stepper walks
// them, grouped under the session that asked. Its count, the sidebar's and
// the stepper's "2 of 32" are the same number (useDecisionQueue().length),
// and the row the stepper is on is lit. Advisory asks (the agent already
// went ahead on a default) are not in the queue; they fold into one row.

const advisoryWhere = (d: SessionDecisionItem) => d.status === "pending" && !d.trial && !isStackedAsk(d);
const advisorySig = (d: SessionDecisionItem) => `${d.status}:${d.blocking ? 1 : 0}:${d.stack_id ?? ""}:${d.in_queue === false ? 0 : 1}:${(d.asked_user_ids ?? []).join(",")}`;

// How many decisions the section draws before folding the rest into one row:
// it leads the inbox, so it must leave the sections under it on screen.
const SHOWN_ASKS = 8;

type Group = { conversationId: string; title: string; project?: string; asks: { item: QueueItem; n: number }[]; session?: InboxSession };

const stepHref = (conversationId: string, key?: string) =>
  `/decisions?s=${conversationId}${key ? `&d=${encodeURIComponent(key)}` : ""}`;

export function InboxDecisionQueue({
  collapsed,
  onToggle,
  activeSessionId,
  extraSessions,
  onSelectSession,
  matches,
}: {
  collapsed: boolean;
  onToggle: () => void;
  activeSessionId?: string | null;
  /** Sessions the inbox files as asking that hold nothing in the viewer's queue. */
  extraSessions: InboxSession[];
  onSelectSession: (session: InboxSession, e?: React.MouseEvent) => void;
  /** The inbox's chip filter, by the asking session: under a chip the section
   *  lists only the decisions of sessions that pass it. Each keeps its place
   *  number in the whole queue, the one the stepper walks. */
  matches?: (conversationId: string) => boolean;
}) {
  const fullQueue = useDecisionQueue();
  const numbered = useMemo(() => fullQueue.map((item, i) => ({ item, n: i + 1 })).filter(({ item }) => !matches || matches(item.conversationId)), [fullQueue, matches]);
  const queue = useMemo(() => numbered.map(({ item }) => item), [numbered]);
  const cursor = useDecisionQueueCursor();
  const meId = useInboxStore((s) => s.currentUser?._id as string | undefined);
  const showAgent = useInboxStore((s) => s.clientState.ui?.show_agent_icon !== false);
  const advisoryRows = useCollectionRows<SessionDecisionItem>("sessionDecisions", { where: advisoryWhere, sig: advisorySig });
  const advisory = useMemo(() => advisoryRows.filter((d) => askedOfViewer(d, meId) && (!matches || matches(d.conversation_id))).length, [advisoryRows, meId, matches]);

  const groups = useMemo(() => {
    const byConv = new Map<string, Group>();
    numbered.forEach(({ item, n }) => {
      let g = byConv.get(item.conversationId);
      if (!g) {
        g = {
          conversationId: item.conversationId,
          title: item.session?.title || item.sessionTitle || "Session",
          project: item.session?.project_path ? getProjectName(item.session.project_path) : undefined,
          asks: [],
          session: item.session,
        };
        byConv.set(item.conversationId, g);
      }
      g.asks.push({ item, n });
    });
    return [...byConv.values()];
  }, [numbered]);
  // The first groups up to SHOWN_ASKS decisions, plus the lit one wherever it sits.
  const isLit = (g: Group) => (cursor ? g.asks.some((a) => a.item.key === cursor) : g.conversationId === activeSessionId);
  const shown: Group[] = [];
  let budget = SHOWN_ASKS;
  for (const g of groups) {
    if (budget > 0 || isLit(g)) shown.push(g);
    if (budget > 0) budget -= g.asks.length;
  }
  const hidden = queue.length - shown.reduce((n, g) => n + g.asks.length, 0);
  const covered = useMemo(() => new Set(queue.map((i) => i.conversationId)), [queue]);
  const extras = extraSessions.filter((s) => !covered.has(s._id));

  if (queue.length === 0 && extras.length === 0 && advisory === 0) return null;
  return (
    <div>
    <SectionHeader label="Decisions" count={queue.length} color="text-sol-violet" sectionKey="questions" collapsed={collapsed} onToggle={onToggle} />
    {!collapsed && <div className="pb-2 pt-1" data-inbox-decision-queue>
      {shown.map((g) => {
        const lit = isLit(g);
        return (
          <QueueCard key={g.conversationId} id={g.conversationId} lit={lit} row={g.session} title={g.title} project={g.project} href={stepHref(g.conversationId)} showAgent={showAgent}>
            {g.asks.map(({ item, n }) => {
              const here = cursor ? item.key === cursor : lit && n === g.asks[0].n;
              return (
                <Link
                  key={item.key}
                  href={stepHref(g.conversationId, item.key)}
                  data-decision-queue-row={n}
                  data-here={here ? "true" : undefined}
                  className={`flex items-baseline gap-2 min-w-0 py-0.5 text-ui no-underline ${here ? "text-sol-text font-medium" : "text-sol-text-muted hover:text-sol-text"}`}
                >
                  <span className={`w-5 shrink-0 text-center tabular-nums font-mono text-mark ${here ? "text-sol-cyan" : "text-sol-text-dim"}`}>{n}</span>
                  <span className="truncate">{item.source === "permission" ? `Permission: ${item.question}` : item.question}</span>
                  {item.heldByRole && <span className="shrink-0 text-meta text-sol-text-dim">lead</span>}
                </Link>
              );
            })}
          </QueueCard>
        );
      })}
      {hidden > 0 && (
        <Link
          href="/decisions?mode=step"
          data-decision-queue-more={hidden}
          className="mx-1.5 flex items-center justify-between rounded-lg px-3 py-1.5 text-[12px] text-sol-text-muted hover:text-sol-text hover:bg-sol-bg-alt no-underline"
        >
          <span>{hidden} more</span>
          <ChevronRight className="w-3 h-3" />
        </Link>
      )}
      {extras.map((session) => (
        <QueueCard
          key={session._id}
          id={session._id}
          lit={session._id === activeSessionId}
          row={session}
          title={session.title || "Session"}
          project={session.project_path ? getProjectName(session.project_path) : undefined}
          onSelect={(e) => onSelectSession(session, e)}
          showAgent={showAgent}
        />
      ))}
      {advisory > 0 && (
        <Link
          href="/decisions?tab=mine&blocking=advisory"
          data-decision-advisory={advisory}
          className="mx-1.5 mt-1 flex items-center justify-between rounded-lg border border-dashed border-sol-border/60 px-2.5 py-1.5 text-[12px] text-sol-text-dim hover:text-sol-text no-underline"
        >
          <span>Agents went ahead without you</span>
          <span className="flex items-center gap-0.5 font-mono text-mark tabular-nums">{advisory}<ChevronRight className="w-3 h-3" /></span>
        </Link>
      )}
    </div>}
    </div>
  );
}

// One asking session, drawn the way the rail draws a session card: the same
// frame and ground (data-session-id under the rail, data-mc for Modern), the
// workspace tile leading the title, and the open card's treatment when it is
// the session on screen or holds the decision the stepper is on.
function QueueCard({ id, lit, row, title, project, href, onSelect, showAgent, children }: {
  id: string;
  lit: boolean;
  row?: InboxSession;
  title: string;
  project?: string;
  href?: string;
  onSelect?: (e: React.MouseEvent) => void;
  showAgent: boolean;
  children?: React.ReactNode;
}) {
  const head = (
    <>
      <span className="flex h-5 w-5 shrink-0 items-center justify-center"><WorkspaceTile row={row ?? {}} size={20} showAgent={showAgent} /></span>
      <span className="min-w-0 truncate text-body font-medium text-sol-text">{title}</span>
      {project && <span className="shrink-0 text-meta text-sol-text-dim">{project}</span>}
    </>
  );
  const headClass = "flex w-full min-w-0 items-center gap-2 text-left no-underline";
  return (
    <div
      data-session-id={id}
      data-active={lit ? "true" : undefined}
      data-mc="card"
      className={`relative overflow-hidden py-2 pl-3 pr-3 transition-colors ${lit ? ACTIVE_CARD_CLASS : "hover:bg-sol-bg-alt/80"}`}
    >
      {href
        ? <Link href={href} className={headClass}>{head}</Link>
        : <button type="button" onClick={onSelect} className={headClass}>{head}</button>}
      {children && <div className="mt-1">{children}</div>}
    </div>
  );
}
