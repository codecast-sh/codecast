// Priorities lab (throwaway prototype): a priority as an object other surfaces
// mention. `pri-60` in a message reads as a pill (target, title, critical
// meter); hovering it shows what it is, where it stands and what is next.
import { Share2, Target } from "lucide-react";
import { toast } from "sonner";
import { HoverCard } from "../../ui/HoverCard";
import { priorityHref } from "../../../lib/priorities";
import { cn } from "../../../lib/utils";
import { SessionChip } from "./LabParts";
import { CriticalMeter, MilestoneRing, StartButton, type PriorityModel } from "./PriorityBlock";

/** The open critical milestone to do next, and who is on it. */
export function nextMilestone(model: PriorityModel) {
  const m = model.milestones.find((x) => !x.step.done && x.step.tier === "critical") ?? model.milestones.find((x) => !x.step.done);
  if (!m) return null;
  const own = m.sessions[0];
  return { m, session: own ?? (m.coveredByDriver ? model.drivers[0] : undefined) };
}

function MiniMeter({ done, total }: { done: number; total: number }) {
  if (!total) return null;
  return (
    <span className="inline-flex items-center gap-[3px] align-middle" aria-label={`${done} of ${total} critical milestones done`}>
      <span className="inline-flex gap-px">
        {Array.from({ length: total }, (_, i) => <i key={i} className={cn("block h-[0.5em] w-[0.32em] rounded-[1px]", i < done ? "bg-current" : "bg-current opacity-25")} />)}
      </span>
      <span className="tabular-nums opacity-80">{done}/{total}</span>
    </span>
  );
}

export function PriorityCard({ model, onOpen }: { model: PriorityModel; onOpen: (id: string) => void }) {
  const { row } = model;
  const next = nextMilestone(model);
  return (
    <div className="p-3">
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
      {row.summary && <p className="mt-2 line-clamp-2 text-meta text-sol-text-muted">{row.summary}</p>}
      {next && (
        <div className="mt-2.5 rounded-control bg-sol-bg-alt/70 px-2 py-1.5">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-sol-text-dim">Next</div>
          <div className="mt-1 flex min-w-0 items-center gap-2">
            <MilestoneRing done={false} polish={next.m.step.tier === "polish"} />
            <span className="min-w-0 flex-1 truncate text-ui text-sol-text">{next.m.step.title}</span>
          </div>
          <div className="mt-1.5 flex pl-[22px]">
            {next.session ? <SessionChip s={next.session} className="max-w-full" /> : <StartButton row={row} step={next.m.step} />}
          </div>
        </div>
      )}
      <div className="mt-3 flex justify-end gap-1.5">
        <button type="button" onClick={() => { void navigator.clipboard?.writeText(window.location.origin + priorityHref(row.short_id)); toast("Link copied"); }} className="inline-flex h-7 items-center gap-1.5 rounded-control border border-sol-border px-2.5 text-meta text-sol-text hover:bg-sol-bg-alt">
          <Share2 className="size-3.5" /> Share
        </button>
        <button type="button" onClick={() => onOpen(row.short_id)} className="inline-flex h-7 items-center rounded-control bg-sol-text px-2.5 text-meta font-medium text-sol-bg hover:opacity-90">
          Open
        </button>
      </div>
    </div>
  );
}

/** `pri-60` as a reference in prose: target glyph, title, critical meter; the card on hover. */
export function PriorityPill({ model, onOpen }: { model: PriorityModel; onOpen: (id: string) => void }) {
  const { row } = model;
  return (
    <HoverCard card={<PriorityCard model={model} onOpen={onOpen} />} side="top" className="w-80" triggerClassName="inline">
      <button
        type="button"
        data-lab-pill
        aria-label={`Reference ${row.short_id}: ${row.title}`}
        onClick={() => onOpen(row.short_id)}
        className="inline-flex max-w-[22em] items-center gap-[0.3em] rounded-[0.25em] bg-sol-orange/10 px-[0.3em] align-baseline font-medium leading-snug text-sol-orange hover:underline decoration-current/40 underline-offset-2"
      >
        <Target className="size-[0.95em] shrink-0" aria-hidden />
        <span className="min-w-0 truncate">{row.title}</span>
        <MiniMeter done={row.counts.critical_done} total={row.counts.critical_total} />
      </button>
    </HoverCard>
  );
}
