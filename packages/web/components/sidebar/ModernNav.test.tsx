import { expect, test } from "bun:test";
import React from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { ModernNavView, RegistryNavSection } from "./ModernNav";
import { MoreDrillList } from "./MoreNav";
import { NAV_REGISTRY, navActiveId, navRowsIn, type NavGates, type NavId } from "../../lib/navRegistry";

// The Modern rail (interface style "Modern"), drawn from lib/navRegistry:
// Inbox, Decisions and Threads unheaded at the top, then Team, Work,
// Automation and Code & Ops, then More, a level of its own. Live rows come in
// as elements; the rest are drawn from the registry under the gate each had
// in the classic rail.
const shut = { items: [], expanded: false, onToggle: () => {} };
const ALL: NavGates = { chat: true, calls: true, changes: true, org: true, line: true, team: true, staff: true };

function rail(over: Partial<React.ComponentProps<typeof ModernNavView>> = {}) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <ModernNavView
        isNarrow={false}
        live={{
          inbox: <span>inbox-row</span>,
          decisions: <span>decisions-row</span>,
          threads: <span>threads-row</span>,
          chat: <span>chat-row</span>,
          calls: <span>calls-row</span>,
          activity: <RegistryNavSection id="activity" isActive={false} isNarrow={false} />,
        }}
        activeId={null}
        gates={ALL}
        tasks={shut}
        docs={shut}
        {...over}
      />
    </MemoryRouter>,
  );
}

function more(props: Partial<React.ComponentProps<typeof MoreDrillList>> = {}) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <MoreDrillList activeId={null} gates={ALL} focused={false} {...props} />
    </MemoryRouter>,
  );
}

/** The labels of the rows marked as the page you are on. */
const current = (h: string) => [...h.matchAll(/aria-current="page"[^>]*>(?:<[^>]+>)*([^<]+)</g)].map((m) => m[1]);

/** A heading's slice of the markup, up to the next heading or More. */
function groupOf(html: string, heading: string): string {
  const start = html.indexOf(`data-rail-heading="${heading}"`);
  expect(start).toBeGreaterThan(-1);
  const ends = [html.indexOf("data-rail-heading=", start + 1), html.indexOf("data-rail-more", start)].filter((i) => i > -1);
  return html.slice(start, ends.length ? Math.min(...ends) : undefined);
}

function inOrder(html: string, marks: string[]) {
  const at = marks.map((m) => html.indexOf(m));
  expect(at.every((i) => i > -1)).toBe(true);
  expect([...at].sort((a, b) => a - b)).toEqual(at);
}

test("Inbox leads the rail, then Decisions and Threads, with no heading over them", () => {
  const html = rail();
  inOrder(html, ["inbox-row", "decisions-row", "threads-row", 'data-rail-heading="Team"']);
  expect(html.slice(0, html.indexOf("threads-row"))).not.toContain("data-rail-heading");
});

test("the groups come in order, Team, Work, Automation, Code & Ops, then More", () => {
  const html = rail();
  inOrder(html, ['data-rail-heading="Team"', 'data-rail-heading="Work"', 'data-rail-heading="Automation"', 'data-rail-heading="Code &amp; Ops"', "data-rail-more"]);
  // Classic's headings are not Modern's.
  for (const old of ["Agents", "Workspaces"]) expect(html).not.toContain(`data-rail-heading="${old}"`);
});

test("each group holds its rows in the registry's order", () => {
  const html = rail();
  inOrder(groupOf(html, "Team"), ["chat-row", "calls-row", 'href="/team/activity"']);
  inOrder(groupOf(html, "Work"), ['href="/tasks"', 'href="/docs"', 'href="/projects"', 'href="/goals"', 'href="/org"']);
  inOrder(groupOf(html, "Automation"), ['href="/triggers"', 'href="/workflows"', 'href="/flows"']);
  inOrder(groupOf(html, "Code &amp; Ops"), ['href="/repo"', 'href="/deploys"', 'href="/changes"', 'href="/ops"']);
});

test("the renamed rows wear their Modern names", () => {
  const html = rail();
  expect(html).toMatch(/href="\/team\/activity"[^>]*>(?:<[^>]+>)*Activity</);
  expect(html).not.toContain(">Feed<");
  // Workflows is the page at /workflows; /routines stays in the palette.
  expect(html).toMatch(/href="\/workflows"[^>]*>(?:<[^>]+>)*Workflows</);
  expect(html).not.toContain('href="/routines"');
  expect(more()).toMatch(/href="\/files"[^>]*>(?:<[^>]+>)*Notes</);
});

test("the pages that moved to More are not rows of the rail itself", () => {
  const html = rail();
  for (const row of navRowsIn("more")) expect(html).not.toContain(`href="${row.path}"`);
});

test("each row keeps its classic gate: Changes, Org and Flows, and the live rows' slots", () => {
  expect(rail({ gates: { ...ALL, changes: false } })).not.toContain('href="/changes"');
  const off = rail({ gates: { ...ALL, org: false, line: false } });
  expect(off).not.toContain('href="/org"');
  expect(off).not.toContain('href="/flows"');
  const offered = rail({ gates: { ...ALL, org: "offer", line: "offer" } });
  expect(offered.match(/data-feature-new/g)?.length).toBe(2);
  // No chat, no calls, no active team: their rows are not handed in, and Team has nothing to head.
  const solo = rail({ live: { inbox: <span>inbox-row</span>, decisions: <span>decisions-row</span>, threads: <span>threads-row</span> } });
  expect(solo).not.toContain('data-rail-heading="Team"');
});

