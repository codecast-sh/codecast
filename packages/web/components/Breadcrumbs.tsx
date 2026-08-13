"use client";
/**
 * The trail that says where you are and what contains it: Projects › Codecast ›
 * ct-4102. It exists because surfaces now nest — a task opened inside a project
 * is still inside that project — and the trail is what makes that legible and
 * what tells you where "back" goes.
 *
 * Every crumb but the last is a link. The last is where you are, so it renders
 * as plain text and carries no href; it also truncates first, since the crumbs
 * before it are short names and the leaf is usually a long title.
 */
import { ReactNode } from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";

export type Crumb = {
  label: string;
  /** Rendered before the label, dimmed and monospaced — a handle to read and
   *  copy, deliberately not competing with the name for attention. */
  shortId?: string;
  href?: string;
  icon?: ReactNode;
  /** Rendered after the label — a star, an overflow menu. Leaf crumb only. */
  trailing?: ReactNode;
};

export function Breadcrumbs({ items, className = "" }: { items: Crumb[]; className?: string }) {
  const visible = items.filter(Boolean);
  if (visible.length === 0) return null;
  return (
    <nav aria-label="Breadcrumb" className={`flex items-center gap-1 min-w-0 text-sm ${className}`}>
      {visible.map((crumb, i) => {
        const isLast = i === visible.length - 1;
        const body = (
          <>
            {crumb.icon}
            {crumb.shortId && (
              <span className="font-mono text-xs text-sol-text-dim flex-shrink-0">{crumb.shortId}</span>
            )}
            <span className={isLast ? "truncate" : "truncate max-w-[14rem]"}>{crumb.label}</span>
          </>
        );
        return (
          <div key={`${crumb.label}-${i}`} className={`flex items-center gap-1 min-w-0 ${isLast ? "" : "flex-shrink-0"}`}>
            {i > 0 && (
              <ChevronRight className="w-3.5 h-3.5 flex-shrink-0 text-sol-text-dim/60" aria-hidden />
            )}
            {crumb.href && !isLast ? (
              <Link
                href={crumb.href}
                className="flex items-center gap-1.5 min-w-0 px-1 py-0.5 -mx-1 rounded text-sol-text-dim hover:text-sol-text hover:bg-sol-bg-highlight/60 transition-colors"
              >
                {body}
              </Link>
            ) : (
              <span className="flex items-center gap-1.5 min-w-0 text-sol-text font-medium">{body}</span>
            )}
            {isLast && crumb.trailing}
          </div>
        );
      })}
    </nav>
  );
}
