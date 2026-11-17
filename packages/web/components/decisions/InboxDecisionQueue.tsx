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
}: {
  collapsed: boolean;
  onToggle: () => void;
  activeSessionId?: string | null;
  /** Sessions the inbox files as asking that hold nothing in the viewer's queue. */
  extraSessions: InboxSession[];
  onSelectSession: (session: InboxSession, e?: React.MouseEvent) => void;
}) {
  const queue = useDecisionQueue();
  const cursor = useDecisionQueueCursor();
  const meId = useInboxStore((s) => s.currentUser?._id as string | undefined);
  const advisoryRows = useCollectionRows<SessionDecisionItem>("sessionDecisions", { where: advisoryWhere, sig: advisorySig });
  const advisory = useMemo(() => advisoryRows.filter((d) => askedOfViewer(d, meId)).length, [advisoryRows, meId]);

  const groups = useMemo(() => {
    const byConv = new Map<string, Group>();
    queue.forEach((item, i) => {
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
      g.asks.push({ item, n: i + 1 });
    });
    return [...byConv.values()];
  }, [queue]);
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
    {!collapsed && <div className="px-2 pb-2 pt-1 space-y-0.5" data-inbox-decision-queue>
      {shown.map((g) => {
        const lit = isLit(g);
        return (
          <div
            key={g.conversationId}
            data-session-id={g.conversationId}
            className={`rounded-lg border px-2.5 py-1.5 transition-colors ${lit ? "border-sol-yellow/60 bg-sol-yellow/[0.06]" : "border-transparent hover:bg-sol-bg-alt"}`}
          >
            <Link href={stepHref(g.conversationId)} className="flex items-baseline gap-2 min-w-0 no-underline">
              <span className="truncate text-sm text-sol-text">{g.title}</span>
              {g.project && <span className="shrink-0 text-meta text-sol-text-dim">{g.project}</span>}
            </Link>
            {g.asks.map(({ item, n }) => {
              const here = cursor ? item.key === cursor : lit && n === g.asks[0].n;
              return (
                <Link
                  key={item.key}
                  href={stepHref(g.conversationId, item.key)}
                  data-decision-queue-row={n}
                  className={`flex items-baseline gap-2 min-w-0 py-0.5 text-[12.5px] no-underline ${here ? "text-sol-text" : "text-sol-text-muted hover:text-sol-text"}`}
                >
                  <span className={`w-5 shrink-0 text-right tabular-nums font-mono text-mark ${here ? "text-sol-yellow" : "text-sol-text-dim"}`}>{n}</span>
                  <span className="truncate">{item.source === "permission" ? `Permission: ${item.question}` : item.question}</span>
                  {item.heldByRole && <span className="shrink-0 text-meta text-sol-text-dim">lead</span>}
                </Link>
              );
            })}
          </div>
        );
      })}
      {hidden > 0 && (
        <Link
          href="/decisions?mode=step"
          data-decision-queue-more={hidden}
          className="flex items-center justify-between rounded-lg px-2.5 py-1.5 text-[12px] text-sol-text-muted hover:text-sol-text hover:bg-sol-bg-alt no-underline"
        >
          <span>{hidden} more</span>
          <ChevronRight className="w-3 h-3" />
        </Link>
      )}
      {extras.map((session) => (
        <button
          key={session._id}
          data-session-id={session._id}
          onClick={(e) => onSelectSession(session, e)}
          className={`w-full text-left rounded-lg border px-2.5 py-1.5 flex items-baseline gap-2 min-w-0 transition-colors ${session._id === activeSessionId ? "border-sol-yellow/60 bg-sol-yellow/[0.06]" : "border-transparent hover:bg-sol-bg-alt"}`}
        >
          <span className="truncate text-sm text-sol-text">{session.title || "Session"}</span>
          {session.project_path && <span className="shrink-0 text-meta text-sol-text-dim">{getProjectName(session.project_path)}</span>}
        </button>
      ))}
      {advisory > 0 && (
        <Link
          href="/decisions?tab=mine&blocking=advisory"
          data-decision-advisory={advisory}
          className="mt-1 flex items-center justify-between rounded-lg border border-dashed border-sol-border/60 px-2.5 py-1.5 text-[12px] text-sol-text-dim hover:text-sol-text no-underline"
        >
          <span>Agents went ahead without you</span>
          <span className="flex items-center gap-0.5 font-mono text-mark tabular-nums">{advisory}<ChevronRight className="w-3 h-3" /></span>
        </Link>
      )}
    </div>}
    </div>
  );
}
