// The hover card's open/close timing, kept out of the component file: an
// export that is not a component makes the module a failed Fast Refresh
// boundary, so every save re-executes its importers.
import { useCallback, useContext, useRef, useState, useEffect } from "react";
import { HoverCardsOff } from "../lib/hoverCardsOff";

const HOVER_CARD_OPEN_MS = 200;
const HOVER_CARD_CLOSE_MS = 150;

export function useHoverCard() {
  const [shown, setShown] = useState(false);
  // A surface that opens nothing on hover (HoverCardsOff) keeps the card shut, whatever asks.
  const off = useContext(HoverCardsOff);
  const open = shown && !off;
  const setOpen = useCallback((next: boolean) => setShown(next && !off), [off]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancel = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
  }, []);
  // Always cancel any pending timer before scheduling the next one: the
  // flicker ("disappears then comes back") was a stale close timer surviving
  // re-entry into the card.
  const openSoon = useCallback(() => { cancel(); timer.current = setTimeout(() => setOpen(true), HOVER_CARD_OPEN_MS); }, [cancel, setOpen]);
  const closeSoon = useCallback(() => { cancel(); timer.current = setTimeout(() => setOpen(false), HOVER_CARD_CLOSE_MS); }, [cancel, setOpen]);
  const closeNow = useCallback(() => { cancel(); setOpen(false); }, [cancel, setOpen]);
  // eslint-disable-next-line no-restricted-syntax -- drops the pending open/close timer when the card goes away
  useEffect(() => cancel, [cancel]);
  return { open, setOpen, openSoon, closeSoon, closeNow, cancel };
}
