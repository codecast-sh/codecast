// What waits on the person, above the list: every session asking on an open
// milestone of their active priorities (lib/priorityList waitingOf). Wide,
// up to five within two lines with how long each has waited, fewer when the
// last one and "+N more" would wrap onto a third; phone, rows 44px tall,
// three of them, the rest behind "+N more". Each opens its session. Nothing
// waits, nothing shows.
import { useLayoutEffect, useRef, useState } from "react";
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
      {/* Clipped in the wide box, each part keeps its own share, so two asks on one milestone still read apart. */}
      <span className="min-w-0 truncate text-sol-text">{full || tall ? item.label : item.who ? `${clip(item.milestone, 18)} · ${clip(item.who, 18)}` : clip(item.label)}</span>
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

/** The line a wrapped item sits on (0, 1, 2…): its top over the first item's, in item heights. */
const lineOf = (top: number, firstTop: number, height: number) => (height > 0 ? Math.round((top - firstTop) / height) : 0);

/**
 * The wide box: as many items as fit two lines with "+N more" after them.
 * Measured after each paint; a third line drops one item at a time, and a
 * new width starts over from five.
 */
function WideWaiting({ items, now }: { items: WaitingItem[]; now: number }) {
  const [shown, setShown] = useState(WIDE_SHOWN);
  const box = useRef<HTMLElement>(null);
  const width = useRef(0);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const first = el.querySelector<HTMLElement>("[data-waiting-item]");
    const tail = el.querySelector<HTMLElement>("[data-waiting-more]") ?? el.querySelector<HTMLElement>("[data-waiting-item]:last-of-type");
    if (!first || !tail) return;
    if (el.offsetWidth !== width.current) {
      const fresh = width.current !== 0 && shown !== WIDE_SHOWN;
      width.current = el.offsetWidth;
      if (fresh) return setShown(WIDE_SHOWN);
    }
    if (shown > 1 && lineOf(tail.offsetTop, first.offsetTop, first.offsetHeight) >= 2) setShown(shown - 1);
  });
  const count = Math.min(shown, items.length);
  return (
    <section ref={box} data-waiting="wide" className="mb-3 flex flex-wrap items-center gap-x-1 rounded-lg border border-sol-yellow/45 bg-sol-yellow/[0.06] py-0.5 pl-2.5 pr-1">
      <span className="mr-1 shrink-0 text-mark font-semibold uppercase tracking-wide text-sol-text-muted">Waiting on you</span>
      {items.slice(0, count).map((it) => <WaitingRow key={it.key} item={it} now={now} />)}
      {items.length > count && <More items={items} now={now} label={`+${items.length - count} more`} className="h-7 [@media(pointer:coarse)]:h-11" />}
    </section>
  );
}

export function WaitingOnYou({ items, now, layout }: { items: WaitingItem[]; now: number; layout: ListLayout }) {
  if (items.length === 0) return null;
  if (layout === "wide") return <WideWaiting items={items} now={now} />;
  return (
    <section data-waiting="phone" className="mb-3 rounded-lg border border-sol-yellow/45 bg-sol-yellow/[0.06] px-1.5 pb-1 pt-1.5">
      <div className="px-1 text-mark font-semibold uppercase tracking-wide text-sol-text-muted">Waiting on you</div>
      {items.slice(0, PHONE_SHOWN).map((it) => <WaitingRow key={it.key} item={it} now={now} tall />)}
      {items.length > PHONE_SHOWN && <More items={items} now={now} label={`+${items.length - PHONE_SHOWN} more`} className="h-11 w-full text-left" />}
    </section>
  );
}
