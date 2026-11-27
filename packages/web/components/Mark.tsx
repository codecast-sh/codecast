// A registered mark (lib/marks): a glyph of Codecast's own icon language. It
// names itself on hover in the app's tooltip card and carries `data-mark`, which
// the icon legend reads off the page while it is open. One renders per list
// row, so it holds no state, effects or subscriptions of its own; the tooltip
// arms only on first hover.
import type { ReactNode } from "react";
import { MARK_BY_ID, type MarkGroup } from "../lib/marks";
import { openIconLegend } from "../lib/iconLegend";
import { ShortcutTooltip } from "./KeyboardShortcutsHelp";
import type { ShortcutAction } from "../shortcuts";

const warned = new Set<string>();

/**
 * `labeled`: its word sits beside it here, so the legend leaves it out.
 * `quiet`: listed in the legend, but no tooltip of its own, for a glyph inside
 * something that already opens a hover card naming it.
 * `tinted`: the glyph wears its object's own colour (a project's, a label's,
 * a repository's), not a colour that means something, so the legend keeps one
 * picture of it, drawn in neutral ink.
 * `action` / `hint`: keycaps or a short note after "Name · meaning" in the tooltip.
 */
export function Mark({ id, labeled, quiet, tinted, action, hint, side = "top", className = "", children }: {
  id: string;
  labeled?: boolean;
  quiet?: boolean;
  tinted?: boolean;
  action?: ShortcutAction;
  hint?: ReactNode;
  /** Layout for the mark's box (a percent size, a margin), which the glyph inside cannot take. */
  className?: string;
  side?: "top" | "bottom" | "left" | "right";
  children: ReactNode;
}) {
  const def = MARK_BY_ID.get(id);
  if (!def) {
    if (import.meta.env.DEV && !warned.has(id)) {
      warned.add(id);
      console.warn(`<Mark id="${id}">: no such mark in lib/marks`);
    }
    return <>{children}</>;
  }
  const box = <span data-mark={id} data-mark-labeled={labeled || undefined} data-mark-tinted={tinted || undefined} className={`inline-flex shrink-0 items-center justify-center${className && ` ${className}`}`}>{children}</span>;
  if (quiet) return box;
  return (
    <ShortcutTooltip side={side} action={action} hint={hint} label={<><span className="font-medium">{def.name}</span><span className="text-sol-text-muted"> · {def.meaning}</span></>}>
      {box}
    </ShortcutTooltip>
  );
}

/** The quiet "?" a surface dense with marks carries at its top right. */
export function LegendButton({ lead }: { lead?: MarkGroup }) {
  return (
    <ShortcutTooltip label="What the icons mean" action="ui.toggleShortcutsHelp" eager>
      <button
        type="button"
        data-legend-button
        onClick={() => openIconLegend(lead)}
        aria-label="What the icons mean"
        className="grid size-7 shrink-0 place-items-center rounded-full text-sol-text-dim transition-colors hover:bg-sol-text/[0.06] hover:text-sol-text-muted"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="size-[17px]" aria-hidden>
          <circle cx="12" cy="12" r="9.5" /><path d="M9.2 9.2a2.9 2.9 0 0 1 5.6 1c0 1.9-2.8 2.6-2.8 2.6" /><path d="M12 17h.01" />
        </svg>
      </button>
    </ShortcutTooltip>
  );
}
