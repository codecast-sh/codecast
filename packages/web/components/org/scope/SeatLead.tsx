// The seat's introduction, pinned above its conversation (useSeat). The page
// header already carries the seat's face, name, state and parent, so this is
// only what the seat says about itself: one folded line that opens on click.
import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "../../../lib/utils";

export function SeatLead({ children, ask, ...data }: { children: ReactNode; ask?: ReactNode } & Record<`data-${string}`, string | boolean | undefined>) {
  const [open, setOpen] = useState(false);
  return (
    <button
      type="button"
      onClick={() => setOpen((v) => !v)}
      aria-expanded={open}
      className="conv-col mx-auto w-full flex items-start gap-2 px-2 sm:px-3 md:px-4 py-1.5 text-left text-[12.5px] leading-relaxed hover:bg-sol-bg-highlight/40 transition-colors"
      style={{ color: "var(--sol-text-muted)" }}
      {...data}
    >
      <span className={cn("min-w-0 flex-1", !open && "truncate")}>
        {children}
        {ask && <span className="ml-1.5" style={{ color: "var(--sol-yellow)" }} data-scope-lead-ask>{ask}</span>}
      </span>
      <ChevronDown className={cn("w-3.5 h-3.5 mt-[3px] shrink-0 transition-transform", open && "rotate-180")} style={{ color: "var(--sol-text-dim)" }} />
    </button>
  );
}
