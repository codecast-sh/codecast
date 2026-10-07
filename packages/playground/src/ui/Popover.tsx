import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { focusFirst, focusables, trapTab, useReturnFocus } from "../lib/focus";
import s from "./Popover.module.css";

/** A popover at the body (so no scroll container clips it), placed above or
 *  below its anchor and flipped when it would leave the viewport, with a
 *  pointer at the anchor. Outside clicks and Esc close it.
 *
 *  Keyboard: it takes focus when it opens (`takeFocus`; a preview that opens
 *  on its anchor's focus waits for Tab from the anchor instead), Tab cycles
 *  inside it, ↑/↓ move through a menu, and focus goes back to the anchor
 *  when it closes. The anchor says `aria-haspopup` and `aria-expanded`. */
export function Popover({ anchor, onClose, label, role = "dialog", takeFocus = true, place = "below", align = "end", width, className = "", children }: {
  anchor: HTMLElement;
  onClose?: () => void;
  label: string;
  role?: "dialog" | "menu";
  takeFocus?: boolean;
  place?: "above" | "below";
  align?: "start" | "center" | "end";
  width: number;
  className?: string;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; arrow: number; side: "above" | "below" } | null>(null);
  useReturnFocus(box, { take: false, to: () => anchor });
  // Focus waits until it is placed: a hidden element can't take it.
  const placed = pos !== null;
  useEffect(() => {
    if (placed && takeFocus) focusFirst(box.current);
  }, [placed, takeFocus]);
  // Tab from the anchor goes into the popover, not past it to the end of the page.
  useEffect(() => {
    const tab = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || e.shiftKey || !box.current) return;
      e.preventDefault();
      focusFirst(box.current);
    };
    anchor.addEventListener("keydown", tab);
    return () => anchor.removeEventListener("keydown", tab);
  }, [anchor]);

  useLayoutEffect(() => {
    const place_ = () => {
      const a = anchor.getBoundingClientRect();
      const h = box.current?.offsetHeight ?? 0;
      const gap = 10;
      let side = place;
      if (side === "above" && a.top - h - gap < 8) side = "below";
      else if (side === "below" && a.bottom + h + gap > innerHeight - 8 && a.top - h - gap >= 8) side = "above";
      const cx = a.left + a.width / 2;
      const want = align === "center" ? cx - width / 2 : align === "start" ? a.left : a.right - width;
      const left = Math.min(Math.max(8, want), innerWidth - width - 8);
      setPos({ left, top: side === "above" ? a.top - h - gap : a.bottom + gap, arrow: Math.min(Math.max(18, cx - left), width - 18), side });
    };
    place_();
    const ro = new ResizeObserver(place_);
    if (box.current) ro.observe(box.current);
    addEventListener("resize", place_);
    addEventListener("scroll", place_, true);
    return () => {
      ro.disconnect();
      removeEventListener("resize", place_);
      removeEventListener("scroll", place_, true);
    };
  }, [anchor, place, align, width]);

  useEffect(() => {
    if (!onClose) return;
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!box.current?.contains(t) && !anchor.contains(t)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key, true);
    };
  }, [anchor, onClose]);

  return createPortal(
    <div
      ref={box}
      role={role}
      aria-label={label}
      tabIndex={-1}
      onKeyDown={(e) => {
        const el = box.current!;
        if (e.key === "Tab") return trapTab(e, el);
        const step = role === "menu" ? { ArrowDown: 1, ArrowUp: -1 }[e.key] : undefined;
        if (!step) return;
        e.preventDefault();
        const items = focusables(el);
        items[(items.indexOf(document.activeElement as HTMLElement) + step + items.length) % items.length]?.focus();
      }}
      className={`${s.pop} ${pos?.side === "above" ? s.above : s.below} ${className}`}
      style={{ width, left: pos?.left ?? -9999, top: pos?.top ?? -9999, ["--arrow" as string]: `${pos?.arrow ?? 0}px`, visibility: pos ? "visible" : "hidden" }}
    >
      {children}
    </div>,
    document.body,
  );
}
