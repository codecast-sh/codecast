import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ROUTES, routeHref, tabRoutes, type RouteEntry } from "./routes.manifest";

/**
 * Completeness / parity guard for the routing manifest (Wave 1 seed).
 *
 * The manifest is the proposed single source of truth; it does not yet drive the four live
 * routing lists. This test re-derives the truth from each of those four live sources by
 * reading their source text, and asserts the manifest agrees. If a future edit adds a route
 * to App.tsx (or a TabContent pattern, or an isOnXPage flag, or a NON_TAB rule) WITHOUT
 * updating the manifest, the matching assertion fails loudly — which is exactly the guardrail
 * that lets Wave 2 generate the four lists from this one file.
 */

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, ".."); // packages/web
const read = (rel: string) => readFileSync(join(webRoot, rel), "utf8");

const appSrc = read("src/App.tsx");
const tabContentSrc = read("components/TabContent.tsx");
const dashLayoutSrc = read("components/DashboardLayout.tsx");
const tabRoutingSrc = read("src/compat/tabRouting.ts");

const manifestByHref = new Map(ROUTES.map((r) => [routeHref(r.path), r] as const));

// -- (1) App.tsx parser: reconstruct every absolute <Route path> --------------------------
//
// App.tsx nests <Route path="x"> under layout <Route element={<Layout/>}> blocks. A child's
// absolute path = parent path prefix (when the parent carries a `path`) + child path. Layout
// routes that use `element` with no `path` (DashboardShell, PaletteLayout, MarketingLayout)
// contribute no prefix; the only path-carrying parent is SettingsLayout (`path="settings"`).
// We walk the JSX line by line, tracking a stack of (path-prefix, brace-depth) frames.

function parseAppRoutePaths(src: string): string[] {
  const lines = src.split("\n");
  const paths: string[] = [];
  // Stack of path prefixes contributed by ancestor <Route> elements that are still open.
  const prefixStack: string[] = [];
  // Parallel stack of the running brace/paren depth at which each prefix was pushed, so we
  // can pop it when its enclosing element closes.
  const depthStack: number[] = [];
  let depth = 0;

  const join2 = (a: string, b: string) => (a ? `${a}/${b}` : b);

  for (const raw of lines) {
    const line = raw.trim();

    // A <Route ...> opener. It is a parent-with-prefix if it has BOTH a path and children
    // (i.e. not self-closed on this line). It is a leaf if it is self-closed (`/>`).
    const routeOpen = /^<Route\b/.test(line);
    if (routeOpen) {
      const pathMatch = line.match(/\bpath="([^"]*)"/);
      const indexRoute = /\bindex\b/.test(line) && !pathMatch;
      const selfClosed = /\/>\s*$/.test(line);

      if (pathMatch || indexRoute) {
        const prefix = prefixStack.length ? prefixStack[prefixStack.length - 1] : "";
        const seg = indexRoute ? "" : pathMatch![1];
        const abs = indexRoute ? prefix : join2(prefix, seg);
        paths.push(abs);
        if (!selfClosed) {
          // Path-carrying parent (e.g. <Route path="settings" element=...>): becomes a prefix.
          prefixStack.push(abs);
          depthStack.push(depth);
        }
      } else if (!selfClosed) {
        // Layout route with `element` but no `path` (no prefix contribution) — push an empty
        // frame so its closing tag bookkeeping stays balanced via the inherited prefix.
        prefixStack.push(prefixStack.length ? prefixStack[prefixStack.length - 1] : "");
        depthStack.push(depth);
      }
      // Track nesting depth for openers that aren't self-closed.
      if (!selfClosed) depth += 1;
      continue;
    }

    // Closing </Route> for a previously-opened parent/layout frame.
    if (/^<\/Route>/.test(line)) {
      depth -= 1;
      if (depthStack.length && depthStack[depthStack.length - 1] === depth) {
        depthStack.pop();
        prefixStack.pop();
      }
    }
  }
  return paths;
}

const appPaths = parseAppRoutePaths(appSrc);
const appHrefs = new Set(appPaths.map(routeHref));

// -- (2) TabContent parser: extract the static form of every routing pattern --------------
//
// TabContent's ROUTES are RegExp literals like /^\/conversation\/([^/]+)\/diff$/. We turn
// each back into its static path with `:param` placeholders so it can be matched against the
// manifest's `tab` value. The param NAME comes from the adjacent paramNames array; positions
// align with the capture groups left-to-right.

