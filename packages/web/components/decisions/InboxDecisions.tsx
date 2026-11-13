"use client";

import Link from "next/link";
import { useOwnedDecisionCount } from "../../hooks/useDecisionRows";

// The inbox's Decisions section lists sessions stopped on a question. A flow's
// decision has no session waiting, so these send the reader to the one home
// for every decision the viewer owns: a header link when the section has
// cards but owns more than they show, the bare header when it has none.

const link = "text-meta font-medium text-sol-text-muted underline-offset-2 hover:text-sol-text hover:underline no-underline";

export function InboxDecisionsAll({ cards }: { cards: number }) {
  const owned = useOwnedDecisionCount();
  if (owned <= cards) return null;
  return <Link href="/decisions" className={link} data-inbox-decisions-all={owned}>All {owned}</Link>;
}

export function InboxDecisionsHeader({ cards }: { cards: number }) {
  const owned = useOwnedDecisionCount();
  if (cards > 0 || owned === 0) return null;
  return (
    <Link href="/decisions" data-inbox-section="questions" data-inbox-decisions-all={owned}
      className="sticky top-0 z-10 w-full px-3 py-1.5 bg-sol-bg border-b border-sol-border/30 flex items-center justify-between gap-2 text-sol-violet no-underline hover:bg-sol-bg-alt">
      <span className="text-meta font-semibold uppercase tracking-wider">Decisions <span className="opacity-70">{owned}</span></span>
      <span className="text-meta text-sol-text-muted">Open</span>
    </Link>
  );
}
