import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { trapTab, useInertPage, useReturnFocus } from "../lib/focus";
import s from "./Modal.module.css";

/** A modal over the scrim, at the body. Esc and a scrim click close it. It
 *  owns the keyboard while open: focus moves in, Tab cycles inside, the page
 *  behind is inert, and focus goes back to where it was on close. */
export function Modal({ onClose, label, className = "", children }: { onClose: () => void; label: string; className?: string; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  useInertPage();
  useReturnFocus(box);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      } else if (box.current) trapTab(e, box.current);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return createPortal(
    <div className={s.scrim} onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={box} role="dialog" aria-modal aria-label={label} tabIndex={-1} className={`${s.modal} ${className}`}>
        {children}
      </div>
    </div>,
    document.body,
  );
}
