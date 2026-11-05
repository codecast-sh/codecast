import { expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { SidebarNavView, orgRowsActive, type SidebarNavActive } from "./SidebarNav";

// Changes is a per-team opt-in (teams.features.changes): with the flag off
// the rail has no Changes row at all, and with it on the row sits under Feed.
const ACTIVE: SidebarNavActive = {
  tasks: false, docs: false, code: false, files: false, pages: false,
  sessions: false, line: false, triggers: false, org: false, windows: false,
};
const shut = { items: [], expanded: false, onToggle: () => {} };

function rail(changesOn: boolean | undefined, active: SidebarNavActive = ACTIVE) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <SidebarNavView
        isNarrow={false}
        feed={<span>feed-row</span>}
        questions={<span>questions-row</span>}
        active={active}
        tasks={shut}
        docs={shut}
        orgOn
        changesOn={changesOn}
      />
    </MemoryRouter>,
  );
}

test("no Changes row unless the active team has the flag on", () => {
  expect(rail(false)).not.toContain('href="/changes"');
  expect(rail(undefined)).not.toContain('href="/changes"');
});

test("with the flag on the Changes row sits right under Feed", () => {
  const html = rail(true);
  expect(html).toContain('href="/changes"');
  const feed = html.indexOf("feed-row");
  const changes = html.indexOf('href="/changes"');
  const ops = html.indexOf('href="/ops"');
  expect(feed).toBeLessThan(changes);
  expect(changes).toBeLessThan(ops);
});

test("the row reads as active on /changes", () => {
  const off = rail(true);
  const on = rail(true, { ...ACTIVE, changes: true });
  const row = (html: string) => html.slice(Math.max(0, html.indexOf('href="/changes"') - 400), html.indexOf('href="/changes"') + 400);
  expect(row(on)).not.toEqual(row(off));
});

test("no Inbox row and no heading over the conversation rows", () => {
  const html = rail(true);
  expect(html).not.toContain('data-nav-page="/inbox"');
  expect(html).not.toContain('data-rail-heading="Conversations"');
  expect(html.indexOf("feed-row")).toBeLessThan(html.indexOf('data-rail-heading="Work"'));
  for (const href of ["/org", "/repo", "/files", "/pages", "/flows", "/ops", "/windows", "/triggers"]) expect(html).toContain(`href="${href}"`);
});

test("Ops is a top-level row outside the Agents group, lit on /ops", () => {
  const view = (active: SidebarNavActive) => renderToStaticMarkup(
    <MemoryRouter>
      <SidebarNavView isNarrow={false} active={active} tasks={shut} docs={shut} orgOn />
    </MemoryRouter>,
  );
  const html = view(ACTIVE);
  expect(html.indexOf('href="/ops"')).toBeGreaterThan(-1);
  expect(html.indexOf('href="/ops"')).toBeLessThan(html.indexOf('data-rail-heading="Work"'));
  expect(html.slice(html.indexOf('data-rail-heading="Agents"'))).not.toContain('href="/ops"');
  const current = (h: string) => [...h.matchAll(/aria-current="page"[^>]*>(?:<[^>]+>)*([^<]+)</g)].map((m) => m[1]);
  expect(current(view({ ...ACTIVE, ops: true }))).toEqual(["Ops"]);
});

test("Org is the first Work row, with its count and its two read views always under it; no project rows, no chevron, and no Org under Agents", () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <SidebarNavView isNarrow={false} active={ACTIVE} tasks={shut} docs={shut} orgOn orgBadge={<span data-org-count>4</span>} />
    </MemoryRouter>,
  );
  const work = html.slice(html.indexOf('data-rail-heading="Work"'), html.indexOf('data-rail-heading="Agents"'));
  const org = work.indexOf('href="/org"');
  const tasks = work.indexOf('href="/tasks"');
  expect(org).toBeGreaterThan(0);
  expect(org).toBeLessThan(tasks);
  expect(work).toContain("data-org-count");
  // Goals and Projects are rows of their own above Org, never nested in it.
  const goals = work.indexOf('href="/goals"');
  const projects = work.indexOf('href="/projects"');
  expect(goals).toBeGreaterThan(0);
  expect(projects).toBeGreaterThan(goals);
  expect(org).toBeGreaterThan(projects);
  expect(work.slice(org, tasks)).not.toContain("data-nav-subrow");
  const agents = html.slice(html.indexOf('data-rail-heading="Agents"'));
  expect(agents).not.toContain('href="/org"');
  // The workspace's agent is a role in Org, reached through the chart or a header pin, never a rail row.
  expect(html).not.toContain('href="/anchor"');
});

test("Goals, Projects and Org each light their own row", () => {
  const html = (active: SidebarNavActive) => renderToStaticMarkup(
    <MemoryRouter>
      <SidebarNavView isNarrow={false} active={active} tasks={shut} docs={shut} orgOn />
    </MemoryRouter>,
  );
  const current = (h: string) => [...h.matchAll(/aria-current="page"[^>]*>(?:<[^>]+>)*([^<]+)</g)].map((m) => m[1]);
  expect(current(html({ ...ACTIVE, goals: true }))).toEqual(["Goals"]);
  expect(current(html({ ...ACTIVE, projects: true }))).toEqual(["Projects"]);
  expect(current(html({ ...ACTIVE, org: true }))).toEqual(["Org"]);
});

test("a pathname lights the right row; a project's board keeps Projects lit", () => {
  const lit = (p: string) => Object.entries(orgRowsActive(p)).filter(([, on]) => on).map(([k]) => k);
  expect(lit("/org")).toEqual(["org"]);
  expect(lit("/org/in-2")).toEqual(["org"]);
  expect(lit("/goals")).toEqual(["goals"]);
  expect(lit("/goals/in-2")).toEqual(["goals"]);
  expect(lit("/projects")).toEqual(["projects"]);
  expect(lit("/projects/pj-1")).toEqual(["projects"]);
  expect(lit("/organization")).toEqual([]);
  expect(lit("/tasks")).toEqual([]);
});

test("the narrow rail shows Goals, Projects and Org as icons", () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <SidebarNavView isNarrow active={ACTIVE} tasks={shut} docs={shut} orgOn />
    </MemoryRouter>,
  );
  for (const href of ["/goals", "/projects", "/org"]) expect(html).toContain(`href="${href}"`);
});

test("Org and Flows rows: on shows them, a team that never decided sees them marked new, a team that turned them off sees neither", () => {
  const view = (orgOn: boolean, offers: { org?: boolean; line?: boolean }, flowsOn: boolean) => renderToStaticMarkup(
    <MemoryRouter>
      <SidebarNavView isNarrow={false} active={ACTIVE} tasks={shut} docs={shut} orgOn={orgOn} offers={offers} flowsOn={flowsOn} />
    </MemoryRouter>,
  );
  const off = view(false, {}, false);
  expect(off).not.toContain('href="/org"');
  expect(off).not.toContain('href="/flows"');
  const offered = view(false, { org: true, line: true }, false);
  expect(offered).toContain('href="/org"');
  expect(offered).toContain('href="/flows"');
  expect(offered.match(/data-feature-new/g)?.length).toBe(2);
  const on = view(true, {}, true);
  expect(on).toContain('href="/org"');
  expect(on).toContain('href="/flows"');
  expect(on).not.toContain("data-feature-new");
});
