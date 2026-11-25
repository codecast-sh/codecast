"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useInboxStore, type SessionDecisionItem } from "../../store/inboxStore";
import { relatedOpenDecisions } from "../../lib/decisionQueue";
import { decisionHref } from "../../lib/decisionLinks";
import { teamMembersOf } from "../../lib/activeTeam";

// ct-101357: an open decision on the same subject (the same task, or one
// linked to it) that sits in a teammate's lane never reaches this person's
// stepper. The card they are answering names it, so one press opens it
// rather than a hunt through the Decisions list after answering.
export function RelatedDecisionPointer({ decisionId, className }: { decisionId: string; className?: string }) {
  // Subscribe to the ids alone: the decisions and tasks collections churn,
  // and the pointer only changes when the set of related open asks does.
  const sig = useInboxStore((s) => {
    const meId = (s as any).currentUser?._id as string | undefined;
    return relatedOpenDecisions(s.sessionDecisions?.[decisionId], s.sessionDecisions, s.tasks as any, meId)
      .map((d) => `${d._id}:${d.question?.length ?? 0}:${(d as any).holder_key ?? ""}`).join(",");
  });
  const rows = useMemo(() => {
    if (!sig) return [];
    const s = useInboxStore.getState();
    const members = teamMembersOf(s);
    return sig.split(",").map((part) => s.sessionDecisions[part.split(":")[0]!]).filter((d): d is SessionDecisionItem => !!d).map((d) => {
      const holderId = (d as any).holder?.kind === "user" ? (d as any).holder.id : d.asked_user_ids?.[0];
      const holder = holderId ? members.find((m: any) => m._id === holderId) : undefined;
      return { d, holderName: holder?.name as string | undefined };
    });
  }, [sig]);
  if (rows.length === 0) return null;
  return (
    <div className={className} data-related-decisions>
      <div className="text-mark uppercase tracking-wide text-sol-text-dim mb-1">also open on this subject</div>
      <ul className="space-y-1">
        {rows.map(({ d, holderName }) => (
          <li key={d._id}>
            <Link href={decisionHref(d)} className="flex items-baseline gap-2 min-w-0 text-sm text-sol-text-muted hover:text-sol-text">
              <span className="shrink-0 font-mono text-meta text-sol-blue">{d.short_id ?? d._id}</span>
              <span className="truncate">{d.question}</span>
              {holderName && <span className="shrink-0 text-meta text-sol-text-dim">{holderName}</span>}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
