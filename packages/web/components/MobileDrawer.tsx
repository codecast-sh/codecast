"use client";

// The phone-width slide-over for the shell's side rails: the nav on the left,
// the session list on the right. One drawer serves both, on the Sheet
// primitive (Radix Dialog), which supplies the focus trap, Escape and backdrop
// close, body scroll lock, focus return to the trigger, and the slide in and
// out. The phone spacing (safe-area insets, 44px rows) lives in globals.css
// under .cc-mobile-drawer.

import type { ReactNode } from "react";
import { X } from "lucide-react";
import { Sheet, SheetClose, SheetContent, SheetTitle } from "./ui/sheet";
import { cn } from "../lib/utils";

export function MobileDrawer({
  open,
  onOpenChange,
  side,
  title,
  className,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  side: "left" | "right";
  /** Read by screen readers as the dialog name and shown in the drawer's header row. */
  title: string;
  /** Shell mode classes (simple-view, inbox-compact): the drawer portals to
   *  <body>, so the rail's scoped rules need the class on the drawer itself. */
  className?: string;
  children: ReactNode;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side={side}
        hideClose
        overlayClassName="cc-mobile-drawer-overlay"
        data-cc-mobile-drawer={side}
        className={cn(
          "cc-mobile-drawer flex flex-col w-[85vw] max-w-sm p-0 bg-sol-bg-alt text-sol-text border-sol-border shadow-xl",
          "data-[state=open]:duration-[220ms] data-[state=closed]:duration-[180ms]",
          className,
        )}
      >
        <div className="cc-mobile-drawer-head flex items-center justify-between shrink-0 pl-4 pr-1 border-b border-sol-border/30">
          <SheetTitle className="text-xs font-medium text-sol-text-dim uppercase tracking-wide">{title}</SheetTitle>
          <SheetClose
            aria-label={`Close ${title.toLowerCase()}`}
            className="cc-touch-target flex items-center justify-center rounded-md text-sol-text-muted hover:text-sol-text hover:bg-sol-bg transition-colors [&>svg]:h-[18px] [&>svg]:w-[18px]"
          >
            <X />
          </SheetClose>
        </div>
        <div className="flex-1 min-h-0">{children}</div>
      </SheetContent>
    </Sheet>
  );
}
