// A priority as an object other surfaces mention. `pri-60` in a message reads
// as a pill: a target, the title, a small critical meter and n/m. On a mouse
// the pill's card opens on hover; on a touch screen a tap opens the same card
// as a bottom sheet, since nothing there can hover. The card says what it is
// (owner, rank and who placed it), its one next action (the list's rule,
// shared/contracts/priorityDerive nextActionOf), a two-line summary, Share
// and Open. The row comes from the store (lib/entityDisplay feeds
// priorities.show into priorityDetails).
import { useState, type ReactNode } from "react";
import Link from "next/link";
import { Share2, Target } from "lucide-react";
import { toast } from "sonner";
import type { PriorityRow } from "@codecast/shared/contracts/priorities";
import { HoverCard } from "../ui/HoverCard";
import { Sheet, SheetContent, SheetTitle } from "../ui/sheet";
import { useCoarsePointer } from "../../hooks/useIsPhone";
import { usePriorityModel } from "../../hooks/usePriorityModels";
import { publicUrl } from "@codecast/shared/entities";
import { priorityHref, rankProvenance } from "../../lib/priorities";
import { cn } from "../../lib/utils";
import { ActionButton, MilestoneBox } from "./parts";
import { MilestoneToggle } from "./controls";

/** The critical path as pips and n/m. `size="inline"` scales with the prose it sits in. */
export function CriticalMeter({ done, total, size = "card" }: { done: number; total: number; size?: "inline" | "card" }) {
  if (!total) return null;
  const inline = size === "inline";
  return (
    <span data-critical-meter className="inline-flex shrink-0 items-center gap-[0.3em]" aria-label={`${done} of ${total} critical milestones done`}>
      <span aria-hidden className={cn("inline-flex", inline ? "gap-px" : "gap-[2px]")}>
        {Array.from({ length: total }, (_, i) => (
          <i key={i} className={cn("block rounded-[1px]", inline ? "h-[0.5em] w-[0.32em]" : "h-[7px] w-[7px] rounded-[1.5px]", i < done ? "bg-sol-green" : "bg-sol-text/20")} />
        ))}
      </span>
      <span className={cn("tabular-nums", inline ? "" : "text-meta text-sol-text-muted")}>{done}/{total}</span>
    </span>
  );
}

/** The card a reference opens: what it is, what is next and its button, where it stands, Share and Open. `tall`: 44px buttons, for a finger. */
export function PriorityCard({ row, onOpen, tall }: { row: PriorityRow; onOpen?: () => void; tall?: boolean }) {
  const model = usePriorityModel(row);
  const { action } = model;
  const why = rankProvenance(row);
  const meta = [row.short_id, row.mine ? "You" : row.owner, row.rank != null ? `#${row.rank}${why ? ` ${why}` : ""}` : null].filter(Boolean);
  return (
    <div data-priority-card={row.short_id} className="bg-sol-bg p-3">
      <div className="flex items-start gap-2">
        <Target className="mt-0.5 size-4 shrink-0 text-sol-orange" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="text-ui font-semibold leading-snug text-sol-text">{row.title}</div>
          <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 text-meta text-sol-text-dim">
            {meta.map((m, i) => (
              <span key={i} className={cn("whitespace-nowrap", i === 0 && "font-mono")}>{i > 0 && <span aria-hidden className="mr-1.5">·</span>}{m}</span>
            ))}
          </div>
        </div>
        <CriticalMeter done={row.counts.critical_done} total={row.counts.critical_total} />
      </div>
      {action && (
        <div data-priority-next className="mt-2.5 rounded-control border border-sol-border/60 bg-sol-bg-alt/40 px-2.5 py-2">
          <div className="text-mark font-semibold uppercase tracking-wide text-sol-text-dim">Next</div>
          <div className="mt-1 flex min-w-0 items-center gap-2">
            {/* The owner marks it done from here; the next one takes its place. */}
            {row.mine ? <MilestoneToggle row={row} step={action.milestone.step} className={tall ? "-my-3 -ml-2.5 h-11 pl-2.5 pr-1" : undefined} /> : <MilestoneBox done={false} />}
            <span className="min-w-0 flex-1 truncate text-ui font-medium text-sol-text" title={action.milestone.step.title}>{action.milestone.step.title}</span>
          </div>
          <div className="mt-2 flex min-w-0 pl-[22px]"><ActionButton row={row} action={action} tall={tall} /></div>
        </div>
      )}
      {row.summary && <p className="mt-2 line-clamp-2 text-meta leading-relaxed text-sol-text-muted">{row.summary}</p>}
      <div className="mt-3 flex justify-end gap-1.5">
        <button type="button" data-priority-share onClick={() => { void navigator.clipboard?.writeText(publicUrl(priorityHref(row.short_id))); toast("Link copied"); }} className={cn("inline-flex items-center gap-1.5 rounded-control border border-sol-border px-3 text-meta text-sol-text hover:bg-sol-bg-alt", tall ? "h-11 px-4" : "h-8")}>
          <Share2 className="size-3.5" aria-hidden /> Share
        </button>
        <Link href={priorityHref(row.short_id)} onClick={onOpen} data-priority-open className={cn("inline-flex items-center rounded-control bg-sol-text px-3 text-meta font-semibold text-sol-bg no-underline hover:opacity-90", tall ? "h-11 px-4" : "h-8")}>
          Open
        </Link>
      </div>
    </div>
  );
}

