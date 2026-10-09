import { expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { SidebarNavView, orgRowsActive, type SidebarNavActive } from "./SidebarNav";
import { surfaceMode, type SurfaceMode } from "../../lib/surfaceRules";

// Changes is a per-team opt-in (teams.features.changes): with the flag off
// the rail has no Changes row at all, and with it on the row sits under Feed.
const ACTIVE: SidebarNavActive = {
  tasks: false, docs: false, code: false, files: false, pages: false,
  sessions: false, line: false, triggers: false, org: false, rootAgent: false, windows: false,
};
const shut = { items: [], expanded: false, onToggle: () => {} };

function rail(changesOn: boolean | undefined, active: SidebarNavActive = ACTIVE, mode?: SurfaceMode) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <SidebarNavView
        isNarrow={false}
        inbox={<span>inbox-row</span>}
        feed={<span>feed-row</span>}
        questions={<span>questions-row</span>}
        active={active}
        openPath={() => {}}
        tasks={shut}
        docs={shut}
        orgOn={false}
        changesOn={changesOn}
        agent={{ label: "Agent", title: "Agent", icon: <span /> }}
        mode={mode}
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
  const questions = html.indexOf("questions-row");
  expect(feed).toBeLessThan(changes);
  expect(changes).toBeLessThan(questions);
});

test("the row reads as active on /changes", () => {
  const off = rail(true);
  const on = rail(true, { ...ACTIVE, changes: true });
  const row = (html: string) => html.slice(html.indexOf('href="/changes"') - 400, html.indexOf('href="/changes"') + 400);
  expect(row(on)).not.toEqual(row(off));
});

test("hosted mode keeps the everyday rows and drops the developer ones", () => {
  const html = rail(true, ACTIVE, surfaceMode(true, true));
  for (const href of ["/changes", "/org", "/repo", "/files", "/pages", "/line", "/ops", "/windows", "/routines"]) expect(html).not.toContain(`href="${href}"`);
  for (const href of ["/tasks", "/docs", "/triggers"]) expect(html).toContain(`href="${href}"`);
  expect(html).toContain("Routines");
  expect(html).not.toContain(">Triggers<");
  // Developer mode, the default, keeps them all.
  for (const href of ["/org", "/repo", "/files", "/pages", "/line", "/ops", "/windows"]) expect(rail(false)).toContain(`href="${href}"`);
});

test("Org is the first Work row, with its count and its two read views always under it; no project rows, no chevron, and no Org under Agents", () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <SidebarNavView isNarrow={false} inbox={<span>inbox-row</span>} active={ACTIVE} openPath={() => {}} tasks={shut} docs={shut} orgOn orgBadge={<span data-org-count>4</span>} agent={{ label: "Agent", title: "Agent", icon: <span /> }} />
    </MemoryRouter>,
  );
  const work = html.slice(html.indexOf('data-rail-heading="Work"'), html.indexOf('data-rail-heading="Agents"'));
  const org = work.indexOf('href="/org"');
  const tasks = work.indexOf('href="/tasks"');
  expect(org).toBeGreaterThan(0);
  expect(org).toBeLessThan(tasks);
  expect(work).toContain("data-org-count");
  // Goals then Projects, between Org and Tasks, shown without opening anything.
  const goals = work.indexOf(">Goals<");
  const projects = work.indexOf(">Projects<");
  expect(goals).toBeGreaterThan(org);
  expect(projects).toBeGreaterThan(goals);
  expect(projects).toBeLessThan(tasks);
  const orgBlock = work.slice(org, tasks);
  expect(orgBlock).not.toContain("aria-expanded");
  expect(orgBlock.match(/data-nav-subrow/g)?.length).toBe(2);
  const agents = html.slice(html.indexOf('data-rail-heading="Agents"'));
  expect(agents).not.toContain('href="/org"');
  expect(agents).toContain('href="/anchor"');
});

test("each read view lights its own row, not Org's", () => {
  const html = (active: SidebarNavActive) => renderToStaticMarkup(
    <MemoryRouter>
      <SidebarNavView isNarrow={false} inbox={<span />} active={active} openPath={() => {}} tasks={shut} docs={shut} orgOn agent={{ label: "Agent", title: "Agent", icon: <span /> }} />
    </MemoryRouter>,
  );
  const current = (h: string) => [...h.matchAll(/aria-current="page"[^>]*>(?:<[^>]+>)*([^<]+)</g)].map((m) => m[1]);
  expect(current(html({ ...ACTIVE, orgGoals: true }))).toEqual(["Goals"]);
  expect(current(html({ ...ACTIVE, orgProjects: true }))).toEqual(["Projects"]);
  expect(current(html({ ...ACTIVE, org: true }))).toEqual([]);
});

test("a pathname lights the right Org row; a project's board keeps Projects lit", () => {
  const lit = (p: string) => Object.entries(orgRowsActive(p)).filter(([, on]) => on).map(([k]) => k);
  expect(lit("/org")).toEqual(["org"]);
  expect(lit("/org/in-2")).toEqual(["org"]);
  expect(lit("/org/goals")).toEqual(["orgGoals"]);
  expect(lit("/org/goals/in-2")).toEqual(["orgGoals"]);
  expect(lit("/org/projects")).toEqual(["orgProjects"]);
  expect(lit("/projects/pj-1")).toEqual(["orgProjects"]);
  expect(lit("/organization")).toEqual([]);
  expect(lit("/tasks")).toEqual([]);
});

test("Org's views are inert in the narrow rail, where only icons show", () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <SidebarNavView isNarrow inbox={<span />} active={ACTIVE} openPath={() => {}} tasks={shut} docs={shut} orgOn agent={{ label: "Agent", title: "Agent", icon: <span /> }} />
    </MemoryRouter>,
  );
  expect(html).toContain('href="/org"');
  expect(html).not.toContain(">Goals<");
});
