"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useOwnedDecisionCount } from "../../hooks/useDecisionRows";
import { SectionHeader } from "../inbox/SectionHeader";

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
  const router = useRouter();
  const owned = useOwnedDecisionCount();
  if (cards > 0 || owned === 0) return null;
  return (
    <SectionHeader
      label="Decisions"
      count={owned}
      color="text-sol-violet"
      sectionKey="questions"
      collapsed
      onToggle={() => router.push("/decisions")}
      action={<Link href="/decisions" className={link} data-inbox-decisions-all={owned}>Open</Link>}
    />
  );
}
