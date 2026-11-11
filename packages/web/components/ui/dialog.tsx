import * as React from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { X } from "lucide-react"

import { cn } from "../../lib/utils"
import { modernFocusRing } from "./styles"

// The Modern style (the `modern:` classes) draws a dialog as a white sheet of
// paper over a lighter scrim: 14px corners, the dialog shadow, and a height
// that never outgrows the window (the viewport less a margin), scrolling as
// a whole when its content is taller. Wrap the part that grows in
// <DialogBody> and that part scrolls alone, so the header (title, close) and
// the footer (the buttons) stay in view. Classic and Minimal keep their face
// and get the same cap: a dialog taller than the window scrolls as a whole,
// so its buttons are always in reach. A call site's own max-h- or overflow-
// class wins over the cap (cn merges them).
const MODERN_CLOSE = "modern:right-3 modern:top-3 modern:inline-flex modern:size-7 modern:items-center modern:justify-center modern:rounded-control modern:text-sol-text-dim modern:opacity-100 modern:transition-colors modern:duration-press modern:ease-ui modern:hover:bg-sol-text/[0.06] modern:hover:text-sol-text modern:data-[state=open]:bg-transparent"

const Dialog = DialogPrimitive.Root

const DialogTrigger = DialogPrimitive.Trigger

const DialogPortal = DialogPrimitive.Portal

const DialogClose = DialogPrimitive.Close

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "fixed inset-0 z-[200] bg-black/80  data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      // Modern: the page dimmed, not blacked out.
      "modern:bg-black/40 modern:duration-pop modern:ease-ui",
      className
    )}
    {...props}
  />
))
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    /** For dialogs that draw their own close button in their header. */
    hideClose?: boolean
  }
>(({ className, children, hideClose, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      // Radix does not render aria-modal itself; the shortcut dispatcher's
      // modal guard (hasOpenModal) keys on it, so without this cmd-n and other
      // global shortcuts fire underneath an open dialog.
      aria-modal="true"
      className={cn(
        "fixed left-[50%] top-[50%] z-[200] grid max-h-[calc(100dvh-2rem)] w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 overflow-y-auto border bg-background p-6 shadow-lg duration-200 outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%] sm:rounded-lg",
        "modern:flex modern:max-h-[calc(100dvh-2rem)] modern:flex-col modern:overflow-y-auto modern:rounded-dialog modern:border-sol-border modern:bg-sol-card modern:text-sol-text modern:shadow-dialog modern:duration-pop modern:ease-ui modern:data-[state=open]:zoom-in-[0.98] modern:data-[state=closed]:zoom-out-[0.98]",
        className
      )}
      {...props}
    >
      {children}
      {!hideClose && <DialogPrimitive.Close className={cn("absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground", MODERN_CLOSE, modernFocusRing)}>
        <X className="h-4 w-4" />
        <span className="sr-only">Close</span>
      </DialogPrimitive.Close>}
    </DialogPrimitive.Content>
  </DialogPortal>
))
DialogContent.displayName = DialogPrimitive.Content.displayName

const DialogHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col space-y-1.5 text-center sm:text-left",
      // Modern: left-aligned and clear of the close button; stays put while a
      // DialogBody scrolls.
      "modern:shrink-0 modern:pr-6 modern:text-left",
      className
    )}
    {...props}
  />
)
DialogHeader.displayName = "DialogHeader"

const DialogFooter = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2",
      // Modern: an 8px gap on a phone's stack too; stays put while a
      // DialogBody scrolls.
      "modern:shrink-0 modern:gap-2 modern:sm:space-x-0",
      className
    )}
    {...props}
  />
)
DialogFooter.displayName = "DialogFooter"

// Modern: the part of a dialog that grows. It scrolls inside the dialog while
// the header and footer stay put, edge to edge so its scrollbar sits at the
// dialog's side. In Classic and Minimal it is a plain block.
const DialogBody = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn("modern:-mx-6 modern:min-h-0 modern:flex-1 modern:overflow-y-auto modern:px-6", className)}
    {...props}
  />
)
DialogBody.displayName = "DialogBody"

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn(
      "text-lg font-semibold leading-none tracking-tight modern:text-sol-text",
      className
    )}
    {...props}
  />
))
DialogTitle.displayName = DialogPrimitive.Title.displayName

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
))
DialogDescription.displayName = DialogPrimitive.Description.displayName

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogTrigger,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogBody,
  DialogFooter,
  DialogTitle,
  DialogDescription,
}
