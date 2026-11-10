// The tab bar's markup, frozen across its extraction from the pull request
// page (heroFly/ARCHITECTURE.md section 3): the reference below is the nav as
// it stood inline in app/pr/[owner]/[repo]/[number]/page.tsx.

import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import Link from "next/link";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { prViewHref, type PrView } from "../../lib/prView";
import { PR_TABS, TAB_BAR_PX } from "./prTabs";
import { PRTabBar } from "./PRTabBar";

type Case = { tab: PrView; files: unknown[]; notes: unknown[]; pr: any; pastHeader: boolean };

function InlineNav({ tab, files, notes, pr, pastHeader }: Case) {
  const repository = "acme/billing";
  const number = 482;
  const family = "app" as const;
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
          {key === "files" && files.length > 0 && (
            <span className="text-[11px] text-sol-text-dim">{files.length}</span>
          )}
          {key === "files" && notes.length > 0 && (
            <span className="rounded-full border border-dashed border-sol-yellow/60 px-1.5 text-[10px] text-sol-yellow" title="Notes in your review, not sent yet">
              {notes.length}
            </span>
          )}
          {key === "commits" && (pr.commits_count ?? pr.commits?.length ?? 0) > 0 && (
            <span className="text-[11px] text-sol-text-dim">{pr.commits_count ?? pr.commits.length}</span>
          )}
          {key === "checks" && (pr.checks?.length ?? 0) > 0 && (
            <span className="text-[11px] text-sol-text-dim">{pr.checks.length}</span>
          )}
          <span className="pr-tab-key opacity-0 group-hover:opacity-100 transition-opacity">
            <KeyCap size="xs">{digit}</KeyCap>
          </span>
        </Link>
      ))}
      <button
        type="button"
        className={`pr-mini-title ml-auto min-w-0 truncate pb-2.5 pl-4 text-left text-[12px] text-sol-text-muted hover:text-sol-text transition-opacity duration-200 ${pastHeader ? "opacity-100" : "opacity-0 pointer-events-none"}`}
        aria-hidden={!pastHeader}
        tabIndex={pastHeader ? 0 : -1}
        title="Back to the top"
      >
        <span className="font-mono text-sol-text-dim">#{number}</span> {pr.title}
      </button>
    </nav>
  );
}

const cases: [string, Case][] = [
  ["conversation, empty", { tab: "conversation", files: [], notes: [], pr: { title: "Retry webhooks" }, pastHeader: false }],
  ["files with notes, past header", { tab: "files", files: [1, 2, 3], notes: [1], pr: { title: "Retry webhooks", commits: [1, 2] }, pastHeader: true }],
  ["checks, counted commits", { tab: "checks", files: [1], notes: [], pr: { title: "Retry webhooks", commits_count: 7, checks: [1, 2, 3, 4] }, pastHeader: false }],
];

for (const [name, c] of cases) {
  test(`PRTabBar matches the inline nav: ${name}`, () => {
    const view = (
      <PRTabBar
        repository="acme/billing" number={482} title={c.pr.title} tab={c.tab} family="app"
        filesCount={c.files.length} notesCount={c.notes.length}
        commitsCount={c.pr.commits_count ?? c.pr.commits?.length ?? 0} checksCount={c.pr.checks?.length ?? 0}
        pastHeader={c.pastHeader}
      />
    );
    const html = (el: React.ReactElement) => renderToStaticMarkup(<MemoryRouter>{el}</MemoryRouter>);
    expect(html(view)).toBe(html(<InlineNav {...c} />));
  });
}
