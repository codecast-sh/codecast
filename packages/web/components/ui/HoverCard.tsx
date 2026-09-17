// One hover card for the whole app (session-characters.md S4): 200 ms in,
// 150 ms out, an invisible bridge over the gap so the cursor can cross to the
// card, content that re-arms while hovered, and a single timer so a stale
// close never hides a card the cursor is inside. The reference pill
// (EntityIdPill) owns its own anchor markup for the reveal band and uses the
// hook alone; every other surface wraps its trigger in <HoverCard>.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Popover, PopoverAnchor, PopoverContent } from "./popover";

export const HOVER_CARD_OPEN_MS = 200;
export const HOVER_CARD_CLOSE_MS = 150;

export function useHoverCard() {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancel = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
  }, []);
  // Always cancel any pending timer before scheduling the next one: the
  // flicker ("disappears then comes back") was a stale close timer surviving
  // re-entry into the card.
  const openSoon = useCallback(() => { cancel(); timer.current = setTimeout(() => setOpen(true), HOVER_CARD_OPEN_MS); }, [cancel]);
  const closeSoon = useCallback(() => { cancel(); timer.current = setTimeout(() => setOpen(false), HOVER_CARD_CLOSE_MS); }, [cancel]);
  const closeNow = useCallback(() => { cancel(); setOpen(false); }, [cancel]);
  useEffect(() => cancel, [cancel]);
  return { open, setOpen, openSoon, closeSoon, closeNow, cancel };
}

export function HoverCard({
  card, children, side = "top", align = "start", className = "w-80", disabled, triggerClassName,
}: {
  card: ReactNode;
  children: ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  /** Width and any extra classes for the card body; the chrome is fixed. */
  className?: string;
  disabled?: boolean;
  triggerClassName?: string;
}) {
  const h = useHoverCard();
  if (disabled) return <>{children}</>;
  return (
    <Popover open={h.open} onOpenChange={h.setOpen}>
      <PopoverAnchor asChild>
        <span className={triggerClassName ?? "inline-flex min-w-0 items-center"} onMouseEnter={h.openSoon} onMouseLeave={h.closeSoon}>
          {children}
        </span>
      </PopoverAnchor>
      <PopoverContent
        className={`${className} max-w-[calc(100vw-16px)] bg-sol-bg border border-sol-border shadow-xl p-0 relative`}
        side={side}
        align={align}
        sideOffset={6}
        collisionPadding={8}
        onMouseEnter={h.openSoon}
        onMouseLeave={h.closeSoon}
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        {/* Invisible bridge over the offset gap to the trigger. */}
        <span aria-hidden className={`absolute inset-x-0 h-2 ${side === "bottom" ? "bottom-full" : "top-full"}`} />
        {card}
      </PopoverContent>
    </Popover>
  );
}
