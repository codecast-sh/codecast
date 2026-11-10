import type { ComponentType, HTMLAttributes, ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { useTitlebarHead } from "../../hooks/useTitlebarHead";
import { useIsModernStyle } from "../../hooks/useVisualStyle";
import { cn } from "../../lib/utils";
import "./page-header.css";

// THE page header of the Modern style. Every top-level page names itself with
// this one bar, so the title sits in the same place, at the same size, on
// every page: one row of crumbs, icon, title and count on the left, tabs after
// them, actions and the share control on the right, and an optional second row
// for filters or a search field. There is no lede: a screen is not a document
// (AGENTS.md, UI conventions), so a sentence that used to sit under a title
// either states live state, and becomes the count or a chip in the actions, or
// goes.
//
// Classic and Minimal keep each page's own header: a page passes it as
// `legacy`, and outside Modern that is all this renders.
//
// The bar is the page's titlebar in zen mode (hooks/useTitlebarHead), so a
// page that draws it never lends a TitlebarStrip of its own. Sizes and
// wrapping live in page-header.css.

export interface PageHeaderProps extends Omit<HTMLAttributes<HTMLElement>, "title" | "children"> {
  /** The page's own header, drawn instead of the bar in Classic and Minimal. */
  legacy: ReactNode;
  /** The page's name as the sidebar spells it (lib/navRegistry). */
  title: string;
  /** A 16px lucide icon before the title. */
  icon?: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  /** How many things the page shows, said quietly after the title. */
  count?: number | string | null;
  /** Where a detail page sits, before the title; the header draws the chevron. */
  crumbs?: ReactNode;
  /** The page's views, normally a SegmentedToggle, after the title and count. */
  tabs?: ReactNode;
  /** Right-aligned controls: ui/button at size sm, icon buttons with aria-labels. */
  actions?: ReactNode;
  /** The share control, always the last thing on the right. */
  share?: ReactNode;
  /** A second row for filters or a search field. */
  children?: ReactNode;
}

export function PageHeader({ legacy, ...props }: PageHeaderProps) {
  return useIsModernStyle() ? <PageHeaderBar {...props} /> : <>{legacy}</>;
}

function PageHeaderBar({ title, icon: Icon, count, crumbs, tabs, actions, share, children, className, ...rest }: Omit<PageHeaderProps, "legacy">) {
  // The first row is the titlebar, not the whole header: it holds the side
  // padding the zen inset replaces, and it sits on the header's own surface.
  const titlebarRef = useTitlebarHead<HTMLDivElement>();
  return (
    <header data-cc-page-head className={cn("border-b border-sol-border bg-sol-bg", className)} {...rest}>
      <div ref={titlebarRef} className="cc-page-head__row">
        <div className="flex min-w-0 items-center gap-2">
          {crumbs ? (
            <>
              <div className="flex shrink-0 items-center gap-1 text-ui text-sol-text-dim">{crumbs}</div>
              <ChevronRight className="size-3.5 shrink-0 text-sol-text-dim" aria-hidden />
            </>
          ) : null}
          {Icon ? <Icon className="size-4 shrink-0 text-sol-text-muted" aria-hidden /> : null}
          <h1 title={title} className="min-w-0 truncate text-read font-semibold text-sol-text">{title}</h1>
          {count != null && count !== "" ? (
            <span data-cc-page-count className="shrink-0 text-meta tabular-nums text-sol-text-dim">{count}</span>
          ) : null}
        </div>
        {tabs ? <div className="flex min-w-0 items-center gap-2">{tabs}</div> : null}
        {actions || share ? (
          <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
            {actions}
            {share}
          </div>
        ) : null}
      </div>
      {children ? <div className="cc-page-head__sub">{children}</div> : null}
    </header>
  );
}

type DataProps = { [key: `data-${string}`]: unknown };

/**
 * A page whose Classic header sits at the top of its own column. In Classic
 * and Minimal this is that page exactly: the scroller (`legacyScroll`, absent
 * when the shell scrolls the page) around the column (`legacyColumn`) that
 * opens with the header. In Modern the header is pinned above a scroller
 * that spans the pane, and the column (`column`) scrolls under it.
 */
export function PageFrame({ header, legacyScroll, legacyScrollProps, legacyColumn, legacyColumnProps, column, rootProps, children }: {
  /** A PageHeader: the page's own header in Classic, the bar in Modern. */
  header: ReactNode;
  legacyScroll?: string;
  legacyScrollProps?: DataProps;
  legacyColumn: string;
  legacyColumnProps?: DataProps;
  /** Modern: the column under the bar. */
  column: string;
  /** Modern: data attributes the page's root carries. */
  rootProps?: DataProps;
  children: ReactNode;
}) {
  if (useIsModernStyle()) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-sol-bg" {...rootProps}>
        {header}
        <div data-main-scroll className="min-h-0 flex-1 overflow-y-auto">
          <div className={column}>{children}</div>
        </div>
      </div>
    );
  }
  const page = (
    <div className={legacyColumn} {...legacyColumnProps}>
      {header}
      {children}
    </div>
  );
  return legacyScroll === undefined ? page : <div className={legacyScroll} {...legacyScrollProps}>{page}</div>;
}
