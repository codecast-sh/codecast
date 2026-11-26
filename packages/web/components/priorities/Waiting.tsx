// What waits on the person, above the list: every session asking on an open
// milestone of their active priorities (lib/priorityList waitingOf). Wide,
// up to five across two lines with how long each has waited; phone, rows
// 44px tall, three of them, the rest behind "+N more". Each opens its
// session. Nothing waits, nothing shows.
import Link from "next/link";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { ago, type ListLayout, type WaitingItem } from "../../lib/priorityList";
import { cn } from "../../lib/utils";

const WIDE_SHOWN = 5;
const PHONE_SHOWN = 3;

const clip = (t: string, n = 32) => (t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t);

export function WaitingRow({ item, now, full, tall }: { item: WaitingItem; now: number; full?: boolean; tall?: boolean }) {
  return (
    <Link
      href={item.session.href}
      data-waiting-item={item.session.conversation_id}
      title={`${item.milestone} · ${item.session.title}`}
      className={cn("flex min-w-0 items-center gap-1.5 rounded-control px-1.5 text-meta hover:bg-sol-yellow/15", tall ? "h-11 w-full text-ui" : "h-7 [@media(pointer:coarse)]:h-11", full && "w-full")}
    >
      <i aria-hidden className="block size-[7px] shrink-0 rounded-full bg-sol-yellow" />
      {item.rank != null && <span className="shrink-0 font-semibold tabular-nums text-sol-text">#{item.rank}</span>}
      <span className="min-w-0 truncate text-sol-text">{full || tall ? item.milestone : clip(item.milestone)}</span>
      <span className={cn("shrink-0 pl-1 tabular-nums text-sol-text-dim", (full || tall) && "ml-auto")}>{ago(item.session.last_active_at, now)}</span>
    </Link>
  );
}

function More({ items, now, label, className }: { items: WaitingItem[]; now: number; label: string; className?: string }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" data-waiting-more className={cn("shrink-0 rounded-control px-2 text-meta font-medium text-sol-text-muted hover:bg-sol-yellow/15 hover:text-sol-text", className)}>{label}</button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[22rem] bg-sol-card p-1.5">
        <div className="px-1.5 pb-1 pt-0.5 text-mark font-semibold uppercase tracking-wide text-sol-text-dim">Waiting on you · {items.length}</div>
        {items.map((it) => <WaitingRow key={it.key} item={it} now={now} full />)}
      </PopoverContent>
    </Popover>
  );
}

export function WaitingOnYou({ items, now, layout }: { items: WaitingItem[]; now: number; layout: ListLayout }) {
  if (items.length === 0) return null;
  if (layout === "wide") {
    return (
      <section data-waiting="wide" className="mb-3 flex flex-wrap items-center gap-x-1 rounded-lg border border-sol-yellow/45 bg-sol-yellow/[0.06] py-0.5 pl-2.5 pr-1">
        <span className="mr-1 shrink-0 text-mark font-semibold uppercase tracking-wide text-sol-text-muted">Waiting on you</span>
        {items.slice(0, WIDE_SHOWN).map((it) => <WaitingRow key={it.key} item={it} now={now} />)}
        {items.length > WIDE_SHOWN && <More items={items} now={now} label={`+${items.length - WIDE_SHOWN} more`} className="h-7 [@media(pointer:coarse)]:h-11" />}
      </section>
    );
  }
  return (
    <section data-waiting="phone" className="mb-3 rounded-lg border border-sol-yellow/45 bg-sol-yellow/[0.06] px-1.5 pb-1 pt-1.5">
      <div className="px-1 text-mark font-semibold uppercase tracking-wide text-sol-text-muted">Waiting on you</div>
      {items.slice(0, PHONE_SHOWN).map((it) => <WaitingRow key={it.key} item={it} now={now} tall />)}
      {items.length > PHONE_SHOWN && <More items={items} now={now} label={`+${items.length - PHONE_SHOWN} more`} className="h-11 w-full text-left" />}
    </section>
  );
}