function parseTabContentPatterns(src: string): { tab: string }[] {
  const out: { tab: string }[] = [];
  // Parse ONE entry per source line: `{ pattern: /^...$/, paramNames: [...], component: X }`.
  // Matching per-line (not across the whole file) keeps the regex-body capture from greedily
  // swallowing newlines and collapsing all entries into one.
  const entryRe = /pattern:\s*\/\^(.*?)\$\/\s*,\s*paramNames:\s*\[([^\]]*)\]/;
  for (const line of src.split("\n")) {
    const m = line.match(entryRe);
    if (!m) {
      // A pattern line the strict parser can't read would otherwise be silently
      // skipped and escape every parity check below (this is how /anchor's
      // `(\/|$)` pattern drifted unguarded). Anchored `^...$` patterns only.
      if (/pattern:\s*\//.test(line)) {
        throw new Error(
          `Unparseable TabContent pattern (must be /^...$/ with paramNames on one line): ${line.trim()}`,
        );
      }
      continue;
    }
    const rawBody = m[1]; // regex body between ^ and $, still escaped
    const paramNames = m[2]
      .split(",")
      .map((s) => s.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
    // Unescape `\/` → `/`, then replace each capture group `([^/]+)` (or `([^/]*)`) with the
    // next param name as `:name`, in order.
    let i = 0;
    const staticPath = rawBody
      .replace(/\\\//g, "/")
      .replace(/\(\[\^\/\]\+\)|\(\[\^\/\]\*\)/g, () => `:${paramNames[i++] ?? "param"}`);
    out.push({ tab: staticPath });
  }
  return out;
}

const tabPatterns = parseTabContentPatterns(tabContentSrc);

// -- (3) DashboardLayout parser: which pages compose isFullWidthPage -----------------------
//
// isFullWidthPage is an OR of isOnXPage booleans. Each isOnXPage is defined as either an
// exact `pathname === "/x"` and/or a `pathname?.startsWith("/x/")` / `pathname?.includes("/x/")`
// check. We extract the base path token of every isOn* that participates in isFullWidthPage,
// then assert the manifest marks that page (and its detail route, if any) fullWidth.

function parseFullWidthBasePaths(src: string): string[] {
  // The names ORed together into isFullWidthPage.
  const lineMatch = src.match(/const isFullWidthPage\s*=\s*([^;]+);/);
  if (!lineMatch) throw new Error("isFullWidthPage definition not found in DashboardLayout");
  const flagNames = lineMatch[1]
    .split("||")
    .map((s) => s.trim())
    .filter((s) => /^isOn/.test(s));

  const bases: string[] = [];
  for (const name of flagNames) {
    // Find that flag's definition and pull the first quoted "/x" path literal out of it.
    const defRe = new RegExp(`const ${name}\\s*=\\s*([^;]+);`);
    const def = src.match(defRe);
    if (!def) throw new Error(`Could not find definition for ${name}`);
    const pathLit = def[1].match(/"(\/[a-z0-9/-]+)"/i);
    if (pathLit) {
      bases.push(pathLit[1].replace(/\/$/, ""));
    } else if (name === "isOnInboxPage") {
      // isOnInboxPage is derived via isInboxSessionView(pathname, ...) with no path literal —
      // its surface is the /inbox route (plus conversation views, covered by isOnConversationPage).
      bases.push("/inbox");
    } else {
      throw new Error(`No path literal found for ${name} (parser needs an update)`);
    }
  }
  return Array.from(new Set(bases));
}

const fullWidthBases = parseFullWidthBasePaths(dashLayoutSrc);

// -- (4) tabRouting parser: the NON_TAB exact set + prefixes (outside the tab shell) -------

function parseNonTabRules(src: string): { exact: Set<string>; prefixes: string[] } {
  const exactBlock = src.match(/NON_TAB_EXACT\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
  const prefixBlock = src.match(/NON_TAB_PREFIXES\s*=\s*\[([\s\S]*?)\]/);
  const pull = (block: string | undefined) =>
    block ? Array.from(block.matchAll(/"([^"]+)"/g)).map((m) => m[1]) : [];
  return {
    exact: new Set(pull(exactBlock?.[1])),
    prefixes: pull(prefixBlock?.[1]),
  };
}

const nonTab = parseNonTabRules(tabRoutingSrc);

// tabRouting also knows the single-segment in-shell routes: any bare segment NOT
// in this set is a public-profile handle (/:username) served full-page outside the
// shell. Parse it so the parity checks below understand the dynamic exclusion.
function parseInShellRootSegments(src: string): Set<string> {
  const block = src.match(/IN_SHELL_ROOT_SEGMENTS\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
  const segs = block ? Array.from(block[1].matchAll(/"([^"]+)"/g)).map((m) => m[1]) : [];
  return new Set(segs);
}
const inShellSegments = parseInShellRootSegments(tabRoutingSrc);

// A route href is "non-tab" (rendered outside the dashboard shell) if it falls under
// a static NON_TAB rule OR it is a bare single segment (static "/x" or dynamic "/:x")
// that isn't a known in-shell route — i.e. a public-profile handle.
function isNonTabHref(href: string): boolean {
  if (nonTab.exact.has(href)) return true;
  if (nonTab.prefixes.some((p) => href === p || href.startsWith(p + "/"))) return true;
  const single = href.match(/^\/([^/]+)$/);
  return !!single && !inShellSegments.has(single[1].replace(/^:/, ""));
}

// =========================================================================================

describe("routes.manifest parser sanity", () => {
  it("extracted a plausible number of routes from each source", () => {
    // Guards against a parser silently matching nothing (which would make every parity
    // assertion below vacuously pass).
    expect(appPaths.length).toBeGreaterThan(60);
    expect(tabPatterns.length).toBeGreaterThan(20);
    expect(fullWidthBases.length).toBeGreaterThan(8);
    expect(nonTab.exact.size).toBeGreaterThan(5);
  });
});

describe("(d) every ROUTES entry has the required fields", () => {
  it("path is a string and component is a lazy ref; flags are well-typed", () => {
    for (const r of ROUTES) {
      expect(typeof r.path).toBe("string");
      expect(r.component).toBeDefined();
      // lazy() refs are objects exposing $$typeof / _payload.
      expect(typeof r.component === "object" || typeof r.component === "function").toBe(true);
      expect(typeof r.layout).toBe("string");
      if (r.tab !== undefined) expect(typeof r.tab).toBe("string");
      if (r.fullWidth !== undefined) expect(typeof r.fullWidth).toBe("boolean");
      if (r.guestOk !== undefined) {
        expect(r.guestOk).toBe(true);
        expect(["public", "shell"]).toContain(r.guestKind);
      }
    }
  });

  it("has no duplicate paths", () => {
    const seen = new Set<string>();
    for (const r of ROUTES) {
      expect(seen.has(r.path)).toBe(false);
      seen.add(r.path);
    }
  });

  it("every tab-routable entry's `tab` is its own absolute href", () => {
    // The `tab` value is the static TabContent pattern key; it must equal the route's href so
    // the Wave 2 generator can derive one from the other.
    for (const r of tabRoutes()) {
      expect(r.tab).toBe(routeHref(r.path));
    }
  });
});

describe("(a) every App.tsx route appears in the manifest", () => {
  it("manifest covers every <Route path> in App.tsx", () => {
    const missing = [...appHrefs].filter((href) => !manifestByHref.has(href));
    expect(missing).toEqual([]);
  });

  it("manifest introduces no route absent from App.tsx", () => {
    // The manifest must stay faithful in BOTH directions — an entry with no <Route> would
    // render nowhere today and silently rot.
    const extra = ROUTES.map((r) => routeHref(r.path)).filter((href) => !appHrefs.has(href));
    expect(extra).toEqual([]);
  });
});

describe("(b) every TabContent pattern resolves to a manifest entry tagged with that tab", () => {
  it("each TabContent route pattern has a manifest entry whose `tab` matches", () => {
    const taggedTabs = new Set(tabRoutes().map((r) => r.tab));
    const unmatched = tabPatterns.filter((p) => !taggedTabs.has(p.tab));
    expect(unmatched.map((p) => p.tab)).toEqual([]);
  });

  it("each manifest tab entry corresponds to a real TabContent pattern", () => {
    const patternTabs = new Set(tabPatterns.map((p) => p.tab));
    const orphanTabs = tabRoutes()
      .map((r) => r.tab!)
      .filter((tab) => !patternTabs.has(tab));
    expect(orphanTabs).toEqual([]);
  });
});

describe("(c) every DashboardLayout full-width page is marked fullWidth in the manifest", () => {
  it("every manifest route under an isFullWidthPage base is marked fullWidth (list + detail)", () => {
    // The DashboardLayout flag is segment-scoped: `includes("/conversation/")` /
    // `startsWith("/x/")` make EVERY route whose first segment is that base full-width — the
    // base route AND any `/:id` (and deeper) detail routes. So we drive the parity check off
    // the first path SEGMENT, not an exact-href lookup: a param-only base like /conversation,
    // /commit, /pr (which has no exact base href in the manifest) is the silent-drift class
    // this guard exists for, and the conversation detail view is its most important member.
    const firstSegment = (href: string) => `/${href.split("/")[1] ?? ""}`;
    const notMarked: string[] = [];
    for (const base of fullWidthBases) {
      // Every manifest route sharing this base's first segment must be fullWidth...
      const members = ROUTES.filter((r) => firstSegment(routeHref(r.path)) === base);
      // ...and there must be at least one — a base with zero manifest coverage means the
      // manifest is missing a page DashboardLayout still renders edge-to-edge. Fail loudly
      // instead of vacuously skipping it.
      if (members.length === 0) {
        notMarked.push(`${base} (no manifest route)`);
        continue;
      }
      for (const r of members) {
        if (!r.fullWidth) notMarked.push(routeHref(r.path));
      }
    }
    expect(notMarked).toEqual([]);
  });

  it("does not mark a page fullWidth that DashboardLayout treats as centered", () => {
    // Catch the reverse drift: a manifest fullWidth flag with no isOnXPage backing it. We
    // only check the static (non-param) pages here; dynamic detail routes inherit the flag.
    const fullWidthBaseSet = new Set(fullWidthBases);
    // Code-review routes (commit/pr) are full-width via isOnCommitPage / isOnPRPage includes()
    // checks — fold those bases in.
    const allowed = new Set([...fullWidthBaseSet, "/commit", "/pr"]);
    const unexpected = ROUTES.filter((r) => {
      if (!r.fullWidth) return false;
      const href = routeHref(r.path);
      // Reduce a detail/href to its base segment: /tasks/:id → /tasks, /commit/... → /commit.
      const base = `/${href.split("/")[1] ?? ""}`;
      return !allowed.has(base);
    }).map((r) => routeHref(r.path));
    expect(unexpected).toEqual([]);
  });
});

describe("non-tab routes (tabRouting.ts) are NOT tagged tab-routable in the manifest", () => {
  it("no manifest entry under a NON_TAB exact/prefix carries a `tab`", () => {
    const offenders: string[] = [];
    for (const r of tabRoutes()) {
      const href = routeHref(r.path);
      const isNonTab =
        nonTab.exact.has(href) ||
        nonTab.prefixes.some((p) => href === p || href.startsWith(p + "/"));
      if (isNonTab) offenders.push(href);
    }
    expect(offenders).toEqual([]);
  });

  // KNOWN GAPS — real drift this test caught, tracked instead of hidden. Each entry
  // is a route that IS public but is NOT yet excluded from the tab interceptor, so a
  // signed-in user's in-dashboard click can be intercepted into a blank TabContent
  // pane. Owners were notified; delete the entry when the exclusion lands.
  // (Empty — the "/:username" public-profile gap was fixed: tabRouting now excludes
  // any bare single segment that isn't a known in-shell route. See isNonTabHref.)
  const KNOWN_TAB_ROUTING_GAPS = new Set<string>([]);

  it("guest `public` routes all live outside the tab shell", () => {
    // Sanity: every public-guest route is a NON_TAB route (marketing/auth/share, plus
    // root-level profile handles), so the tab interceptor never rewrites a signed-out
    // visitor's URL nor intercepts a signed-in user's click into a blank pane.
    const leaks = ROUTES.filter((r) => r.guestKind === "public").filter((r) => {
      const href = routeHref(r.path);
      if (KNOWN_TAB_ROUTING_GAPS.has(href)) return false;
      return !isNonTabHref(href);
    });
    expect(leaks.map((r) => routeHref(r.path))).toEqual([]);
  });

  it("known tab-routing gaps stay honest (each listed gap is still a real gap)", () => {
    // If the owner fixes the exclusion, this fails to force deleting the stale entry.
    for (const href of KNOWN_TAB_ROUTING_GAPS) {
      expect({ href, stillGapped: !isNonTabHref(href) }).toEqual({ href, stillGapped: true });
    }
  });

  it("tabRouting's IN_SHELL_ROOT_SEGMENTS matches the manifest's in-shell single segments", () => {
    // Drift guard for the new exclusion: the hand-kept set in tabRouting must equal the
    // single static-segment dashboardShell/standalone routes in the manifest. Add a new
    // such route without listing it here and a profile handle would shadow it (full nav
    // instead of tab nav); drop one and /<that-route> would 404 as a missing profile.
    const manifestInShell = ROUTES.filter(
      (r) => r.layout === "dashboardShell" || r.layout === "standalone",
    )
      .map((r) => routeHref(r.path))
      .filter((href) => /^\/[^/:]+$/.test(href)) // single STATIC segment only
      .map((href) => href.slice(1));
    expect([...inShellSegments].sort()).toEqual([...new Set(manifestInShell)].sort());
  });
});

// Re-export for any future Wave 2 consumer that wants the parsed live-source views.
export type { RouteEntry };
