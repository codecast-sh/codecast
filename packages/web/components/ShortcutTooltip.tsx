// The app's hover card for icon buttons and marks: a label, the bound
// shortcut as keycaps, a dimmed hint. Kept apart from the shortcuts panel so
// a mark or button that uses it doesn't pull the panel's module graph.
import { cloneElement, isValidElement, useContext, useRef, useState, type ReactNode } from "react";
import { formatShortcutParts, formatAcceleratorParts, getShortcutsForAction, type ShortcutAction } from "../shortcuts/registry";
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "./ui/tooltip";
import { HoverCardsOff } from "../lib/hoverCardsOff";
import { useMountEffect } from "../hooks/useMountEffect";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { KeyCap } from "./KeyCap";

// A tooltip may stay open only while its trigger holds the pointer or focus.
// Fail open (true) where :hover matching is unsupported (jsdom) so tests and
// odd embedders keep the plain Radix behavior.
function isTooltipAnchored(el: HTMLElement): boolean {
  try {
    if (el.matches(":hover")) return true;
  } catch {
    return true;
  }
  const active = document.activeElement;
  return active === el || el.contains(active);
}

// Rich tooltip for icon buttons: label plus the bound shortcut rendered as
// KeyCaps (never plain-text key glyphs — see UI conventions). Replaces native
// `title` attributes, which can't render keycaps and double up with Radix.
// A tooltip closes the moment the pointer leaves its trigger, so it holds
// words only. A panel with something to read, select or press goes in
// ui/HoverCard, which stays open while the pointer crosses onto it.
export function ShortcutTooltip({ label, action, accel, hint, side = "bottom", align, eager = false, children }: {
  label: ReactNode;
  action?: ShortcutAction;
  /** A chord with no registry action (the composer's SEND_CHORDS), in accelerator syntax. */
  accel?: string;
  // Optional trailing note rendered dimmed after the keycaps, e.g. "cycles" for a
  // key that steps through options rather than toggling.
  hint?: ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  eager?: boolean;
  children: ReactNode;
}) {
  // Lazy: hundreds of these mount at once (every card action, every header
  // button), and the Radix provider/portal tree is ~15 fibers per instance —
  // most of the inbox's fiber count was tooltip plumbing for affordances the
  // user never hovers. Until the first pointer/focus touches the trigger,
  // render the child alone; then mount Radix for good and drive the FIRST
  // show ourselves (Radix missed the pointerenter that armed us).
  const hoverOff = useContext(HoverCardsOff);
  const [armed, setArmed] = useState(eager);
  const [open, setOpen] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  useMountEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); });

  // Stuck-open guard. Arming swaps the tree (bare child → Radix trigger), which
  // remounts the DOM node, so the pointerleave that should cancel/close can land
  // on a node with no handler — or never fire at all when the list scrolls under
  // a stationary cursor. A controlled tooltip that opens with the pointer already
  // elsewhere has no event left to close it, so while open we close on any
  // evidence the pointer isn't on the trigger.
  useWatchEffect(() => {
    if (!open) return;
    const closeIfAway = (e?: Event) => {
      const el = triggerRef.current;
      if (!el || !el.isConnected) { setOpen(false); return; }
      if (e instanceof PointerEvent && e.target instanceof Node && el.contains(e.target)) return;
      if (!isTooltipAnchored(el)) setOpen(false);
    };
    window.addEventListener("scroll", closeIfAway, { capture: true, passive: true });
    window.addEventListener("pointermove", closeIfAway, { capture: true, passive: true });
    window.addEventListener("blur", closeIfAway);
    return () => {
      window.removeEventListener("scroll", closeIfAway, { capture: true });
      window.removeEventListener("pointermove", closeIfAway, { capture: true });
      window.removeEventListener("blur", closeIfAway);
    };
  }, [open]);

  // A surface that opens nothing on hover (HoverCardsOff) never arms: no tooltip, no window listeners.
  if (!isValidElement(children) || hoverOff) {
    return <>{children}</>;
  }

  if (!armed) {
    const arm = (e: any) => {
      triggerRef.current = e.currentTarget as HTMLElement;
      if (timerRef.current) clearTimeout(timerRef.current);
      // The first show is ours (Radix missed the arming pointerenter), so the
      // "still hovering?" check Radix would do is ours too.
      timerRef.current = setTimeout(() => {
        const el = triggerRef.current;
        if (el && el.isConnected && isTooltipAnchored(el)) setOpen(true);
      }, 300);
      setArmed(true);
    };
    const childProps = children.props as Record<string, any>;
    return cloneElement(children as React.ReactElement<any>, {
      onPointerEnter: (e: any) => { childProps.onPointerEnter?.(e); arm(e); },
      onFocus: (e: any) => { childProps.onFocus?.(e); arm(e); },
    });
  }

  const cancelFirstShow = () => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
  };
  const defs = action ? getShortcutsForAction(action) : [];
  const parts = defs.length > 0 ? formatShortcutParts(defs[0]) : accel ? formatAcceleratorParts(accel) : null;
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip open={open} onOpenChange={(v) => { cancelFirstShow(); setOpen(v); }}>
        <TooltipTrigger asChild ref={(node) => { triggerRef.current = node; }} onPointerLeave={cancelFirstShow} onBlur={cancelFirstShow}>{children}</TooltipTrigger>
        {/* Bounded width + wrap: a label that carries a sentence (a trigger's
            standing prompt, a long path) folds into lines instead of running
            one unbroken row across the viewport and clipping. */}
        <TooltipContent
          side={side}
          align={align}
          collisionPadding={8}
          className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 max-w-[min(360px,calc(100vw-16px))] bg-sol-bg text-sol-text border border-sol-border shadow-md"
        >
          <span className="min-w-0 [overflow-wrap:anywhere]">{label}</span>
          {parts && (
            <span className="flex items-center gap-[2px]">
              {parts.map((part, i) => (
                <KeyCap key={i} size="xs">{part}</KeyCap>
              ))}
            </span>
          )}
          {hint && <span className="text-sol-text-dim">{hint}</span>}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
