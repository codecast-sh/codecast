// Where a page sits, as the Modern style draws it: the rail section it
// belongs to, the crumbs above it (Section › Parent › the page), and the
// place Back goes when the person arrived by a cold link and there is no
// trail to walk back along (lib/navTrail). One function of the address and
// the names the store knows, so the rail, the crumbs, the back control and
// the trail can never disagree about where something lives.
//
// Pure: no React, no store. Names come in through `PlaceNames`, so a test
// passes a plain map and the header passes narrow store selectors.

import { navActiveId, navLabelOfPath, navRow, type NavId } from "./navRegistry";

/** The window event the Modern rail listens for to open its More level: the
 *  "More" crumb above a page that lives there. */
export const RAIL_MORE_EVENT = "codecast:rail-more";

/** One crumb. A crumb with no `href` is a place with no page of its own:
 *  `more` opens the rail's More level instead. */
export type PlaceCrumb = { label: string; href?: string; more?: true; mono?: boolean };

/** What the page is about, for its name (lib/placeTitle reads the store by it). */
export type PlaceObject =
  | { type: "session"; id: string }
  | { type: "task" | "doc" | "plan" | "project" | "trigger" | "call" | "run" | "decision" | "goal" | "member" | "channel"; id: string }
  | { type: "pr"; repo: string; number: string }
  | { type: "commit"; repo: string; sha: string };

export type Place = {
  /** The rail row the page lights. */
  section: NavId | null;
  /** The page's ancestors, outermost first; never the page itself. */
  crumbs: PlaceCrumb[];
  /** Where Back goes with no trail: the nearest ancestor that is a page. */
  parent: { label: string; href: string } | null;
  object?: PlaceObject;
};

/** What a crumb needs from the store: a container's name, and the container a
 *  task is filed under. Anything unknown falls back to the kind's word. */
export type PlaceNames = {
  title?: (type: "project" | "plan" | "doc" | "task", id: string) => string | undefined;
  /** The plan a task belongs to, when it has one. */
  taskPlan?: (taskId: string) => { id: string; title?: string; short_id?: string } | undefined;
};

const label = (id: NavId) => navRow(id).label;
const section = (id: NavId): PlaceCrumb => ({ label: label(id), href: navRow(id).path });

function under(path: string, base: string) {
  return path === base || path.startsWith(`${base}/`);
}

/** The rail row a page lights. Every page in the registry lights its own row
 *  (navActiveId); an object page reached by link lights the section that
 *  holds it: a session lights Inbox, a teammate's page Org, a mod's object
 *  Mods (behind More), a community room Chat, a flow's review pages Flows. */
export function placeSection(pathname: string | null | undefined): NavId | null {
  const p = (pathname ?? "").split("?")[0].split("#")[0];
  const hit = navActiveId(p);
  if (hit) return hit;
  if (under(p, "/conversation")) return "inbox";
  if (/^\/team\/[^/]+$/.test(p)) return "org";
  if (under(p, "/anchor")) return "org";
  if (under(p, "/m") || under(p, "/o") || under(p, "/objects")) return "mods";
  if (under(p, "/community")) return "chat";
  if (under(p, "/trial") || under(p, "/expectations") || under(p, "/view")) return "flows";
  return null;
}

/** The session a path shows, in either spelling (/conversation/<id>, /inbox?s=<id>). */
export function placeSessionId(path: string): string | null {
  const [pathname, query = ""] = path.split("#")[0].split("?");
  const conv = pathname.match(/^\/conversation\/([^/]+)/);
  if (conv) return decodeURIComponent(conv[1]);
  if (pathname !== "/inbox") return null;
  try {
    return new URLSearchParams(query).get("s");
  } catch {
    return null;
  }
}

function crumbName(names: PlaceNames | undefined, type: "project" | "plan" | "doc" | "task", id: string, fallback: string): string {
  const t = names?.title?.(type, id);
  return t && t.trim() ? t.replace(/\s+/g, " ").trim() : fallback;
}

/** One spelling per place: a plan opened over its list (/plans?plan=<id>) is
 *  the plan's own page (/plans/<id>). Every reader here goes through it. */
export function canonicalPlacePath(path: string): string {
  const [pathname, query = ""] = path.split("#")[0].split("?");
  if (pathname === "/plans" && query.includes("plan=")) {
    try {
      const plan = new URLSearchParams(query).get("plan");
      if (plan) return `/plans/${plan}`;
    } catch {
      return path;
    }
  }
  return path;
}

