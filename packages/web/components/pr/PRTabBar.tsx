import Link from "next/link";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { prViewHref, type PrView } from "../../lib/prView";
import type { RepoRouteFamily } from "../../lib/repoView";
import { PR_TABS, TAB_BAR_PX } from "./prTabs";

// The pull request page's tab bar: one tab per view with its count, the
// number key that opens it, and, once the header has scrolled away, the
// title that takes the reader back to the top.

export function PRTabBar({ repository, number, title, tab, family, filesCount, notesCount, commitsCount, checksCount, pastHeader, onTop }: {
  repository: string;
  number: number;
  title: string;
  tab: PrView;
  family?: RepoRouteFamily;
  filesCount: number;
  notesCount: number;
  commitsCount: number;
  checksCount: number;
  /** The header has gone up: the bar names the pull request. */
  pastHeader: boolean;
  onTop?: () => void;
}) {
  return (
    <nav
      aria-label="Pull request views"
      className="pr-tabs sticky top-0 z-30 flex items-end gap-1 border-b border-sol-border/60 bg-sol-bg/95 backdrop-blur px-4 overflow-x-auto"
      style={{ height: TAB_BAR_PX }}
    >
      {PR_TABS.map(({ key, label, icon: Icon, digit }) => (
        <Link
          key={key}
          href={prViewHref(repository, number, key, family)}
          aria-current={tab === key ? "page" : undefined}
          className={`group flex items-center gap-2 border-b-2 px-3 pb-2 pt-2.5 text-[12px] whitespace-nowrap transition-colors ${
            tab === key
              ? "border-current text-sol-text"
              : "border-transparent text-sol-text-muted hover:text-sol-text"
          }`}
          style={tab === key ? { color: "var(--pr-accent)" } : undefined}
        >
          <Icon className="pr-tab-icon w-3.5 h-3.5" />
          {label}
          {key === "files" && filesCount > 0 && (
            <span className="text-[11px] text-sol-text-dim">{filesCount}</span>
          )}
          {key === "files" && notesCount > 0 && (
            <span className="rounded-full border border-dashed border-sol-yellow/60 px-1.5 text-[10px] text-sol-yellow" title="Notes in your review, not sent yet">
              {notesCount}
            </span>
          )}
          {key === "commits" && commitsCount > 0 && (
            <span className="text-[11px] text-sol-text-dim">{commitsCount}</span>
          )}
          {key === "checks" && checksCount > 0 && (
            <span className="text-[11px] text-sol-text-dim">{checksCount}</span>
          )}
          <span className="pr-tab-key opacity-0 group-hover:opacity-100 transition-opacity">
            <KeyCap size="xs">{digit}</KeyCap>
          </span>
        </Link>
      ))}
      <button
        type="button"
        onClick={onTop}
        className={`pr-mini-title ml-auto min-w-0 truncate pb-2.5 pl-4 text-left text-[12px] text-sol-text-muted hover:text-sol-text transition-opacity duration-200 ${pastHeader ? "opacity-100" : "opacity-0 pointer-events-none"}`}
        aria-hidden={!pastHeader}
        tabIndex={pastHeader ? 0 : -1}
        title="Back to the top"
      >
        <span className="font-mono text-sol-text-dim">#{number}</span> {title}
      </button>
    </nav>
  );
}
