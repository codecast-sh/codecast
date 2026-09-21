// The desktop's apps: which routes live in a window of their own.
//
// Chat and Work each open as a singleton window with no sidebars, so the
// person can keep them beside the main window the way they keep Slack beside
// an editor. Every entry point (a link, a banner, a menu, a deep link) lands a
// path in the window that owns it, and this table is the one place that says
// which window that is.
//
// ONE FILE FOR BOTH SIDES. The shell (main.js) requires it and the web bundle
// imports it, so the two can never disagree about where a path belongs. It is
// an ES module with no imports: the shell's Node (24) requires ES modules
// synchronously, and the web's bundler serves a file from this package by its
// relative path. Keep it free of Electron and of the DOM.

/** @typedef {"chat" | "work"} DesktopApp */

/**
 * Each app: its name as the header shows it, how its window reaches its
 * sections (`nav`: tabs in the bar, or a sidebar of its own), the sections
 * themselves (each a route prefix, in the order they appear; `also` lists
 * other prefixes that light the same tab; the chords walk them either way),
 * and the route it opens on when asked for with no path.
 */
export const DESKTOP_APPS = /** @type {const} */ ({
  chat: {
    title: "Chat",
    home: "/chat",
    // The window's sections as tabs in its bar; chat's page carries its own
    // channel rail beneath.
    nav: "tabs",
    // "Messages", not "Chat": the tab sits beside the app's own name, and a
    // header reading "Chat · Chat" names nothing.
    sections: [
      { path: "/chat", label: "Messages" },
      { path: "/threads", label: "Threads" },
      { path: "/calls", label: "Calls" },
    ],
    // The public rooms belong here without a tab of their own: they are the
    // chat page in another scope.
    routes: ["/chat", "/community", "/threads", "/calls"],
  },
  work: {
    title: "Work",
    home: "/tasks",
    // A rail of its own: the pinned rail and the Work group, with their
    // nested projects and saved views, which tabs cannot carry.
    nav: "sidebar",
    // The sidebar's order, which reads top down as goal, project, task, doc.
    sections: [
      { path: "/initiatives", label: "Initiatives" },
      { path: "/projects", label: "Projects" },
      { path: "/tasks", label: "Tasks" },
      // Plans read as documents (the sidebar files them under Docs too).
      { path: "/docs", label: "Docs", also: ["/plans"] },
    ],
    routes: ["/projects", "/tasks", "/docs", "/initiatives", "/plans"],
  },
});

/** @type {readonly DesktopApp[]} */
export const DESKTOP_APP_NAMES = /** @type {DesktopApp[]} */ (Object.keys(DESKTOP_APPS));

/** True for a string naming one of the apps. */
export function isDesktopApp(name) {
  return typeof name === "string" && Object.prototype.hasOwnProperty.call(DESKTOP_APPS, name);
}

function cleanPath(path) {
  return typeof path === "string" ? path.split("?")[0].split("#")[0] : "";
}

/**
 * The app a path belongs to, or null for everything the main window keeps
 * (sessions, the inbox, the feed, settings, the marketing site).
 * @returns {DesktopApp | null}
 */
export function appForRoute(path) {
  const clean = cleanPath(path);
  for (const name of DESKTOP_APP_NAMES) {
    for (const prefix of DESKTOP_APPS[name].routes) {
      if (clean === prefix || clean.startsWith(prefix + "/")) return name;
    }
  }
  return null;
}

/**
 * The section tab a path lights up inside its app's window, or null when the
 * path is the app's but has no tab (the public rooms in the Chat window).
 */
export function sectionForRoute(app, path) {
  if (!isDesktopApp(app)) return null;
  const clean = cleanPath(path);
  const under = (prefix) => clean === prefix || clean.startsWith(prefix + "/");
  return DESKTOP_APPS[app].sections.find((s) => under(s.path) || (s.also ?? []).some(under)) ?? null;
}

/**
 * Where a navigation lands, decided from three facts: the app the path
 * belongs to, the app of the document asking (null for the main window or a
 * plain detached window), and which app windows exist right now.
 *
 *   "here"     this document shows it
 *   "<app>"    that app's window shows it (and is raised)
 *   "main"     the main window shows it
 *
 * A document inside an app window never shows a path outside its app; a
 * document outside an app window never shows the app's paths while the app's
 * window exists. Both rules keep chat in chat and sessions in the main window
 * whatever the entry point was.
 *
 * @param {string} path
 * @param {DesktopApp | null} here
 * @param {{ chat?: boolean, work?: boolean }} open
 * @returns {"here" | "main" | DesktopApp}
 */
export function placeRoute(path, here, open) {
  const app = appForRoute(path);
  if (app && app !== here && open && open[app]) return app;
  if (here && app !== here) return "main";
  return "here";
}
