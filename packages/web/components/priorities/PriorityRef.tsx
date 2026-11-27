// A priority as an object other surfaces mention. `pri-60` in a message reads
// as a pill: the owner's face, the rank badge, the title, a small critical
// meter and n/m. On a mouse the pill's card opens on hover; on a touch screen
// a tap opens the same card as a bottom sheet, since nothing there can hover.
// The card says whose it is and where it ranks (face, badge, title), its plan,
// its open critical milestones with their state marks (the list's,
// shared/contracts/priorityDerive milestoneStateOf), then pri-N, Share and
// Open. The row comes from the store (lib/entityDisplay feeds priorities.show
// into priorityDetails).
import { useState, type ReactNode } from "react";
import Link from "next/link";
import { Map as MapIcon, Share2, Target } from "lucide-react";
import { toast } from "sonner";
import type { PriorityRow } from "@codecast/shared/contracts/priorities";
import { HoverCard } from "../ui/HoverCard";
import { Sheet, SheetContent, SheetTitle } from "../ui/sheet";
import { useCoarsePointer } from "../../hooks/useCoarsePointer";
import { usePriorityModel } from "../../hooks/usePriorityModels";
import { useSidebarFocusId } from "../../hooks/useSidebarFocusId";
import { publicUrl } from "@codecast/shared/entities";
import { priorityHref } from "../../lib/priorities";
import { cn } from "../../lib/utils";
import { AuthorAvatar } from "../entityDisplay";
import { Mark } from "../Mark";
import { MilestoneStateMark } from "./parts";

/** The critical path as pips and n/m. `size="inline"` scales with the prose it sits in. */
export function CriticalMeter({ done, total, size = "card", className }: { done: number; total: number; size?: "inline" | "card"; className?: string }) {
  if (!total) return null;
  const inline = size === "inline";
  return (
    <span data-critical-meter className={cn("inline-flex shrink-0 items-center gap-[0.3em]", className)} aria-label={`${done} of ${total} critical milestones done`}>
      <span aria-hidden className={cn("inline-flex", inline ? "gap-px" : "gap-[2px]")}>
        {Array.from({ length: total }, (_, i) => (
          <i key={i} className={cn("block rounded-[1px]", inline ? "h-[0.5em] w-[0.32em]" : "h-[7px] w-[7px] rounded-[1.5px]", i < done ? "bg-sol-green" : "bg-sol-text/20")} />
        ))}
      </span>
      <span className={cn("tabular-nums", inline ? "" : "text-meta text-sol-text-muted")}>{done}/{total}</span>
    </span>
  );
}

/** A priority's mark: its rank in an orange square, or the target when it has none (not active). */
export function RankMark({ rank, className }: { rank: number | null; className?: string }) {
  if (rank == null) return <Target data-rank-mark="none" className={cn("inline size-[0.95em] shrink-0 opacity-80", className)} aria-hidden />;
  return (
    <span data-rank-mark={rank} role="img" aria-label={`Rank ${rank}`} className={cn("inline-grid h-[1.25em] min-w-[1.25em] shrink-0 place-items-center rounded-[0.3em] bg-sol-orange px-[0.25em] text-[0.75em] font-bold leading-none tabular-nums text-sol-bg", className)}>
      {rank}
    </span>
  );
}

/** Whose priority it is: the owner's face, their initial when they have no picture. An em `size` scales with the prose around it. */
export function OwnerFace({ row, size = "1.1em", className }: { row: PriorityRow; size?: string | number; className?: string }) {
  // AuthorAvatar's initial shrinks its own font, so an em size measured inside it would shrink the circle too: the box takes the size and the avatar fills it.
  const em = typeof size === "string";
  const who = row.mine ? "You" : row.owner;
  return (
    <span data-owner-face role="img" aria-label={who} title={who} className={cn("inline-flex shrink-0", className)} style={em ? { width: size, height: size } : undefined}>
      {/* The owner's own name, yours included: the initial is theirs, never "Y". */}
      <AuthorAvatar name={row.owner} avatar={row.owner_image} size={em ? "100%" : size} />
    </span>
  );
}

/** The open critical milestones a card lists, at most. */
const CARD_MILESTONES = 3;

