"use client";

// What a session belongs to (the task it owns, the trigger that runs it, its
// plan, its workflow) on ONE row under the header. Each item is a compact
// chip; an opened chip's detail drops into the body below the row, full
// width, so the row itself never grows past one line. Every surface that
// draws these strips mounts them inside a ContextRail; the rail hides itself
// when no item marked data-cc-rail-item rendered.

import { createContext, useContext, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronDown } from "lucide-react";

// undefined: not inside a rail (the item draws its body in place).
// null: inside a rail whose body slot has not mounted yet.
const RailBody = createContext<HTMLElement | null | undefined>(undefined);

export function ContextRail({ children }: { children: ReactNode }) {
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  return (
    <RailBody.Provider value={slot}>
      <div data-cc-context-row className="flex-shrink-0 border-b border-sol-border/30 bg-sol-bg-alt/20 [&:not(:has([data-cc-rail-item]))]:hidden">
        <div className="flex items-center gap-1.5 px-3 py-1 overflow-x-auto cq-no-scrollbar">{children}</div>
        <div ref={setSlot} data-cc-context-body className="empty:hidden border-t border-sol-border/20" />
      </div>
    </RailBody.Provider>
  );
}

/** Detail for a rail item: below the row when inside a rail, in place
 *  otherwise. Carries the item's own data attributes along, so a rule that
 *  hides the item (minimal style) hides its detail too. */
export function RailDetail({ children, ...attrs }: { children: ReactNode } & Record<`data-${string}`, string | undefined>) {
  const slot = useContext(RailBody);
  const body = <div {...attrs} className="min-w-0">{children}</div>;
  if (slot === undefined) return body;
  return slot ? createPortal(body, slot) : null;
}

const chipBase =
  "group/chip flex items-center gap-1.5 h-6 min-w-[6rem] max-w-[20rem] flex-shrink px-2 rounded-md border text-[11px] whitespace-nowrap transition-colors";

export function railChipClass(open: boolean) {
  return `${chipBase} ${open ? "border-sol-border bg-sol-bg-alt text-sol-text" : "border-sol-border/40 text-sol-text-muted hover:border-sol-border/80 hover:bg-sol-bg-alt/60"}`;
}

/** The chevron every chip ends on: points down while its detail is open. */
export function ChipChevron({ open }: { open: boolean }) {
  return <ChevronDown className={`w-3 h-3 flex-shrink-0 text-sol-text-dim transition-transform ${open ? "" : "-rotate-90"}`} />;
}

/** One rail item: a chip that toggles its detail. */
export function RailChip({
  open,
  onToggle,
  title,
  children,
  ...attrs
}: {
  open: boolean;
  onToggle: () => void;
  title?: string;
  children: ReactNode;
} & Record<`data-${string}`, string | undefined>) {
  return (
    <button type="button" {...attrs} aria-expanded={open} onClick={onToggle} title={title} className={railChipClass(open)}>
      {children}
      <ChipChevron open={open} />
    </button>
  );
}
