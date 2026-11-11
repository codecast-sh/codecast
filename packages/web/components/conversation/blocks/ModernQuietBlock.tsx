import { useRef, useState, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { useOverflows } from "../../../hooks/useOverflows";
import { clipFade } from "../../CollapsibleBody";

// Content a person reads (a plan, a structured result) in the Modern style:
// a one-line header in the row anatomy (a glyph, a label, what it is about, a
// status at the right, the chevron from aria-expanded) over the content on
// the tinted panel ([data-cc-row-detail], app/globals.css "MODERN · ROWS"),
// held to a sensible height with "Show all". The chevron folds the content
// away; actions (copy, a link, raw JSON) sit at the panel's foot, never in
// the header, so the header stays one button.

/** Content held to `max` px with a fade at the cut, "Show all" under it, and the caller's actions at the right of that line. */
export function ModernClamp({ max = 420, watch, footer, children }: { max?: number; watch?: unknown; footer?: ReactNode; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const overflows = useOverflows(ref, max, [watch]);
  const [all, setAll] = useState(false);
  const clipped = overflows && !all;
  return (
    <>
      <div ref={ref} style={clipped ? { maxHeight: max, overflow: "hidden", ...clipFade() } : undefined}>{children}</div>
      {(overflows || footer) && (
        <div className="mt-2 flex min-h-7 items-center gap-1">
          {overflows && (
            <button type="button" data-cc-show-all aria-expanded={all} onClick={() => setAll((v) => !v)} className="rounded-control px-1.5 -mx-1.5 h-7 text-meta font-medium text-sol-text-muted hover:bg-[var(--cc-m-hover)] hover:text-sol-text">
              {all ? "Show less" : "Show all"}
            </button>
          )}
          {footer && <span className="ml-auto flex items-center gap-0.5">{footer}</span>}
        </div>
      )}
    </>
  );
}

export function ModernQuietBlock({ family, icon: Icon, label, text, object, status, statusClass = "", tone, defaultOpen = true, max, watch, footer, children, ...rest }: {
  /** data-cc-row: what kind of block this is (plan, result, …). */
  family: string;
  icon: LucideIcon;
  label: ReactNode;
  /** What it is about, in words (a plan's title). */
  text?: ReactNode;
  /** What it is about, as code (an id, a path). */
  object?: ReactNode;
  status?: ReactNode;
  statusClass?: string;
  tone?: "error" | "warn";
  defaultOpen?: boolean;
  max?: number;
  /** A value that changes when the content does, so the clamp measures again. */
  watch?: unknown;
  footer?: ReactNode;
  children: ReactNode;
} & Record<`data-${string}`, unknown>) {
  const [open, setOpen] = useState(defaultOpen);
  // Nothing to read yet (a result still streaming in): the header alone, no chevron.
  const hasBody = children != null && children !== false;
  const words = (
    <>
      <Icon data-cc-row-icon aria-hidden className="w-4 h-4 shrink-0" strokeWidth={1.75} />
      <span data-cc-row-verb>{label}</span>
      {object != null && <span data-cc-row-object className="font-mono">{object}</span>}
      {text != null && <span data-cc-row-text>{text}</span>}
      {status != null && <span data-cc-row-meta className={statusClass}>{status}</span>}
    </>
  );
  return (
    <div data-cc-row={family} data-cc-block data-cc-row-tone={tone} {...rest}>
      {hasBody ? (
        <button type="button" data-cc-row-head aria-expanded={open} onClick={() => setOpen((v) => !v)} className="w-full text-left">{words}</button>
      ) : (
        <div data-cc-row-head>{words}</div>
      )}
      {open && hasBody && (
        <div data-cc-row-detail className="px-4 py-3">
          <ModernClamp max={max} watch={watch} footer={footer}>{children}</ModernClamp>
        </div>
      )}
    </div>
  );
}
