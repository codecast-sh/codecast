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
  for (const gone of ["threads-row", "feed-row", 'href="/goals"', 'href="/projects"', 'href="/org"', 'href="/repo"', 'href="/files"', 'href="/triggers"', 'href="/pages"', 'href="/deploys"', 'href="/ops"', 'href="/vault"']) expect(html).not.toContain(gone);
});

test("expanded: every row, and Fewer to fold them again", () => {
  const html = rail(false);
  for (const shown of ["threads-row", "feed-row", 'href="/projects"', 'href="/repo"', 'href="/triggers"', 'href="/deploys"', 'href="/ops"', 'href="/vault"', ">Fewer<"]) expect(html).toContain(shown);
});

test("everyone else gets no More/Fewer row at all", () => {
  const html = rail(null);
  expect(html).not.toContain("data-rail-more");
  expect(html).toContain('href="/projects"');
});

// The switcher heads a block holding every row a switch changes (its content,
// or whether the team has it on); the rows that ignore the switch sit outside.
test("workspace block: team rows inside, every-workspace rows outside", () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <SidebarNavView
        isNarrow={false}
        threads={<span>threads-row</span>}
        feed={<span>feed-row</span>}
        questions={<span>questions-row</span>}
        calls={<span>calls-row</span>}
        active={ACTIVE}
        tasks={shut}
        docs={shut}
        orgOn
        workspaceHeader={<span>switcher</span>}
        workspaceColor="blue"
      />
    </MemoryRouter>,
  );
  const start = html.indexOf("data-rail-workspace");
  const end = html.indexOf('data-rail-group="agents"');
  const inBlock = (m: string) => { const i = html.indexOf(m); return i > start && i < end; };
  expect(start).toBeGreaterThan(-1);
  expect(html.indexOf("switcher")).toBeGreaterThan(start);
  for (const m of ["threads-row", "feed-row", "calls-row", 'href="/flows"', 'href="/ops"', 'href="/tasks"', 'href="/docs"', 'href="/projects"', 'href="/vault"']) expect(inBlock(m)).toBe(true);
  for (const m of ["questions-row", 'href="/files"', 'href="/windows"', 'href="/triggers"']) expect(inBlock(m)).toBe(false);
});
