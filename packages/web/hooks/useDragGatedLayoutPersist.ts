import { useCallback, useEffect, useRef } from "react";

// Persist panel layouts from real user gestures only, once, at gesture end.
//
// react-resizable-panels fires onLayoutChange for EVERY size change — user
// drags, imperative collapse/expand, and re-renders applying a layout that
// synced in from another window. Persisting those synced echoes is what
// created a cross-window loop: two windows of different widths clamp the same
// percentage differently, each "corrects" the other's value, and the write
// flood never converges (it once wedged IndexedDB and stranded sends).
//
// The gesture is read from the DOM: the library renders its resize handles
// with role="separator". A pointer held down on a separator (or arrow keys on
// a focused one) marks the change as user-driven; the latest layout is
// buffered and persisted once when the gesture ends.
export function useDragGatedLayoutPersist(
  persist: (layout: { [key: string]: number }) => void,
): (layout: { [key: string]: number }) => void {
  const draggingRef = useRef(false);
  const pendingRef = useRef<{ [key: string]: number } | null>(null);
  const keyboardTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const persistRef = useRef(persist);
  persistRef.current = persist;

  const flush = useCallback(() => {
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (pending) persistRef.current(pending);
  }, []);

  useEffect(() => {
    const isSeparator = (target: EventTarget | null) =>
      target instanceof Element && !!target.closest('[role="separator"]');
    const onPointerDown = (e: PointerEvent) => {
      if (isSeparator(e.target)) draggingRef.current = true;
    };
    const endGesture = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      flush();
    };
    // Keyboard resize (arrow keys on a focused separator) has no pointer
    // bracket; treat each keystroke as a short gesture and flush after a
    // quiet period.
    const onKeyDown = (e: KeyboardEvent) => {
      if (!isSeparator(e.target)) return;
      if (!/^Arrow(Left|Right|Up|Down)$|^(Home|End)$/.test(e.key)) return;
      draggingRef.current = true;
      if (keyboardTimerRef.current) clearTimeout(keyboardTimerRef.current);
      keyboardTimerRef.current = setTimeout(() => {
        keyboardTimerRef.current = null;
        endGesture();
      }, 500);
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointerup", endGesture, true);
    window.addEventListener("pointercancel", endGesture, true);
    window.addEventListener("blur", endGesture);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointerup", endGesture, true);
      window.removeEventListener("pointercancel", endGesture, true);
      window.removeEventListener("blur", endGesture);
      window.removeEventListener("keydown", onKeyDown, true);
      if (keyboardTimerRef.current) clearTimeout(keyboardTimerRef.current);
    };
  }, [flush]);

  return useCallback((layout: { [key: string]: number }) => {
    if (!draggingRef.current) return;
    pendingRef.current = layout;
  }, []);
}
