"use client";
// How a holder of sessions says its state in words (orgMeta's facts, drawn):
// a role or person card on the map, a company line, a hover card. Kept apart
// from the map's cards so a line can say them without loading the map.
import { cn } from "../../lib/utils";
import { ORG_STATE_META, stateWords, standingLineOf } from "./orgMeta";
import { ORG_STATE_ORDER, type OrgStandingState, type StateCounts } from "./orgTypes";

/** One line for a standing agent: a dot and word in its declared colour, then
 *  its pinned line. The role card, the anchor card and the panels share it. */
export function StandingLine({ standing, className, size = "sm" }: { standing: OrgStandingState | null | undefined; className?: string; size?: "sm" | "md" }) {
  const line = standingLineOf(standing);
  if (!line) return null;
  return (
    <div className={cn("flex items-center gap-1.5 min-w-0", size === "sm" ? "text-[10.5px]" : "text-[11.5px]", className)} title={line.text ?? undefined}>
      <span className="shrink-0 w-[7px] h-[7px] rounded-full" style={{ background: line.color }} aria-hidden />
      <span className="shrink-0 font-medium" style={{ color: line.color }}>{line.label}</span>
      {line.text && (
        <>
          <span aria-hidden style={{ color: "var(--sol-text-dim)" }}>·</span>
          <span className="truncate" style={{ color: "var(--sol-text-muted)" }}>{line.text}</span>
        </>
      )}
    </div>
  );
}

/** The full tally for a title: every state with its count. */
const countsTitle = (counts: StateCounts) => ORG_STATE_ORDER.filter((k) => (counts[k] ?? 0) > 0).map((k) => `${counts[k]} ${ORG_STATE_META[k].label}`).join(" · ") || "no sessions";

/** A card's sessions in words (orgMeta.stateWords): the states a person acts
 *  on first, each in its colour, the whole tally on hover. Dots alone say
 *  nothing to a person who has not learned the colours. */
export function StateWords({ counts, max = 2, lead, className }: { counts: StateCounts; max?: number; /** A first part before the words ("+3", for what a stack does not draw). */ lead?: string; className?: string }) {
  const words = stateWords(counts, max);
  if (!lead && words.length === 0) return null;
  const color = (w: string) => (w.includes("need") ? ORG_STATE_META.needs_input.color : w.endsWith("working") ? ORG_STATE_META.working.color : undefined);
  return (
    <span className={cn("inline-flex items-center gap-1 text-[10.5px] tabular-nums whitespace-nowrap", className)} style={{ color: "var(--sol-text-dim)" }} title={countsTitle(counts)} data-state-words>
      {[...(lead ? [lead] : []), ...words].map((w, i) => (
        <span key={w} className="inline-flex items-center gap-1">
          {i > 0 && <span aria-hidden>·</span>}
          <span style={{ color: color(w) }}>{w}</span>
        </span>
      ))}
    </span>
  );
}
