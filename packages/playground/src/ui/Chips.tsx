import type { ButtonHTMLAttributes } from "react";
import type { ElementRef } from "../../convex/validators";
import { clipText } from "../../convex/lib/text";
import { CloseIcon } from "./icons";
import s from "./Chips.module.css";

/** A pill you can tap: starters, ideas, name suggestions. */
export function Chip({ className = "", children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button className={`${s.chip} ${className}`} {...rest}>
      {children}
    </button>
  );
}

/** Point and talk: the element a message is about, as `tag · text`. */
export function ElementChip({ element, onRemove }: { element: ElementRef; onRemove?: () => void }) {
  const label = element.text ? `${element.tag} · ${clipText(element.text, 28)}` : element.tag;
  return (
    <span className={s.element} title={element.selector}>
      <i className={s.glyph} />
      <span className={s.elementText}>{label}</span>
      {onRemove && (
        <button className={s.remove} onClick={onRemove} aria-label="Remove element">
          <CloseIcon />
        </button>
      )}
    </span>
  );
}

/** A file Clay touched: read ones sit sunk, written ones raised with a dot. */
export function FileChip({ path, written }: { path: string; written?: boolean }) {
  return <span className={`${s.file} ${written ? s.written : ""}`}>{path}</span>;
}
