// Priorities lab (throwaway prototype): a priority as an object other surfaces
// mention. `pri-60` in a message reads as a pill (target, title, critical
// meter). Hovering it shows its card: what it is, what is next and the button
// for it, where it stands. On a touch screen a tap opens the same card as a
// bottom sheet.
import { useState } from "react";
import { Share2, Target } from "lucide-react";
import { toast } from "sonner";
import { HoverCard } from "../../ui/HoverCard";
import { Sheet, SheetContent, SheetTitle } from "../../ui/sheet";
import { priorityHref } from "../../../lib/priorities";
import { cn } from "../../../lib/utils";
import { SessionChip } from "./LabParts";
import { ActionButton, nextOf } from "./nextAction";
import { CriticalMeter, MilestoneRing, type PriorityModel } from "./PriorityBlock";

function MiniMeter({ done, total }: { done: number; total: number }) {
  if (!total) return null;
  return (
    <span className="inline-flex items-center gap-[3px] align-middle" aria-label={`${done} of ${total} critical milestones done`}>
      <span className="inline-flex gap-px">
        {Array.from({ length: total }, (_, i) => <i key={i} className={cn("block h-[0.5em] w-[0.32em] rounded-[1px]", i < done ? "bg-sol-green" : "bg-sol-text/20")} />)}
      </span>
      <span className="tabular-nums text-sol-text-muted">{done}/{total}</span>
    </span>
  );
}

export function PriorityCard({ model, onOpen }: { model: PriorityModel; onOpen: (id: string) => void }) {
  const { row } = model;
  const next = nextOf(model);
  return (
    <div className="bg-sol-card p-3">
      <div className="flex items-start gap-2">
        <Target className="mt-0.5 size-4 shrink-0 text-sol-orange" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="text-ui font-semibold leading-snug text-sol-text">{row.title}</div>
          <div className="mt-0.5 flex items-center gap-1.5 text-meta text-sol-text-dim">
            <span className="font-mono">{row.short_id}</span>·<span className="truncate">{row.mine ? "You" : row.owner}</span>
            {row.rank != null && <>·<span>#{row.rank}</span></>}
          </div>
        </div>
        <CriticalMeter row={row} />
      </div>
      {next && (
        <div className="mt-2.5 rounded-control border border-sol-border/60 bg-sol-bg px-2.5 py-2">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-sol-text-dim">Next</div>
          <div className="mt-1 flex min-w-0 items-center gap-2">
            <MilestoneRing done={false} polish={false} />
            <span className="min-w-0 flex-1 truncate text-ui font-medium text-sol-text">{next.m.step.title}</span>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5 pl-[22px]">
            <ActionButton row={row} step={next.m.step} action={next} />
            {next.session && <SessionChip s={next.session} hideState={next.kind === "needs_you"} className="max-w-[12rem]" />}
          </div>
        </div>
      )}
      {row.summary && <p className="mt-2 line-clamp-2 text-meta text-sol-text-muted">{row.summary}</p>}
      <div className="mt-3 flex justify-end gap-1.5">
        <button type="button" onClick={() => { void navigator.clipboard?.writeText(window.location.origin + priorityHref(row.short_id)); toast("Link copied"); }} className="inline-flex h-8 items-center gap-1.5 rounded-control border border-sol-border px-3 text-meta text-sol-text hover:bg-sol-bg-alt">
          <Share2 className="size-3.5" /> Share
        </button>
        <button type="button" onClick={() => onOpen(row.short_id)} className="inline-flex h-8 items-center rounded-control bg-sol-text px-3 text-meta font-semibold text-sol-bg hover:opacity-90">
          Open
        </button>
      </div>
    </div>
  );
}

/** A phone or tablet: a tap opens the card as a sheet instead of leaving the message. */
const isTouchWidth = () => typeof window !== "undefined" && (window.matchMedia("(max-width: 640px)").matches || window.matchMedia("(hover: none)").matches);

/** `pri-60` as a reference in prose: target glyph, title, critical meter; the card on hover, or as a sheet on a tap. */
export function PriorityPill({ model, onOpen }: { model: PriorityModel; onOpen: (id: string) => void }) {
  const { row } = model;
  const [sheet, setSheet] = useState(false);
  return (
    <>
      <HoverCard card={<PriorityCard model={model} onOpen={onOpen} />} side="top" className="w-80 overflow-hidden" triggerClassName="inline" disabled={sheet}>
        <button
          type="button"
          data-lab-pill
          aria-label={`Reference ${row.short_id}: ${row.title}`}
          onClick={() => (isTouchWidth() ? setSheet(true) : onOpen(row.short_id))}
          className="inline-flex max-w-[22em] items-center gap-[0.3em] rounded-[0.25em] bg-sol-orange/10 px-[0.3em] align-baseline font-medium leading-snug text-sol-orange hover:underline decoration-current/40 underline-offset-2"
        >
          <Target className="size-[0.95em] shrink-0" aria-hidden />
          <span className="min-w-0 truncate">{row.title}</span>
          <MiniMeter done={row.counts.critical_done} total={row.counts.critical_total} />
        </button>
      </HoverCard>
      <Sheet open={sheet} onOpenChange={setSheet}>
        <SheetContent side="bottom" className="max-h-[80vh] overflow-y-auto rounded-t-2xl p-0 pb-[env(safe-area-inset-bottom)]">
          <SheetTitle className="sr-only">{row.title}</SheetTitle>
          <div aria-hidden className="mx-auto mt-2 h-1 w-10 rounded-full bg-sol-text/20" />
          <PriorityCard model={model} onOpen={(id) => { setSheet(false); onOpen(id); }} />
        </SheetContent>
      </Sheet>
    </>
  );
}
