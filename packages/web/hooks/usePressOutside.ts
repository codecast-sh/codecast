import { useRef, type RefObject } from "react";
import { useWatchEffect } from "./useWatchEffect";

/**
 * Close something small (a popover, a question, a menu) when a press lands
 * outside `ref`, and, with `escape`, on Escape too. Nothing listens while
 * `active` is false.
 *
 * The press is heard in the capture phase, so a control that stops its own
 * event (a stage tile, a Radix trigger) cannot keep the popover open.
 *
 * Escape is heard in the capture phase on the window and goes no further:
 * the open popover owns that key, so a stage that collapses on Escape, or a
 * second listener elsewhere, never also acts on the press that closed it.
 * That holds wherever focus is, which a React onKeyDown on the popover could
 * not promise: a control that swaps its button for its question leaves focus
 * on the body.
 *
 * `onOutside` is read through a ref, so a caller may pass a fresh closure on
 * every render without the listeners being torn down and added again.
 */
export function usePressOutside(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  onOutside: () => void,
  opts: { escape?: boolean } = {},
): void {
  const close = useRef(onOutside);
  close.current = onOutside;
  const escape = !!opts.escape;
  useWatchEffect(() => {
    if (!active) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) close.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      close.current();
    };
    document.addEventListener("pointerdown", onDown, true);
    if (escape) window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      if (escape) window.removeEventListener("keydown", onKey, true);
    };
  }, [active, escape, ref]);
}
