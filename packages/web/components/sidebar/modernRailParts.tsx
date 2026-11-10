// The pieces only the Modern rail has: a row that opens a level rather than a
// page (More, the short-rail switch), a heading that folds its list, and the
// mark of a feature its team never decided on. They wear the classic row's
// shape (a group/nav row around a data-nav-row control, a data-rail-heading
// label), so components/sidebar/modernRail.css styles them with the rest.

import type { ReactNode } from "react";
import { NavCount } from "./navPrimitives";

const QUIET_COUNT = "bg-sol-bg-highlight text-sol-text-muted";

function Chevron({ open }: { open?: boolean }) {
  return (
    <svg className={`w-3 h-3 flex-shrink-0 transition-transform duration-150 motion-reduce:transition-none ${open ? "rotate-90" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.5} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
    </svg>
  );
}

/** A top-level row that is a button (More, the short-rail switch): the same
 *  shape, height, icon and states as a page's row. */
export function RailButtonRow({ icon, label, onClick, isActive = false, isNarrow, drill, title, ...data }: {
  icon: ReactNode;
  label: string;
  onClick?: () => void;
  isActive?: boolean;
  isNarrow: boolean;
  /** Opens a level of the rail: wears the chevron. */
  drill?: boolean;
  title?: string;
  [data: `data-${string}`]: string | undefined;
}) {
  return (
    <div {...data} className={`group/nav flex items-center transition-colors motion-reduce:transition-none ${isActive ? "text-sol-text" : "text-sol-text-muted hover:text-sol-text hover:bg-sol-bg-highlight/60"}`}>
      <button
        type="button"
        onClick={onClick}
        data-nav-row
        title={title ?? label}
        aria-current={isActive ? "page" : undefined}
        className={`flex-1 flex items-center ${isNarrow ? "justify-center" : "gap-3"} min-w-0 text-left`}
      >
        {icon}
        {!isNarrow && <span className="truncate">{label}</span>}
      </button>
      {!isNarrow && (drill ? <span className="mx-0.5 text-sol-text-dim"><Chevron /></span> : <span className="w-4 flex-shrink-0" aria-hidden="true" />)}
    </div>
  );
}

/** A group heading that folds its list (Bookmarks, Folders): closed, the
 *  rows are not drawn and the count says how many wait under it. */
export function RailFoldHeading({ label, open, onToggle, count, action }: {
  label: string;
  open: boolean;
  onToggle: () => void;
  count?: number;
  action?: ReactNode;
}) {
  return (
    <div data-rail-heading={label} className="group/rail flex items-center gap-1 uppercase text-sol-text-dim">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        title={open ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
        className="flex flex-1 min-w-0 items-center gap-1 rounded-sm text-left uppercase hover:text-sol-text transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sol-cyan/60"
      >
        <span className="truncate">{label}</span>
        <Chevron open={open} />
        {!!count && !open && <span className="ml-auto normal-case tracking-normal"><NavCount n={count} tone={QUIET_COUNT} small /></span>}
      </button>
      {action}
    </div>
  );
}

/** A feature row's mark while its team has not decided on it. */
export function NewMark() {
  return <span className="text-mark font-semibold tracking-wide px-1.5 h-[18px] inline-flex items-center rounded-md" style={{ color: "var(--sol-cyan)", background: "color-mix(in srgb, var(--sol-cyan) 14%, transparent)" }} data-feature-new>NEW</span>;
}
