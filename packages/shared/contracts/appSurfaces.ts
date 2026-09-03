/**
 * The surfaces of the codecast app that a driver can reach by URL alone: every
 * signed-in page with no path parameter. `cast app goto <name>` resolves a
 * name here and `cast app sweep` walks the list, so this is the regression
 * order for "did we break the app broadly". The web's routes.manifest test
 * keeps it honest: a param-free dashboard or standalone route missing here
 * fails that test, and a surface here that the router no longer serves fails
 * it too.
 *
 * Kept as plain data (no React) so the CLI can import it.
 */

export type AppSurfaceKind = "dashboard" | "standalone" | "settings";

export interface AppSurface {
  /** The name `cast app goto` accepts; also the path without the leading slash. */
  name: string;
  /** Absolute path on the app origin. */
  path: string;
  kind: AppSurfaceKind;
  /** One line a driver reads to know what it is looking at. */
  what: string;
  /** Path prefixes the app may legitimately show after landing here (the inbox opens a conversation). */
  alsoLandsOn?: string[];
}

const dash = (name: string, what: string): AppSurface => ({ name, path: `/${name}`, kind: "dashboard", what });
const standalone = (name: string, what: string): AppSurface => ({ name, path: `/${name}`, kind: "standalone", what });
const settings = (name: string, what: string): AppSurface => ({ name, path: `/${name}`, kind: "settings", what });

export const APP_SURFACES: AppSurface[] = [
  { ...dash("inbox", "the agent inbox: sessions grouped by who acts next"), alsoLandsOn: ["/conversation/"] },
  dash("feed", "team activity feed"),
  dash("crosstalk", "agents talking to each other across sessions"),
  dash("chat", "human channels and direct messages"),
  dash("search", "search across sessions, docs, tasks and people"),
  dash("notifications", "notification list"),
  dash("questions", "agent questions waiting for an answer"),
  dash("threads", "thread list"),
  dash("docs", "documents index"),
  dash("capabilities", "capability registry"),
  dash("files", "the file vault (alias /vault)"),
  dash("vault", "pre-rename alias of /files"),
  dash("pages", "published pages (alias /artifacts)"),
  dash("artifacts", "pre-rename alias of /pages"),
  dash("calls", "call history"),
  dash("plans", "plans board"),
  dash("tasks", "tasks board"),
  dash("projects", "projects and their tasks"),
  dash("workflows", "dynamic workflow runs"),
  dash("routines", "DOT-graph orchestration"),
  dash("triggers", "delayed, recurring and event-driven runs (alias /schedules)"),
  dash("schedules", "pre-rename alias of /triggers"),
  dash("sessions", "session list"),
  dash("anchor", "the team's anchor agent"),
  dash("team", "team overview"),
  dash("team/activity", "team activity"),
  dash("team/charts", "team charts"),
  dash("admin/daemon-logs", "daemon logs"),
  dash("config", "config page"),
  standalone("explore", "explore"),
  standalone("timeline", "timeline"),
  standalone("windows", "windows"),
  standalone("orchestration", "orchestration"),
  standalone("roadmap", "roadmap"),
  standalone("cli", "CLI page"),
  settings("settings", "settings index"),
  settings("settings/cli", "CLI settings"),
  settings("settings/agents", "agent settings"),
  settings("settings/devices", "devices"),
  settings("settings/sync", "sync settings"),
  settings("settings/profile", "profile"),
  settings("settings/accounts", "linked accounts"),
  settings("settings/claude-accounts", "Claude accounts"),
  settings("settings/team", "team settings"),
  settings("settings/notifications", "notification settings"),
  settings("settings/desktop", "desktop settings"),
];

/** Route paths that take no parameter but are not surfaces a sweep should land on. */
export const APP_SURFACE_EXCLUDED_PATHS = new Set<string>([
  // Chromeless OS windows: they render nothing meaningful in a plain tab.
  "palette",
  "people",
  "call-panel",
  "faces",
  "meeting-offer",
  "call-ring",
  // Multi-step flows that need state from a previous page.
  "settings/accounts/link-github",
  "settings/team/create",
  "settings/team/join",
  "settings/integrations/github-app",
  "review/batch",
]);

export function findAppSurface(nameOrPath: string): AppSurface | undefined {
  const key = nameOrPath.replace(/^\/+/, "").replace(/\/+$/, "");
  return APP_SURFACES.find((s) => s.name === key);
}
