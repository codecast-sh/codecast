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
  dash("mods", "codecast mods: the panes, commands and blocks you and your agents added, each with its switch and logs"),
  dash("changes", "the daily edition of what the team shipped and why (?d=YYYY-MM-DD picks the day)"),
  dash("crosstalk", "agents talking to each other across sessions"),
  dash("org", "the company on one canvas: what waits on you, the goals and the projects serving them, and the people and roles who carry the work (/org/<in-N|pj-…|or-N|@handle> opens one beside it; /org/goals and /org/projects are the read views)"),
  dash("browser", "a web page as a pane: the address rides the query string (?u=<url>)"),
  dash("chat", "human channels and direct messages"),
  dash("search", "search across sessions, docs, tasks and people"),
  dash("notifications", "notification list"),
  dash("questions", "agent questions waiting for an answer"),
  dash("line", "the line: signals, causes, runs, cards, watch and closed, as one flow"),
  dash("expectations", "every project's expectations: how its product should behave, with breaks per line"),
  dash("line/settings", "one project's line: its finders, principles, check commands and limits, editable in its file"),
  dash("decisions/stacks", "decision stacks: open first with progress and due, done ones folded"),
  dash("threads", "thread list"),
  dash("docs", "documents index"),
  dash("capabilities", "capability registry"),
  dash("agent-features", "what codecast teaches your agents: features by category, switched per machine"),
  dash("files", "the file vault (alias /vault)"),
  dash("vault", "pre-rename alias of /files"),
  dash("pages", "published pages (alias /artifacts)"),
  dash("artifacts", "pre-rename alias of /pages"),
  dash("calls", "call history"),
  dash("plans", "plans board"),
  dash("tasks", "tasks board"),
  dash("workflows", "dynamic workflow runs"),
  dash("routines", "DOT-graph orchestration"),
  dash("triggers", "delayed, recurring and event-driven runs (alias /schedules)"),
  dash("ops", "the product's transitions across sources: errors, jobs, checks, metrics and deploys on one timeline"),
  dash("ops/issues", "error, job, check and metric groups with 72h sparklines, status and cause"),
  dash("ops/replays", "session replays as semantic events, with repro and fix session"),
  dash("ops/metrics", "watched metrics with their threshold lines"),
  dash("ops/apps", "app connector readers, actions, grants and the call audit"),
  dash("schedules", "pre-rename alias of /triggers"),
  dash("sessions", "session list"),
  dash("resources", "CPU, memory and processes per machine and session; offload suggestions"),
  dash("anchor", "the workspace's agent: its root role, Head of People by default"),
  dash("team/activity", "team activity"),
  dash("team/charts", "team charts"),
  dash("admin/daemon-logs", "daemon logs"),
  dash("config", "config page"),
  dash("memory", "Claude Code memories on this machine: link map, MEMORY.md load budget, editor"),
  dash("evals", "prompt evals on this machine: every surface's trend, runs, attribution and bisects"),
  dash("evals/sim", "Multiplayer sim history: scenarios by mode, invariants, failing runs as swim lanes"),
  dash("repo", "repositories you can browse: history, source and every commit"),
  standalone("explore", "explore"),
  standalone("windows", "windows"),
  standalone("orchestration", "orchestration"),
  standalone("cli", "CLI page"),
  settings("settings", "settings index"),
  settings("settings/cli", "CLI settings"),
  settings("settings/agents", "agent settings"),
  settings("settings/agent-library", "agent definitions and chains"),
  settings("settings/devices", "devices"),
  settings("settings/migrate", "bulk session migration between machines"),
  settings("settings/sync", "sync settings"),
  settings("settings/profile", "profile"),
  settings("settings/apps", "connected applications"),
  settings("settings/accounts", "linked accounts"),
  settings("settings/plan", "the assistant's plan, usage and extra credit"),
  settings("settings/claude-accounts", "Claude accounts"),
  settings("settings/team", "team settings"),
  settings("settings/integrations", "integrations"),
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
  "share-cursors",
  // Multi-step flows that need state from a previous page.
  "settings/accounts/link-github",
  "settings/team/create",
  "settings/team/join",
  "settings/integrations/github-app",
  "review/batch",
  // Slack's OAuth return leg: needs ?code&state from Slack, then bounces away.
  "slack/connect",
]);

export function findAppSurface(nameOrPath: string): AppSurface | undefined {
  const key = nameOrPath.replace(/^\/+/, "").replace(/\/+$/, "");
  return APP_SURFACES.find((s) => s.name === key);
}