test("Org and Ops carry the counts handed to them", () => {
  const html = rail({ orgBadge: <span data-org-count>4</span>, opsBadge: <span data-ops-count>3</span> });
  expect(groupOf(html, "Work")).toContain("data-org-count");
  expect(groupOf(html, "Code &amp; Ops")).toContain("data-ops-count");
});

test("each page lights its own row, and a page behind More lights More", () => {
  const lit = (path: string) => current(rail({ activeId: navActiveId(path) }));
  expect(lit("/goals")).toEqual(["Goals"]);
  expect(lit("/projects/pj-1")).toEqual(["Projects"]);
  expect(lit("/plans/pl-3")).toEqual(["Docs"]);
  expect(lit("/routines")).toEqual(["Workflows"]);
  expect(lit("/workflows/runs/r1")).toEqual(["Workflows"]);
  expect(lit("/line")).toEqual(["Flows"]);
  expect(lit("/commit/o/r/abc")).toEqual(["Code"]);
  expect(lit("/ops/issues")).toEqual(["Ops"]);
  expect(lit("/vault")).toEqual(["More"]);
  expect(lit("/files")).toEqual(["More"]);
});

test("a pathname maps to its registry row", () => {
  const cases: Array<[string, NavId | null]> = [
    ["/inbox", "inbox"], ["/decisions/sd-2", "decisions"], ["/chat/threads", "threads"], ["/chat/c1", "chat"],
    ["/team/activity", "activity"], ["/team/charts", "teamCharts"], ["/schedules/s1", "triggers"], ["/artifacts", "pages"],
    ["/flows/settings", "flows"], ["/organization", null], ["/feed", null], ["/settings", null],
  ];
  for (const [path, id] of cases) expect(navActiveId(path)).toBe(id);
});

test("focused: the six daily pages (Inbox, Decisions, Chat, Calls, Tasks, Docs), then More", () => {
  const html = rail({ focused: true });
  for (const kept of ["inbox-row", "decisions-row", "chat-row", "calls-row", 'href="/tasks"', 'href="/docs"', "data-rail-more"]) expect(html).toContain(kept);
  for (const gone of ["threads-row", 'href="/team/activity"', 'href="/projects"', 'href="/org"', 'href="/triggers"', 'href="/repo"', 'href="/deploys"', 'href="/ops"']) expect(html).not.toContain(gone);
  for (const h of ["Automation", "Code &amp; Ops"]) expect(html).not.toContain(`data-rail-heading="${h}"`);
  // A page the short rail folds lights More.
  expect(current(rail({ focused: true, activeId: "deploys" }))).toEqual(["More"]);
});

test("every rail row the short rail folds is in its More level, and nothing is lost", () => {
  const html = more({ focused: true });
  for (const row of NAV_REGISTRY) {
    if (row.group === "palette") continue;
    expect(`${row.id}: ${html.includes(`href="${row.path}"`)}`).toBe(`${row.id}: ${row.focus === "more"}`);
  }
});

test("More lists its pages in the registry's order, Evals for staff only", () => {
  const html = more();
  inOrder(html, navRowsIn("more").map((row) => `href="${row.path}"`));
  expect(html).not.toContain("data-rail-heading");
  expect(more({ gates: { ...ALL, staff: false } })).not.toContain('href="/evals"');
});

test("the short-rail switch shows only where it is offered, and says which way it goes", () => {
  expect(more()).not.toContain("data-rail-focus-toggle");
  expect(more({ focused: true, focusToggle: () => {} })).toContain("Show every page in the rail");
  expect(more({ focused: false, focusToggle: () => {} })).toContain("Keep the rail short");
});

test("the workspace switcher heads the rail, the Work window draws Work alone", () => {
  const html = rail({ workspaceHeader: <span>switcher</span> });
  inOrder(html, ["data-rail-workspace", "switcher", "inbox-row"]);
  const work = rail({ scope: "work" });
  expect(work).toContain('data-rail-heading="Work"');
  for (const gone of ["inbox-row", 'data-rail-heading="Team"', "data-rail-more"]) expect(work).not.toContain(gone);
});

test("the Modern rail keeps to its own marker, out of reach of Simple view's and Minimal's rules", () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
  const sheet = read("./modernRail.css").replace(/\/\*[\s\S]*?\*\//g, "");
  expect(sheet).not.toContain("data-sv-nav");
  for (const rule of sheet.match(/^[^@\s}][^{]*\{/gm) ?? []) expect(rule).toContain("[data-modern-rail]");
  const shell = read("./ModernSidebar.tsx");
  expect(shell).toMatch(/<nav\s+data-modern-rail/);
  expect(shell).not.toMatch(/<nav[^>]*data-sv-nav/);
  expect(read("../../app/globals.css")).not.toContain("data-modern-rail");
});
