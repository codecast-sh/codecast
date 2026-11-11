"use client";

import { Fragment } from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { RAIL_MORE_EVENT, type PlaceCrumb } from "../../lib/navPlace";
import { cn } from "../../lib/utils";

// Where a page sits, as the Modern header draws it before the title: the
// section, then the container, each one a link (lib/navPlace). "More" has no
// page of its own: it opens the rail's More level, where the page lives.

const CRUMB = "min-w-0 max-w-[14rem] truncate rounded-[4px] text-ui text-sol-text-dim no-underline transition-colors hover:text-sol-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sol-cyan/60";

export function PlaceCrumbs({ crumbs, trailing = true }: { crumbs: PlaceCrumb[]; /** A chevron after the last crumb, before the title. */ trailing?: boolean }) {
  if (crumbs.length === 0) return null;
  return (
    <nav aria-label="Breadcrumb" data-cc-place-crumbs className="flex min-w-0 shrink items-center gap-1">
      {crumbs.map((c, i) => (
        <Fragment key={`${i}:${c.label}`}>
          {i > 0 && <ChevronRight className="size-3.5 shrink-0 text-sol-text-dim" aria-hidden />}
          {c.href ? (
            <Link href={c.href} className={cn(CRUMB, c.mono && "font-mono")} title={c.label} data-cc-crumb={c.href}>
              {c.label}
            </Link>
          ) : c.more ? (
            <button
              type="button"
              className={CRUMB}
              onClick={() => window.dispatchEvent(new CustomEvent(RAIL_MORE_EVENT))}
              title="Every other page"
              data-cc-crumb="more"
            >
              {c.label}
            </button>
          ) : (
            <span className={cn(CRUMB, c.mono && "font-mono")}>{c.label}</span>
          )}
        </Fragment>
      ))}
      {trailing && <ChevronRight className="size-3.5 shrink-0 text-sol-text-dim" aria-hidden />}
    </nav>
  );
}
