import { expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { SidebarNavView, type SidebarNavActive } from "./SidebarNav";

// The rail's More group (lib/railFocus.ts): six daily rows lead for everyone,
// and a More toggle folds or opens every other page beneath them.
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
        chat={<span>chat-row</span>}
        calls={<span>calls-row</span>}
        active={ACTIVE}
        tasks={shut}
        docs={shut}
        orgOn
        railMore={focused === null ? undefined : { focused, onToggle: () => {} }}
      />
    </MemoryRouter>,
  );
}

const MORE_ROWS = ["threads-row", "feed-row", 'href="/deploys"', 'href="/flows"', 'href="/ops"', 'href="/goals"', 'href="/projects"', 'href="/org"', 'href="/repo"', 'href="/vault"', 'href="/pages"', 'href="/triggers"', 'href="/windows"', 'href="/files"'];

test("folded: the six daily rows, then a closed More", () => {
  const html = rail(true);
  for (const kept of ['href="/inbox"', "questions-row", "chat-row", 'href="/tasks"', 'href="/docs"', "calls-row", ">More<"]) expect(html).toContain(kept);
  expect(html).toMatch(/aria-expanded="false"[^>]*data-rail-more/);
  expect(html).not.toContain('data-rail-group="more"');
  for (const gone of MORE_ROWS) expect(html).not.toContain(gone);
});

test("open: every other page in the More group, in order, below the toggle", () => {
  const html = rail(false);
  expect(html).toMatch(/aria-expanded="true"[^>]*data-rail-more/);
  expect(html).not.toContain(">Fewer<");
  const more = html.indexOf('data-rail-group="more"');
  expect(more).toBeGreaterThan(html.indexOf("data-rail-more"));
  const at = MORE_ROWS.map((m) => html.indexOf(m, more));
  for (const i of at) expect(i).toBeGreaterThan(more);
  expect([...at].sort((a, b) => a - b)).toEqual(at);
});

test("with no More control (the marketing hero) every row shows and there is no toggle", () => {
  const html = rail(null);
  expect(html).not.toContain("data-rail-more");
  expect(html).toContain('data-rail-group="more"');
  expect(html).toContain('href="/projects"');
});

// The switcher sits on top on its own, unboxed: no bordered block holds the
// rows, which start in the primary group right after it.
test("workspace switcher: a plain wrapper above the primary rows", () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <SidebarNavView
        isNarrow={false}
        questions={<span>questions-row</span>}
        active={ACTIVE}
        tasks={shut}
        docs={shut}
        orgOn
        workspaceHeader={<span>switcher</span>}
      />
    </MemoryRouter>,
  );
  const start = html.indexOf("data-rail-workspace");
  const primary = html.indexOf('data-rail-group="primary"');
  expect(start).toBeGreaterThan(-1);
  expect(start).toBeLessThan(primary);
  const wrapper = html.slice(start, primary);
  expect(wrapper).toContain("switcher");
  expect(wrapper).not.toContain("border");
  for (const m of ['href="/inbox"', "questions-row", 'href="/tasks"']) expect(wrapper).not.toContain(m);
});