/** The place of a path. */
export function placeOf(rawPath: string, names?: PlaceNames): Place {
  const path = canonicalPlacePath(rawPath);
  const pathname = path.split("#")[0].split("?")[0].replace(/\/+$/, "") || "/";
  const seg = pathname.split("/").filter(Boolean).map((s) => {
    try { return decodeURIComponent(s); } catch { return s; }
  });
  const sec = placeSection(pathname);
  const done = (crumbs: PlaceCrumb[], object?: PlaceObject): Place => {
    let parent: Place["parent"] = null;
    for (let i = crumbs.length - 1; i >= 0; i--) {
      const c = crumbs[i];
      if (c.href) { parent = { label: c.label, href: c.href }; break; }
    }
    return { section: sec, crumbs, parent, object };
  };

  const sid = placeSessionId(path);
  if (sid) return done([section("inbox")], { type: "session", id: sid });

  const [head, a, b, c] = seg;
  switch (head) {
    case "tasks": {
      if (!a) break;
      const plan = names?.taskPlan?.(a);
      const crumbs = [section("tasks")];
      if (plan) crumbs.push({ label: plan.title?.trim() || plan.short_id || "Plan", href: `/plans/${plan.short_id ?? plan.id}` });
      return done(crumbs, { type: "task", id: a });
    }
    case "projects": {
      if (!a) break;
      if (b) return done([section("projects"), { label: crumbName(names, "project", a, "Project"), href: `/projects/${a}` }], { type: "task", id: b });
      return done([section("projects")], { type: "project", id: a });
    }
    case "docs":
      if (a) return done([section("docs")], { type: "doc", id: a });
      break;
    case "plans":
      // Plans live under Docs in the rail.
      if (a) return done([section("docs"), { label: navLabelOfPath("/plans") ?? "Plans", href: "/plans" }], { type: "plan", id: a });
      return done([section("docs")]);
    case "triggers":
    case "schedules":
      if (a) return done([section("triggers")], { type: "trigger", id: a });
      break;
    case "calls":
      if (a) return done([section("calls")], { type: "call", id: a });
      break;
    case "decisions":
      if (a === "stacks") return done(b ? [section("decisions"), { label: "Stacks", href: "/decisions/stacks" }] : [section("decisions")]);
      if (a) return done([section("decisions")], { type: "decision", id: a });
      break;
    case "goals":
      if (a) return done([section("goals")], { type: "goal", id: a });
      break;
    case "org":
      if (a) return done([section("org")]);
      break;
    case "anchor":
      return done([section("org")]);
    case "team":
      // /team/activity and /team/charts are pages of their own; any other
      // segment is a teammate, whose page sits under Org.
      if (a && a !== "activity" && a !== "charts" && !b) return done([section("org")], { type: "member", id: a });
      break;
    case "chat":
      if (a && a !== "threads") return done([section("chat")], { type: "channel", id: a });
      break;
    case "community":
      if (a) return done([section("chat"), { label: navLabelOfPath("/community") ?? "Community", href: "/community" }], { type: "channel", id: a });
      return done([section("chat")]);
    case "workflows":
      if (a === "runs" && b) return done([section("workflows")], { type: "run", id: b });
      break;
    case "routines":
      return done([section("workflows")]);
    case "flows":
    case "line":
      if (a) return done([section("flows")]);
      break;
    case "trial":
    case "expectations":
    case "view":
      return done([section("flows")]);
    case "repo": {
      if (!a || !b) break;
      const repo = `${a}/${b}`;
      return done(c ? [section("code"), { label: repo, href: `/repo/${repo}`, mono: true }] : [section("code")]);
    }
    case "pr":
      if (a && b && c) {
        const repo = `${a}/${b}`;
        return done(
          [section("code"), { label: repo, href: `/repo/${repo}`, mono: true }, { label: "Pull requests", href: `/repo/${repo}/pulls` }],
          { type: "pr", repo, number: c },
        );
      }
      break;
    case "commit":
      if (a && b && c) {
        const repo = `${a}/${b}`;
        return done([section("code"), { label: repo, href: `/repo/${repo}`, mono: true }], { type: "commit", repo, sha: c });
      }
      break;
    case "ops": {
      if (!a) break;
      // Ops draws its own trail in its header (components/ops/OpsShell); the
      // place still knows the way back: a detail to its tab, a tab to Ops.
      return done(b ? [section("ops"), { label: a[0].toUpperCase() + a.slice(1), href: `/ops/${a}` }] : [section("ops")]);
    }
    case "m":
    case "o":
    case "objects":
      return done([{ label: "More", more: true }, section("mods")]);
    case "evals":
      return done(a ? [{ label: "More", more: true }, section("evals")] : [{ label: "More", more: true }]);
    case "settings":
      if (a) return done([{ label: navLabelOfPath("/settings") ?? "Settings", href: "/settings" }]);
      break;
  }

  // A page behind More reads More › the page; a palette page that a rail
  // section holds reads that section first.
  if (sec) {
    const row = navRow(sec);
    if (row.group === "more" && pathname === row.path) return done([{ label: "More", more: true }]);
  }
  return done([]);
}

/** The place key two paths share when they show the same place: the address
 *  without its query, except the inbox, where the session is the place. */
export function placeKey(rawPath: string): string {
  const path = canonicalPlacePath(rawPath);
  const sid = placeSessionId(path);
  if (sid) return `/inbox?s=${sid}`;
  const pathname = path.split("#")[0].split("?")[0].replace(/\/+$/, "") || "/";
  // An old alias is the same place as its page.
  if (pathname.startsWith("/schedules")) return `/triggers${pathname.slice("/schedules".length)}`;
  if (pathname === "/artifacts") return "/pages";
  return pathname;
}

/** Whether the crumbs above a page add anything to its title: none when the
 *  title is one of them (a page whose header already names its section, the
 *  way Ops does, draws its own trail). */
export function crumbsForTitle(crumbs: PlaceCrumb[], title: string): PlaceCrumb[] {
  return crumbs.some((c) => c.label === title) ? [] : crumbs;
}
