import type { ComponentType, HTMLAttributes, ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { useTitlebarHead } from "../../hooks/useTitlebarHead";
import { useIsModernStyle } from "../../hooks/useVisualStyle";
import { cn } from "../../lib/utils";
import { crumbsForTitle } from "../../lib/navPlace";
import { usePlaceCrumbs } from "../../hooks/usePlace";
import { useIsListBesideItem } from "../../lib/detailSplitContext";
import { BackControl } from "../nav/BackControl";
import { PlaceCrumbs } from "../nav/PlaceCrumbs";
import { PageHeaderTitle } from "./page-header-title";
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
//
// Wayfinding: the row opens with the back control, which names where it goes
// (the trail's last step, else the page's parent), then the page's place as
// crumbs (Section › Parent), then the title. A person always knows where they
// are and how to get back to where they were.

export interface PageHeaderProps extends Omit<HTMLAttributes<HTMLElement>, "title" | "children"> {
  /** The page's own header, drawn instead of the bar in Classic and Minimal. */
  legacy: ReactNode;
  /** The page's name as the sidebar spells it (lib/navRegistry). */
  title: string;
  /** A 16px lucide icon before the title. */
  icon?: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  /** How many things the page shows, said quietly after the title. */
  count?: number | string | null;
  /** Where a detail page sits, before the title; the header draws the chevron.
   *  Left out, the header draws the page's place from its address
   *  (lib/navPlace): Section › Parent, each a link. */
  crumbs?: ReactNode;
  /** The page's views, normally a SegmentedToggle, after the title and count. */
  tabs?: ReactNode;
  /** Right-aligned controls: ui/button at size sm, icon buttons with aria-labels. */
  actions?: ReactNode;
  /** The share control, always the last thing on the right. */
  share?: ReactNode;
  /** A second row for filters or a search field. */
  children?: ReactNode;
  /** The way back, first in the row. Left out, the back control that names
   *  where it goes (components/nav/BackControl); false for none (a page drawn
   *  inside another page, which owns the way out). */
  back?: ReactNode | false;
  /** With no trail to walk back along, the parent Back goes up to, when the
   *  page knows it better than its address does. */
  backFallback?: { label: string; href: string } | null;
  /** In place of the icon: the object's own mark (a project's diamond, a face). */
  glyph?: ReactNode;
  /** The object's state, right after its name: a status chip or picker. */
  status?: ReactNode;
  /** Present when the viewer may rename the object: click the title to edit. */
  onRename?: (next: string) => void;
  renameLabel?: string;
  /** The title as the page draws it (its own rename field), in place of the h1. */
  titleNode?: ReactNode;
}

export function PageHeader({ legacy, ...props }: PageHeaderProps) {
  return useIsModernStyle() ? <PageHeaderBar {...props} /> : <>{legacy}</>;
}

/** The page's place from its address, minus any crumb the title already says. */
function AutoCrumbs({ title }: { title: string }) {
  return <PlaceCrumbs crumbs={crumbsForTitle(usePlaceCrumbs(), title)} />;
}

function PageHeaderBar({ title, icon: Icon, count, crumbs, tabs, actions, share, children, className, back, backFallback, glyph, status, onRename, renameLabel, titleNode, ...rest }: Omit<PageHeaderProps, "legacy">) {
  // The first row is the titlebar, not the whole header: it holds the side
  // padding the zen inset replaces, and it sits on the header's own surface.
  const titlebarRef = useTitlebarHead<HTMLDivElement>();
  // The list beside an open item leaves the way back to the item's header.
  const besideItem = useIsListBesideItem();
  return (
    <header data-cc-page-head className={cn("border-b border-sol-border bg-sol-bg", className)} {...rest}>
      <div ref={titlebarRef} className="cc-page-head__row">
        <div className="flex min-w-0 items-center gap-2">
          {back === undefined ? (besideItem ? null : <BackControl fallback={backFallback} divider />) : back || null}
          {crumbs === undefined ? (
            <AutoCrumbs title={title} />
          ) : crumbs ? (
            <>
              <div className="flex shrink-0 items-center gap-1 text-ui text-sol-text-dim">{crumbs}</div>
              <ChevronRight className="size-3.5 shrink-0 text-sol-text-dim" aria-hidden />
            </>
          ) : null}
          {glyph ? <span className="inline-flex shrink-0 items-center">{glyph}</span> : Icon ? <Icon className="size-4 shrink-0 text-sol-text-muted" aria-hidden /> : null}
          {titleNode ?? <PageHeaderTitle title={title} onRename={onRename} renameLabel={renameLabel} />}
          {status ? <div data-cc-page-status className="flex shrink-0 items-center gap-1.5">{status}</div> : null}
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
