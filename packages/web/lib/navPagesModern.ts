// The palette's Pages rows in the Modern interface style: lib/navRegistry's
// pages in the rail's order and under the rail's names, so the palette and
// the Modern rail list the same pages the same way. Classic and Minimal keep
// lib/navPages NAV_PAGES as it is.
//
// Built from NAV_PAGES rather than beside it: a page keeps the words that
// find it, its shortcut and whether it waits for typing, and the rows that
// are a view of a page (an Ops tab, a Changes edition, a Settings section)
// follow their page. Only what Modern changes is written here.
import type { TeamFeatureKey } from "@codecast/shared/contracts";
import type { NavPage } from "./navPages";
import { NAV_REGISTRY, type NavGate, type NavId, type NavRow } from "./navRegistry";

/** The registry's gates the palette keeps: the team features. A row behind
 *  any other gate (an active team, staff, the org feature) stays listed, as
 *  it always was; its page says what it needs. */
const PALETTE_FEATURES: Partial<Record<NavGate, TeamFeatureKey>> = { chat: "chat", calls: "calls", changes: "changes", line: "line" };

/** What Modern changes about a page's row, or the whole row for a page the
 *  classic palette does not list. */
const MODERN: Partial<Record<NavId, Partial<Pick<NavPage, "keywords" | "aliases" | "secondary" | "action"> & { path: string }>>> = {
  inbox: { keywords: "idle queue waiting needs you sessions" },
  // "routines" names the workflow graphs (Routines), not this page.
  triggers: { keywords: "triggers schedules cron automation recurring followup reminders" },
  workflows: { keywords: "workflows dynamic runs agents orchestration" },
  // Modern's /workflows is the whole Workflows page (Routines, Runs, Dynamic),
  // so the Routines row opens its tab there rather than the older address.
  routines: { path: "/workflows?tab=routines" },
  // A row of the rail, so listed before anyone types.
  flows: { secondary: false },
  windows: { keywords: "windows window manager arrange tile desktop", secondary: true },
  crosstalk: { keywords: "crosstalk agents talking to each other messages between sessions", secondary: true },
  agentConfig: { keywords: "agent config configuration claude md settings hooks permissions", secondary: true },
  feed: { keywords: "message feed messages stream everything said", secondary: true },
};

/** Where a registry row's palette entry goes in Modern: its page, or the
 *  place Modern moved it to (Routines is a tab of /workflows). */
export function modernPalettePath(row: Pick<NavRow, "id" | "path">): string {
  return MODERN[row.id]?.path ?? row.path;
}

function pathOf(page: NavPage): string {
  return typeof page.path === "string" ? page.path : page.path();
}

/** The registry row a classic row that is not a page of its own belongs
 *  under: by its label ("Ops: Issues" under Ops) or its address (/evals/sim
 *  under Evals, /settings/team under Settings). */
function parentOf(page: NavPage, rows: readonly NavRow[]): NavId {
  const prefix = page.label.split(":")[0];
  const byLabel = page.label.includes(":") ? rows.find((r) => r.label === prefix) : undefined;
  if (byLabel) return byLabel.id;
  const p = pathOf(page).split(/[?#]/)[0];
  const byPath = [...rows].sort((a, b) => b.path.length - a.path.length).find((r) => p === r.path || p.startsWith(`${r.path}/`));
  return byPath?.id ?? "settings";
}

export function buildModernNavPages(classic: ReadonlyArray<NavPage>): NavPage[] {
  const registryPaths = new Set(NAV_REGISTRY.map((r) => r.path));
  const views = new Map<NavId, NavPage[]>();
  for (const page of classic) {
    if (typeof page.path === "string" && registryPaths.has(page.path)) continue;
    const parent = parentOf(page, NAV_REGISTRY);
    views.set(parent, [...(views.get(parent) ?? []), page]);
  }
  return NAV_REGISTRY.flatMap((row) => {
    const base = classic.find((p) => p.path === row.path);
    const over = MODERN[row.id] ?? {};
    const feature = row.feature ? PALETTE_FEATURES[row.feature] : undefined;
    // The classic name and any older one still find the page.
    const aliases = [...new Set([...(over.aliases ?? base?.aliases ?? []), ...(row.classicLabel ? [row.classicLabel] : []), ...(base && base.label !== row.label ? [base.label] : []), ...(row.formerLabels ?? [])])];
    const page: NavPage = {
      label: row.label,
      path: modernPalettePath(row),
      icon: base?.icon ?? "grid",
      navIcon: row.icon,
      keywords: over.keywords ?? base?.keywords ?? row.label.toLowerCase(),
      ...(aliases.length ? { aliases } : {}),
      ...((over.secondary ?? base?.secondary) ? { secondary: true } : {}),
      ...((over.action ?? base?.action) ? { action: over.action ?? base?.action } : {}),
      ...((base?.feature ?? feature) ? { feature: base?.feature ?? feature } : {}),
    };
    return [page, ...(views.get(row.id) ?? [])];
  });
}
