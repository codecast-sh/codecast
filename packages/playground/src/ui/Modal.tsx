import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import s from "./Modal.module.css";

/** A modal over the scrim, at the body. Esc and a scrim click close it; focus
 *  moves in on open and back to where it was on close. */
export function Modal({ onClose, label, className = "", children }: { onClose: () => void; label: string; className?: string; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const first = box.current?.querySelector<HTMLElement>("[data-autofocus], input, button");
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      before?.focus?.();
    };
  }, [onClose]);
  return createPortal(
    <div className={s.scrim} onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={box} role="dialog" aria-modal aria-label={label} className={`${s.modal} ${className}`}>
        {children}
      </div>
    </div>,
    document.body,
  );
}
