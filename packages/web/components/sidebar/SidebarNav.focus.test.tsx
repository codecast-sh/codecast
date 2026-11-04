import { expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { SidebarNavView, type SidebarNavActive } from "./SidebarNav";

// A solo account's rail (lib/railFocus.ts): focused, it keeps approvals,
// tasks and docs and ends on More; expanded, every row and a Fewer.
const ACTIVE: SidebarNavActive = {
  tasks: false, docs: false, code: false, files: false, pages: false,
  sessions: false, line: false, triggers: false, org: false, windows: false,
};
const shut = { items: [], expanded: false, onToggle: () => {} };

function rail(focused: boolean | null) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <SidebarNavView
        isNarrow={false}
        threads={<span>threads-row</span>}
        feed={<span>feed-row</span>}
        questions={<span>questions-row</span>}
        active={ACTIVE}
        tasks={shut}
        docs={shut}
        orgOn
        railMore={focused === null ? undefined : { focused, onToggle: () => {} }}
      />
    </MemoryRouter>,
  );
}

test("focused: approvals, tasks and docs, then More", () => {
  const html = rail(true);
  for (const kept of ["questions-row", 'href="/tasks"', 'href="/docs"', ">More<"]) expect(html).toContain(kept);
  for (const gone of ["threads-row", "feed-row", 'href="/goals"', 'href="/projects"', 'href="/org"', 'href="/repo"', 'href="/files"', 'href="/triggers"', 'href="/pages"']) expect(html).not.toContain(gone);
});

test("expanded: every row, and Fewer to fold them again", () => {
  const html = rail(false);
  for (const shown of ["threads-row", "feed-row", 'href="/projects"', 'href="/repo"', 'href="/triggers"', ">Fewer<"]) expect(html).toContain(shown);
});

test("everyone else gets no More/Fewer row at all", () => {
  const html = rail(null);
  expect(html).not.toContain("data-rail-more");
  expect(html).toContain('href="/projects"');
});
