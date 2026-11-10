import { afterAll, expect, test } from "bun:test";
import React from "react";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";
import { ModernNavView, RegistryNavSection } from "./ModernNav";
import { MoreDrillList } from "./MoreNav";
import { NAV_REGISTRY, staleNavTitle } from "../../lib/navRegistry";
import { NAV_PAGES, pagePath, palettePages } from "../../lib/navPages";
import { pathLabel } from "../../lib/pathLabel";
import { tabTitle } from "../../lib/tabTitle";

// One page, one name, in Modern. The Modern rail, the palette's Pages group
// and the tab title (pathLabel) all read a page's name from lib/navRegistry;
// before it, four hand-kept lists called one page "Feed", "Dashboard" and
// "Activity", and two different pages "Feed". Classic and Minimal keep the
// names they have today, which this pins too.

// isModernStyle() reads the root class the ThemeProvider sets.
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
const restoreGlobals = replaceGlobals({ window: dom.window, document: dom.window.document });
afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});
function inStyle<T>(modern: boolean, read: () => T): T {
  dom.window.document.documentElement.classList.toggle("modern-style", modern);
  try {
    return read();
  } finally {
    dom.window.document.documentElement.classList.remove("modern-style");
  }
}

const shut = { items: [], expanded: false, onToggle: () => {} };
const ALL = { chat: true, calls: true, changes: true, org: true, line: true, team: true, staff: true } as const;
const live = Object.fromEntries((["inbox", "decisions", "threads", "chat", "calls", "activity"] as const).map((id) => [id, <RegistryNavSection key={id} id={id} isActive={false} isNarrow={false} />]));

const rail = renderToStaticMarkup(
  <MemoryRouter>
    <ModernNavView isNarrow={false} live={live} activeId={null} gates={ALL} tasks={shut} docs={shut} />
    <MoreDrillList activeId={null} gates={ALL} focused={false} />
  </MemoryRouter>,
);

/** The name the Modern rail's row for `path` shows. */
function railName(path: string): string | undefined {
  const at = rail.indexOf(`href="${path}"`);
  return at === -1 ? undefined : /^[^>]*>(?:<[^>]+>)*([^<]+)</.exec(rail.slice(at))?.[1];
}

test("in Modern every registry row has one name: in the rail, in the palette and in its tab", () => {
  const pages = palettePages(() => true, true, true);
  for (const row of NAV_REGISTRY) {
    if (row.group !== "palette") expect(`${row.id}: ${railName(row.path)}`).toBe(`${row.id}: ${row.label}`);
    const page = pages.find((p) => pagePath(p.page) === row.path);
    expect(`${row.id}: ${page?.label}`).toBe(`${row.id}: ${row.label}`);
    expect(`${row.id}: ${inStyle(true, () => pathLabel(row.path))}`).toBe(`${row.id}: ${row.label}`);
  }
});

test("Modern's palette lists the registry's pages in the rail's order, and finds them by their classic names", () => {
  const pages = palettePages(() => true, true, true).map((p) => p.page);
  const registryPaths = NAV_REGISTRY.map((r) => r.path);
  expect(pages.map(pagePath).filter((p) => registryPaths.includes(p))).toEqual(registryPaths);
  const byLabel = (label: string) => pages.find((p) => p.label === label);
  expect(byLabel("Activity")?.aliases).toEqual(expect.arrayContaining(["Feed", "Dashboard"]));
  expect(byLabel("Notes")?.aliases).toContain("Files");
  // Workflows is the page at /workflows; /routines keeps a row of its own.
  expect(byLabel("Workflows") && pagePath(byLabel("Workflows")!)).toBe("/workflows");
  expect(byLabel("Routines") && pagePath(byLabel("Routines")!)).toBe("/routines");
});

test("Classic and Minimal keep today's names and list", () => {
  expect(palettePages(() => true, true).map((p) => p.page)).toEqual([...NAV_PAGES]);
  expect(palettePages(() => true, true, false).map((p) => p.page)).toEqual([...NAV_PAGES]);
  const classic: Array<[string, string]> = [["/team/activity", "Feed"], ["/files", "Files"], ["/repo", "Repositories"], ["/map", "Session Map"], ["/feed", "Feed"], ["/workflows", "workflows"]];
  for (const [path, name] of classic) expect(inStyle(false, () => pathLabel(path))).toBe(name);
  const modern: Array<[string, string]> = [["/team/activity", "Activity"], ["/files", "Notes"], ["/repo", "Code"], ["/map", "Session map"], ["/feed", "Message feed"], ["/workflows", "Workflows"], ["/schedules", "Triggers"], ["/artifacts", "Pages"]];
  for (const [path, name] of modern) expect(inStyle(true, () => pathLabel(path))).toBe(name);
  // A Notes tab is still titled by the open file.
  expect(inStyle(true, () => pathLabel("/files?f=notes%2Ftodo.md"))).toBe("todo");
});

test("in Modern a tab stored under a classic name reads the Modern one; Classic keeps what it stored", () => {
  const tab = (title: string, path: string) => ({ id: "t", title, path, createdAt: 1 }) as any;
  expect(inStyle(true, () => tabTitle(tab("Feed", "/team/activity"), {}, {}))).toBe("Activity");
  expect(inStyle(true, () => tabTitle(tab("Files", "/files"), {}, {}))).toBe("Notes");
  expect(inStyle(true, () => tabTitle(tab("workflows", "/workflows"), {}, {}))).toBe("Workflows");
  // Classic keeps every stored title, as it always has.
  expect(inStyle(false, () => tabTitle(tab("Activity", "/team/activity"), {}, {}))).toBe("Activity");
  expect(inStyle(false, () => tabTitle(tab("Feed", "/team/activity"), {}, {}))).toBe("Feed");
  // A title that was never a page's name stays in Modern too.
  expect(inStyle(false, () => tabTitle(tab("workflows", "/workflows"), {}, {}))).toBe("workflows");
  expect(inStyle(true, () => tabTitle(tab("My board", "/team/activity"), {}, {}))).toBe("My board");
  expect(staleNavTitle("/tasks/ct-1", "Feed", true)).toBe(false);
});

test("no two registry rows share a name or an address", () => {
  const labels = NAV_REGISTRY.map((r) => r.label.toLowerCase());
  const paths = NAV_REGISTRY.map((r) => r.path);
  expect(new Set(labels).size).toBe(labels.length);
  expect(new Set(paths).size).toBe(paths.length);
});
