import * as React from "react";
import { ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";

// Native <select> with the browser chrome replaced: the default arrow renders
// flush against the right border, so we hide it (appearance-none) and draw our
// own chevron with breathing room. Everything else stays native — the popup
// menu, keyboard behavior, and mobile pickers.
const SelectBox = React.forwardRef<
  HTMLSelectElement,
  React.ComponentProps<"select"> & { wrapperClassName?: string }
>(({ className, wrapperClassName, children, ...props }, ref) => (
  <span className={cn("relative inline-flex", wrapperClassName)}>
    <select
      ref={ref}
      className={cn(
        "appearance-none w-full bg-sol-bg-alt border border-sol-border rounded-lg pl-2.5 pr-8 py-1.5 text-xs text-sol-text focus:outline-none focus:border-sol-cyan/60 cursor-pointer",
        className,
      )}
      {...props}
    >
      {children}
    </select>
    <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-sol-text-dim" />
  </span>
));
SelectBox.displayName = "SelectBox";

export { SelectBox };