/** The card as a bottom sheet, for a touch screen. */
export function PrioritySheet({ row, open, onOpenChange }: { row: PriorityRow; open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        hideClose
        onOpenAutoFocus={(e) => e.preventDefault()}
        aria-describedby={undefined}
        data-priority-sheet={row.short_id}
        className="inset-x-0 mx-auto max-h-[80vh] max-w-[440px] overflow-y-auto rounded-t-2xl p-0 pb-[env(safe-area-inset-bottom)]"
      >
        <SheetTitle className="sr-only">{row.title}</SheetTitle>
        <div aria-hidden className="mx-auto mt-2 h-1 w-10 rounded-full bg-sol-text/20" />
        <PriorityCard row={row} onOpen={() => onOpenChange(false)} tall />
      </SheetContent>
    </Sheet>
  );
}

/**
 * `pri-N` in prose: target, title, critical meter. A mouse hovers it for the
 * card and clicks through to the page; a finger taps it for the sheet.
 */
export function PriorityPill({ row, href, label, suffix }: { row: PriorityRow; href: string; label: string; suffix?: ReactNode }) {
  const touch = useCoarsePointer();
  const [sheet, setSheet] = useState(false);
  const pill = (
    <Link
      href={href}
      data-priority-pill={row.short_id}
      onClick={(e) => {
        if (!touch || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        setSheet(true);
      }}
      title={row.title}
      className="not-prose entity-ref inline-flex max-w-[24em] items-baseline gap-[0.3em] rounded-[0.2em] bg-sol-orange/[0.08] px-[0.2em] align-baseline text-[1em] font-medium leading-snug text-sol-orange no-underline decoration-current/40 underline-offset-2 hover:bg-sol-orange/[0.16] hover:underline"
    >
      <Target className="size-[0.95em] shrink-0 self-center opacity-80" aria-hidden />
      <span className="min-w-0 truncate">{label}</span>
      <CriticalMeter done={row.counts.critical_done} total={row.counts.critical_total} size="inline" />
    </Link>
  );
  return (
    <>
      <HoverCard card={<PriorityCard row={row} />} className="w-80 overflow-hidden" triggerClassName="inline" disabled={touch}>
        {pill}
      </HoverCard>
      {suffix && <span className="-ml-[3px]">{suffix}</span>}
      {touch && <PrioritySheet row={row} open={sheet} onOpenChange={setSheet} />}
    </>
  );
}
