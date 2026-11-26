// Priorities lab (throwaway prototype): what waits on the person, above the
// list. Up to three, in priority-rank order: a session on one of their open
// milestones that asks something, or a pending decision it raised; each with
// one button. Nothing waits, nothing shows.
import Link from "next/link";
import { CircleHelp } from "lucide-react";
import { cn } from "../../../lib/utils";
import { StateMark } from "./LabParts";
import type { SessionView } from "./labModel";

export type WaitingItem = { key: string; priority: string; rank: number | null; milestone: string; session: SessionView; decision: boolean };

const SHOWN = 3;

export function WaitingRow({ item, showRank = true }: { item: WaitingItem; showRank?: boolean }) {
  return (
    <li className="flex min-h-11 items-center gap-2.5 px-3 py-1.5">
      {item.decision ? <CircleHelp className="size-3.5 shrink-0 text-sol-yellow" aria-label="Decision" /> : <StateMark status={item.session.status} size={12} />}
      {showRank && item.rank != null && <span className="w-5 shrink-0 text-ui font-semibold tabular-nums text-sol-text-dim">#{item.rank}</span>}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-ui font-medium text-sol-text">{item.milestone}</span>
        <span className="block truncate text-meta text-sol-text-dim">{item.decision ? "Decision in " : ""}{item.session.title || item.session.short_id}</span>
      </span>
      <Link href={item.session.href} className="inline-flex h-8 shrink-0 items-center rounded-control bg-sol-text px-3.5 text-meta font-semibold text-sol-bg hover:opacity-90">
        Open
      </Link>
    </li>
  );
}

export function WaitingStrip({ items }: { items: WaitingItem[] }) {
  if (items.length === 0) return null;
  return (
    <section data-lab-waiting className="mb-4 overflow-hidden rounded-lg border border-sol-yellow/45 bg-sol-yellow/[0.06]">
      <div className="flex items-center gap-2 px-3 pt-2 text-[10px] font-semibold uppercase tracking-wide text-sol-text-muted">
        Waiting on you
        {items.length > SHOWN && <span className="font-normal normal-case tracking-normal text-sol-text-dim">{SHOWN} of {items.length}</span>}
      </div>
      <ul className={cn("divide-y divide-sol-yellow/20")}>
        {items.slice(0, SHOWN).map((it) => <WaitingRow key={it.key} item={it} />)}
      </ul>
    </section>
  );
}
