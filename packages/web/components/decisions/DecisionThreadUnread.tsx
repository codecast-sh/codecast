"use client";
// A decision's unread comments on its row (convex decisionThread.ts, the
// decision kind's threadInbox row): the count, and on a card a link to the
// thread on the decision's page. Nothing when the viewer has read it all.
import Link from "next/link";
import { MessageSquare } from "lucide-react";
import { useDecisionThreadUnread } from "../../hooks/useDecisionThread";

export function DecisionThreadUnread({ decisionId, href }: { decisionId: string; href?: string }) {
  const unread = useDecisionThreadUnread(decisionId);
  if (unread <= 0) return null;
  const body = <><MessageSquare className="w-3 h-3" aria-hidden />{unread} new</>;
  const title = `${unread} new ${unread === 1 ? "comment" : "comments"}`;
  return href
    ? <Link href={`${href}#discuss`} title={title} className="flex items-center gap-1 px-1.5 py-0.5 rounded border border-sol-cyan/40 text-sol-cyan hover:bg-sol-cyan/10" data-decision-thread-unread-chip>{body}</Link>
    : <span title={title} className="flex items-center gap-0.5 tabular-nums text-sol-cyan" data-decision-thread-unread-chip>{body}</span>;
}
