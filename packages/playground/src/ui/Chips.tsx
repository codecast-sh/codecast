import type { ButtonHTMLAttributes } from "react";
import type { ElementRef } from "../../convex/validators";
import { truncate } from "../lib/format";
import s from "./Chips.module.css";

/** A pill you can tap, with an optional colored square. */
export function Chip({ dot, className = "", children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { dot?: string }) {
  return (
    <button className={`${s.chip} ${className}`} {...rest}>
      {dot && <i className={s.dot} style={{ background: dot }} />}
      {children}
    </button>
  );
}

/** Point and talk: the element a message is about, as `tag · text`. */
export function ElementChip({ element, onRemove }: { element: ElementRef; onRemove?: () => void }) {
  const label = element.text ? `${element.tag} · ${truncate(element.text, 28)}` : element.tag;
  return (
    <span className={s.element} title={element.selector}>
      <i className={s.glyph} />
      <span className={s.elementText}>{label}</span>
      {onRemove && (
        <button className={s.remove} onClick={onRemove} aria-label="Remove element">
          ×
        </button>
      )}
    </span>
  );
}

export function FileChip({ path, written }: { path: string; written?: boolean }) {
  return (
    <span className={`${s.file} ${written ? s.written : ""}`}>
      {written && <i className={s.pencil} aria-label="written" />}
      {path}
    </span>
  );
}
