import * as React from "react";
import { ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";

// Native <select> with the browser chrome replaced: the default arrow renders
// flush against the right border, so we hide it (appearance-none) and draw our
// own chevron with breathing room. Everything else stays native — the popup
// menu, keyboard behavior, and mobile pickers.
//
// `variant="bare"` is the palette grammar: the value as text with a chevron and
// no box at all, for surfaces that draw structure with hairlines, where a
// filled or bordered select would be the only shape on the page. The text
// brightens on hover and focus; the chevron is the affordance.
const SelectBox = React.forwardRef<
  HTMLSelectElement,
  React.ComponentProps<"select"> & { wrapperClassName?: string; variant?: "box" | "bare" }
>(({ className, wrapperClassName, variant = "box", children, ...props }, ref) => (
  <span className={cn("relative inline-flex", wrapperClassName)}>
    <select
      ref={ref}
      className={cn(
        "appearance-none w-full text-xs focus:outline-none cursor-pointer",
        variant === "bare"
          ? "bg-transparent border-0 pl-0 pr-5 py-1 text-sol-text-muted hover:text-sol-text focus:text-sol-text transition-colors"
          : "bg-sol-bg-alt border border-sol-border rounded-lg pl-2.5 pr-8 py-1.5 text-sol-text focus:border-sol-cyan/60",
        className,
      )}
      {...props}
    >
      {children}
    </select>
    <ChevronDown
      className={cn(
        "pointer-events-none absolute top-1/2 -translate-y-1/2 text-sol-text-dim",
        variant === "bare" ? "right-0 w-3 h-3" : "right-2.5 w-3.5 h-3.5",
      )}
    />
  </span>
));
SelectBox.displayName = "SelectBox";

export { SelectBox };
