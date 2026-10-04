// The chrome every history list hangs from: a hairline down the left, a dot
// per entry on it, a struck line for an entry taken back, and the fold that
// opens an entry's rows. The org record (components/org/history) and the undo
// timeline (components/undo) both draw through these, so the two read as one
// family and a change to the rail lands on both.
import type { CSSProperties, HTMLAttributes, ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "../../lib/utils";

export const HISTORY_HAIRLINE = "color-mix(in srgb, var(--sol-border) 28%, transparent)";

/** The text decoration of an entry that was taken back. */
export const HISTORY_STRUCK = "line-through decoration-1";

/** The hairline alone, for a list that is not an `ol` (a cmdk list). Its
 *  left edge sits under the centre of a 22px dot. */
export function HistoryRailLine({ className, style }: { className?: string; style?: CSSProperties }) {
  return <span aria-hidden className={cn("absolute left-[10.5px] top-3 bottom-3 w-px", className)} style={{ background: HISTORY_HAIRLINE, ...style }} />;
}

/** An ordered list with the hairline its entries hang from. */
export function HistoryRail({ children, className, ...rest }: HTMLAttributes<HTMLOListElement>) {
  return (
    <ol className={cn("relative", className)} {...rest}>
      <HistoryRailLine />
      {children}
    </ol>
  );
}

/** The dot on the rail. `ring` replaces the hairline border (a conflict's
 *  yellow ring); `color` tints the glyph inside. */
export function HistoryRailDot({ children, color, ring, className }: { children: ReactNode; color?: string; ring?: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("absolute left-0 top-0 w-[22px] h-[22px] rounded-full inline-flex items-center justify-center border", className)}
      style={{ background: "var(--sol-bg)", borderColor: ring ?? HISTORY_HAIRLINE, color }}
    >
      {children}
    </span>
  );
}

/** The fold toggle under an entry: a chevron that turns, and its words. */
export function HistoryFold({ open, onClick, children, className, tabIndex, ...data }: { open: boolean; onClick: () => void; children: ReactNode; className?: string; tabIndex?: number } & Record<`data-${string}`, string | boolean | undefined>) {
  return (
    <button
      type="button"
      onClick={onClick}
      tabIndex={tabIndex}
      aria-expanded={open}
      className={cn("inline-flex items-center gap-1 h-6 -ml-1 px-1 rounded text-[11.5px] transition-colors hover:bg-sol-bg-highlight/70", className)}
      style={{ color: "var(--sol-text-muted)" }}
      {...data}
    >
      <ChevronRight className={cn("w-3 h-3 transition-transform", open && "rotate-90")} />
      {children}
    </button>
  );
}
