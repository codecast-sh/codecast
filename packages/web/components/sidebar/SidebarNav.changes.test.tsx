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

// The slice of the rail inside one data-rail-group, up to the next group or the More toggle.
function group(html: string, name: string) {
  const from = html.indexOf(`data-rail-group="${name}"`);
  if (from < 0) return "";
  const rest = html.slice(from + 1);
  const stops = [rest.indexOf("data-rail-group="), rest.indexOf("data-rail-more")].filter((i) => i >= 0);
  return rest.slice(0, stops.length ? Math.min(...stops) : undefined);
}

test("Inbox leads the six daily rows, with no section headings over the rail", () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <SidebarNavView
        isNarrow={false}
        feed={<span>feed-row</span>}
        questions={<span>questions-row</span>}
        chat={<span>chat-row</span>}
        calls={<span>calls-row</span>}
        active={ACTIVE}
        tasks={shut}
        docs={shut}
        orgOn
      />
    </MemoryRouter>,
  );
  expect(html).not.toContain("data-rail-heading");
  const primary = group(html, "primary");
  const order = ['href="/inbox"', "questions-row", "chat-row", 'href="/tasks"', 'href="/docs"', "calls-row"].map((m) => primary.indexOf(m));
  for (const i of order) expect(i).toBeGreaterThan(-1);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  expect(primary).not.toContain("feed-row");
  for (const href of ["/org", "/repo", "/files", "/pages", "/flows", "/ops", "/windows", "/triggers"]) expect(group(html, "more")).toContain(`href="${href}"`);
});

test("the Inbox row lights on /inbox", () => {
  const current = (h: string) => [...h.matchAll(/aria-current="page"[^>]*>(?:<[^>]+>)*([^<]+)</g)].map((m) => m[1]);
  expect(current(rail(false))).toEqual([]);
  expect(current(rail(false, { ...ACTIVE, inbox: true }))).toEqual(["Inbox"]);
});

test("the Work window's rail keeps only Tasks and Docs up top", () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <SidebarNavView isNarrow={false} scope="work" questions={<span>questions-row</span>} chat={<span>chat-row</span>} calls={<span>calls-row</span>} active={ACTIVE} tasks={shut} docs={shut} orgOn />
    </MemoryRouter>,
  );
  const primary = group(html, "primary");
  expect(primary).toContain('href="/tasks"');
  expect(primary).toContain('href="/docs"');
  for (const gone of ['href="/inbox"', "questions-row", "chat-row", "calls-row"]) expect(html).not.toContain(gone);
});

test("Ops is a row under More, lit on /ops", () => {
  const view = (active: SidebarNavActive) => renderToStaticMarkup(
    <MemoryRouter>
      <SidebarNavView isNarrow={false} active={active} tasks={shut} docs={shut} orgOn />
    </MemoryRouter>,
  );
  const html = view(ACTIVE);
  expect(group(html, "more")).toContain('href="/ops"');
  expect(group(html, "primary")).not.toContain('href="/ops"');
  const current = (h: string) => [...h.matchAll(/aria-current="page"[^>]*>(?:<[^>]+>)*([^<]+)</g)].map((m) => m[1]);
  expect(current(view({ ...ACTIVE, ops: true }))).toEqual(["Ops"]);
});

test("Goals, Projects and Org sit under More in that order, Org with its count and no rows nested under it", () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <SidebarNavView isNarrow={false} active={ACTIVE} tasks={shut} docs={shut} orgOn orgBadge={<span data-org-count>4</span>} />
    </MemoryRouter>,
  );
  const more = group(html, "more");
  const goals = more.indexOf('href="/goals"');
  const projects = more.indexOf('href="/projects"');
  const org = more.indexOf('href="/org"');
  const code = more.indexOf('href="/repo"');
  expect(goals).toBeGreaterThan(-1);
  expect(projects).toBeGreaterThan(goals);
  expect(org).toBeGreaterThan(projects);
  expect(code).toBeGreaterThan(org);
  expect(more).toContain("data-org-count");
  expect(more.slice(org, code)).not.toContain("data-nav-subrow");
  expect(group(html, "primary")).not.toContain('href="/org"');
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

test("Org and Flows rows: on shows them, a team that never decided sees them unmarked, a team that turned them off sees neither", () => {
  const view = (orgOn: boolean, offers: { org?: boolean; line?: boolean }, flowsOn: boolean) => renderToStaticMarkup(
    <MemoryRouter>
      <SidebarNavView isNarrow={false} active={ACTIVE} tasks={shut} docs={shut} orgOn={orgOn} offers={offers} flowsOn={flowsOn} orgBadge={<span data-org-count>4</span>} />
    </MemoryRouter>,
  );
  const off = view(false, {}, false);
  expect(off).not.toContain('href="/org"');
  expect(off).not.toContain('href="/flows"');
  const offered = view(false, { org: true, line: true }, false);
  expect(offered).toContain('href="/org"');
  expect(offered).toContain('href="/flows"');
  // No NEW marks anymore, and the count waits until the team turns Org on.
  expect(offered).not.toContain(">NEW<");
  expect(offered).not.toContain("data-org-count");
  const on = view(true, {}, true);
  expect(on).toContain('href="/org"');
  expect(on).toContain('href="/flows"');
  expect(on).toContain("data-org-count");
});
