import { expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { SidebarNavView, type SidebarNavActive } from "./SidebarNav";
import { surfaceMode, type SurfaceMode } from "../../lib/surfaceRules";

// Changes is a per-team opt-in (teams.features.changes): with the flag off
// the rail has no Changes row at all, and with it on the row sits under Feed.
const ACTIVE: SidebarNavActive = {
  initiatives: false, projects: false, tasks: false, docs: false, code: false, files: false, pages: false,
  sessions: false, workflows: false, line: false, triggers: false, org: false, rootAgent: false, windows: false,
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
        projects={shut}
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
  for (const href of ["/changes", "/projects", "/repo", "/files", "/line", "/ops", "/windows", "/routines"]) expect(html).not.toContain(`href="${href}"`);
  for (const href of ["/tasks", "/docs", "/pages", "/triggers", "/goals"]) expect(html).toContain(`href="${href}"`);
  expect(html).toContain("Routines");
  expect(html).toContain("Assistant");
  expect(html).not.toContain(">Triggers<");
  // Developer mode, the default, keeps them all.
  for (const href of ["/projects", "/repo", "/files", "/line", "/ops", "/windows", "/routines"]) expect(rail(false)).toContain(`href="${href}"`);
});