/** The card a reference opens: whose it is and its rank (face, badge, title), its plan, its open milestones and their states, then pri-N, Share and Open. `tall`: 44px rows and buttons, for a finger. */
export function PriorityCard({ row, onOpen, tall }: { row: PriorityRow; onOpen?: () => void; tall?: boolean }) {
  const model = usePriorityModel(row, undefined, undefined, "sidebar", useSidebarFocusId());
  // The open critical milestones, and any milestone that needs you whatever its tier (lib/priorityList's rule).
  const open = model.milestones.filter((m) => m.state.kind === "needs_you" || (m.tier === "critical" && !m.done));
  return (
    <div data-priority-card={row.short_id} className="bg-sol-bg p-3">
      <div className="flex items-start gap-2">
        <span className="mt-[2px] flex shrink-0 items-center gap-1 text-[14px]"><OwnerFace row={row} size={18} /><RankMark rank={row.rank} /></span>
        <div className="min-w-0 flex-1 text-ui font-semibold leading-snug text-sol-text">{row.title}</div>
      </div>
      {model.plan && (
        <Link href={`/plans/${model.plan.short_id}`} data-chip="plan" className="mt-1.5 flex min-w-0 items-center gap-2 pl-[42px] text-meta text-sol-text-muted no-underline hover:underline">
          <Mark id="entity.plan"><MapIcon className="size-3.5 shrink-0 text-sol-text-dim" aria-hidden /></Mark>
          <span className="min-w-0 truncate">{model.plan.title}</span>
          <span className="shrink-0 tabular-nums text-sol-text-dim">{model.plan.done}/{model.plan.total}</span>
        </Link>
      )}
      {open.length > 0 && (
        <ul data-priority-milestones className="mt-2 pl-[22px]">
          {open.slice(0, CARD_MILESTONES).map((m) => (
            <li key={m.key} data-milestone={m.key} data-state={m.state.kind} className={cn("flex min-w-0 items-center gap-2", tall ? "min-h-11" : "min-h-7")}>
              <MilestoneStateMark row={row} m={m} />
              <span className="min-w-0 truncate text-ui text-sol-text" title={m.step.title}>{m.step.title}</span>
            </li>
          ))}
          {open.length > CARD_MILESTONES && <li className="pl-8 text-meta tabular-nums text-sol-text-dim">+{open.length - CARD_MILESTONES} more</li>}
        </ul>
      )}
      <div className="mt-3 flex items-center justify-end gap-1.5">
        <span className="mr-auto font-mono text-meta text-sol-text-dim">{row.short_id}</span>
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

// Wrapped as prose, `middle` sits 0.1em of the line's font under the title's centre in every face measured (sans, mono, serif;
// 11-16px): the lift puts the face, the badge and the meter on it. The badge's own em is 0.75 of the line's, so it lifts 0.1/0.75 of its own.
const FACE_MID = "align-middle -translate-y-[0.1em]";
const RANK_MID = "align-middle -translate-y-[0.133em]";

/** A wide pill's parts as prose: the face, the badge and the title's first word never part at a line break, nor its last word and the meter. */
function WideParts({ row, label }: { row: PriorityRow; label: string }) {
  const words = label.trim().split(/\s+/);
  const first = words[0];
  const last = words.length > 1 ? words[words.length - 1] : null;
  const middle = words.slice(1, -1).join(" ");
  const meter = row.counts.critical_total > 0 && <CriticalMeter done={row.counts.critical_done} total={row.counts.critical_total} size="inline" className={cn(FACE_MID, "ml-[0.3em]")} />;
  return (
    <>
      <span data-pill-lead className="whitespace-nowrap">
        <OwnerFace row={row} className={cn(FACE_MID, "mr-[0.3em]")} />
        <RankMark rank={row.rank} className={cn(row.rank == null ? FACE_MID : RANK_MID, "mr-[0.3em]")} />
        {first}
        {!last && meter}
      </span>
      {middle && ` ${middle}`}
      {last && <> <span data-pill-tail className="whitespace-nowrap">{last}{meter}</span></>}
    </>
  );
}

/**
 * `pri-N` in prose: face, rank, title, critical meter. A mouse hovers it for
 * the card and clicks through to the page; a finger taps it for the sheet.
 * `wide` wraps a long title as prose; otherwise the title truncates.
 */
export function PriorityPill({ row, href, label, suffix, wide }: { row: PriorityRow; href: string; label: string; suffix?: ReactNode; wide?: boolean }) {
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
      className={cn(
        "not-prose entity-ref rounded-[0.2em] bg-sol-orange/[0.08] px-[0.2em] align-baseline text-[1em] font-medium text-sol-orange no-underline decoration-current/40 underline-offset-2 hover:bg-sol-orange/[0.16] hover:underline",
        wide ? "inline leading-[1.55] [box-decoration-break:clone] [-webkit-box-decoration-break:clone]" : "inline-flex max-w-[24em] items-center gap-[0.3em] leading-snug",
      )}
    >
      {wide ? <WideParts row={row} label={label} /> : (
        <>
          <OwnerFace row={row} />
          <RankMark rank={row.rank} />
          {/* One line: every part centred, the title alone on the baseline so the pill sits on the sentence's. */}
          <span className="min-w-0 self-baseline truncate">{label}</span>
          <CriticalMeter done={row.counts.critical_done} total={row.counts.critical_total} size="inline" />
        </>
      )}
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
