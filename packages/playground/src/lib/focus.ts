// Keyboard focus that follows the surface: layers that take it on open, give
// it back on close, keep Tab inside while they own the page, and make the
// page behind them inert.
import { useEffect, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";

const FOCUSABLE = "button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

export const focusables = (box: HTMLElement) => [...box.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.tabIndex >= 0 && !el.closest("[inert]"));

/** The element a layer should focus when it opens: its marked one, else its first. */
export function focusFirst(box: HTMLElement | null) {
  if (!box) return;
  (box.querySelector<HTMLElement>("[data-autofocus]") ?? focusables(box)[0] ?? box).focus({ preventScroll: true });
}

/** Focus is nowhere a person could see: on the body, or inside `box`. */
export const focusLost = (box?: HTMLElement | null) => {
  const at = document.activeElement;
  return !at || at === document.body || (!!box && box.contains(at));
};

/** While mounted, focus belongs to `box`: it goes in on mount and, if it is
 *  still inside (or lost) on unmount, back to `to()` (by default whatever had
 *  it before). */
export function useReturnFocus(box: RefObject<HTMLElement | null>, { take = true, to }: { take?: boolean; to?: () => HTMLElement | null } = {}) {
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const el = box.current;
    if (take) focusFirst(el);
    return () => {
      if (!focusLost(el)) return;
      const back = to?.() ?? before;
      if (back?.isConnected) back.focus({ preventScroll: true });
    };
    // Mount and unmount only: the layer's lifetime is the focus contract.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/** Tab and Shift+Tab cycle inside `box` instead of leaving it. */
export function trapTab(e: KeyboardEvent | ReactKeyboardEvent, box: HTMLElement) {
  if (e.key !== "Tab") return;
  const items = focusables(box);
  if (items.length === 0) return e.preventDefault();
  const i = items.indexOf(document.activeElement as HTMLElement);
  const next = e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : i === items.length - 1 || i < 0 ? 0 : i + 1;
  e.preventDefault();
  items[next].focus();
}

/** The app root (everything but the body's portals) is inert while any
 *  modal layer is open: no Tab, no pointer, and hidden from screen readers. */
let modals = 0;
export function useInertPage() {
  useEffect(() => {
    const root = document.getElementById("root");
    if (!root) return;
    modals += 1;
    root.inert = true;
    return () => {
      modals -= 1;
      if (modals === 0) root.inert = false;
    };
  }, []);
}
