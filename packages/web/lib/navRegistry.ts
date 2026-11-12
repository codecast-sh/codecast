// Every destination the app names, once. In the Modern interface style the
// rail (components/sidebar/ModernSidebar), the palette's Pages group
// (lib/navPagesModern) and tab and window titles (lib/pathLabel) read a
// page's name, icon and order from here, so a page has one name everywhere.
// Before this, four hand-kept lists named the same page four ways ("Feed",
// "Dashboard", "Activity") and two different pages "Feed". Classic and
// Minimal keep their own lists and names until Modern replaces them;
// `classicLabel` records the name those use where it differs.
//
// Pure data and pure functions. lib/pathLabel reads this, the store imports
// pathLabel and the phone app imports the store, so nothing here may import
// React, an icon library or an `@/` path. `icon` is a lucide icon's name; the
// rail and the palette draw it (components/sidebar/RailIcon).

/** Where a row sits: the rail's unheaded top, one of its groups, the More
 *  drill, or the palette alone. */
export type NavGroup = "top" | "team" | "work" | "automation" | "code" | "more" | "palette";

/** A condition a row is shown under, besides the person's focus: a team
 *  feature, the calls deployment, an active team, or staff. */
export type NavGate = "chat" | "calls" | "changes" | "org" | "line" | "team" | "staff";

/** The gates as the viewer has them. "offer" is a feature the workspace never
 *  decided on: its row stays, marked new, and opens the feature's landing. */
export type NavGates = Partial<Record<NavGate, boolean | "offer">>;

/** The live count a rail row wears (drawn by the rail, never stored here). */
export type NavBadge = "needsYou" | "decisions" | "threads" | "chat" | "ops" | "org";

export type NavIconName =
  | "Activity" | "AppWindow" | "Bell" | "Blocks" | "Brain" | "ChartColumn" | "CircleHelp" | "ClipboardCheck"
  | "Ellipsis" | "FileText" | "Flag" | "FlaskConical" | "FolderGit2" | "FolderKanban" | "Gauge" | "GitBranch"
  | "Globe" | "Inbox" | "KeyRound" | "Library" | "ListChecks" | "Map" | "MessageSquare" | "MessageSquareText"
  | "MessagesSquare" | "Network" | "Newspaper" | "NotebookText" | "Phone" | "Puzzle" | "Radar" | "Radio"
  | "Rocket" | "Rss" | "ScrollText" | "Search" | "Settings" | "Signpost" | "SlidersHorizontal" | "SquareTerminal"
  | "Users" | "Waypoints" | "Workflow" | "Zap";

type NavRowSpec = {
  id: string;
  label: string;
  path: string;
  icon: NavIconName;
  group: NavGroup;
  feature?: NavGate;
  /** A solo account's focused rail keeps the "keep" rows and leaves the rest
   *  to More (lib/railFocus.ts). */
  focus: "keep" | "more";
  /** Modern focused's short rail keeps this row too (keptOnShortRail). */
  dailyPage?: true;
  badge?: NavBadge;
  /** The addresses that light this row, when more than its own path: each
   *  one and everything under it. */
  match?: readonly string[];
  /** The name Classic and Minimal show today, where it differs. */
  classicLabel?: string;
  /** Other names the page went by. Modern's palette still finds it by these
   *  and by its classic name, and a tab or recent visit stored under one reads
   *  the current name. */
  formerLabels?: readonly string[];
  /** Hover text in the rail, when the name alone says too little. */
  title?: string;
};

const ROWS = [
  // The rail's unheaded top: the sessions, the decisions and the threads waiting on you.
  { id: "inbox", label: "Inbox", path: "/inbox", icon: "Inbox", group: "top", focus: "keep", badge: "needsYou", title: "Inbox: the sessions that need you" },
  { id: "decisions", label: "Decisions", path: "/decisions", icon: "CircleHelp", group: "top", focus: "keep", badge: "decisions", title: "Decisions you own, and the team's" },
  { id: "threads", label: "Threads", path: "/threads", icon: "MessagesSquare", group: "top", focus: "more", badge: "threads", match: ["/threads", "/chat/threads"], title: "Threads: every conversation you're in" },
  // Team: the people.
  { id: "chat", label: "Chat", path: "/chat", icon: "MessageSquare", group: "team", feature: "chat", focus: "more", dailyPage: true, badge: "chat" },
  { id: "calls", label: "Calls", path: "/calls", icon: "Phone", group: "team", feature: "calls", focus: "more", dailyPage: true, title: "Calls: live huddles and transcripts" },
  { id: "activity", label: "Activity", path: "/team/activity", icon: "Activity", group: "team", feature: "team", focus: "more", classicLabel: "Feed", formerLabels: ["Dashboard"], title: "Activity: what the team's sessions did" },
  // Work: what the team is doing.
  { id: "tasks", label: "Tasks", path: "/tasks", icon: "ClipboardCheck", group: "work", focus: "keep" },
  { id: "docs", label: "Docs", path: "/docs", icon: "FileText", group: "work", focus: "keep", match: ["/docs", "/plans"] },
  { id: "projects", label: "Projects", path: "/projects", icon: "FolderKanban", group: "work", focus: "more", title: "Projects: the work that moves the goals" },
  { id: "goals", label: "Goals", path: "/goals", icon: "Flag", group: "work", focus: "more", title: "Goals: what the company is trying to move" },
  { id: "org", label: "Org", path: "/org", icon: "Network", group: "work", feature: "org", focus: "more", badge: "org", title: "Org: who carries the work, people and agent roles" },
  // Automation: the standing things that set agents running.
  { id: "triggers", label: "Triggers", path: "/triggers", icon: "Zap", group: "automation", focus: "more", match: ["/triggers", "/schedules"] },
  { id: "workflows", label: "Workflows", path: "/workflows", icon: "Workflow", group: "automation", focus: "more", match: ["/workflows", "/routines"] },
  { id: "flows", label: "Flows", path: "/flows", icon: "Waypoints", group: "automation", feature: "line", focus: "more", match: ["/flows", "/line"], title: "Flows: every change through steps your team can see" },
  // Code & Ops: the product being built and run.
  { id: "code", label: "Code", path: "/repo", icon: "FolderGit2", group: "code", focus: "more", match: ["/repo", "/commit", "/pr"], formerLabels: ["Repositories"] },
  { id: "deploys", label: "Deploys", path: "/deploys", icon: "Rocket", group: "code", focus: "more", title: "Deploys: what is live, and what waits to go out" },
  { id: "changes", label: "Changes", path: "/changes", icon: "Newspaper", group: "code", feature: "changes", focus: "more", title: "Changes: what the team shipped and why, day by day" },
  { id: "ops", label: "Ops", path: "/ops", icon: "Radar", group: "code", focus: "more", badge: "ops", title: "Ops: what is wrong in the running product right now" },
  // More: a drill level of its own.
  { id: "pages", label: "Pages", path: "/pages", icon: "Globe", group: "more", focus: "more", match: ["/pages", "/artifacts"] },
  { id: "vault", label: "Vault", path: "/vault", icon: "KeyRound", group: "more", focus: "more" },
  { id: "notes", label: "Notes", path: "/files", icon: "NotebookText", group: "more", focus: "more", classicLabel: "Files" },
  { id: "windows", label: "Windows", path: "/windows", icon: "AppWindow", group: "more", focus: "more" },
  { id: "map", label: "Session map", path: "/map", icon: "Map", group: "more", focus: "more", classicLabel: "Session Map" },
  { id: "crosstalk", label: "Crosstalk", path: "/crosstalk", icon: "Radio", group: "more", focus: "more" },
  { id: "prompts", label: "Prompts", path: "/prompts", icon: "MessageSquareText", group: "more", focus: "more" },
  { id: "sessions", label: "Sessions", path: "/sessions", icon: "SquareTerminal", group: "more", focus: "more", classicLabel: "Live Sessions" },
  { id: "resources", label: "Resources", path: "/resources", icon: "Gauge", group: "more", focus: "more" },
  { id: "memory", label: "Memory", path: "/memory", icon: "Brain", group: "more", focus: "more" },
  { id: "capabilities", label: "Capabilities", path: "/capabilities", icon: "Library", group: "more", focus: "more" },
  { id: "agentFeatures", label: "Agent features", path: "/agent-features", icon: "Blocks", group: "more", focus: "more" },
  { id: "agentConfig", label: "Agent config", path: "/config", icon: "SlidersHorizontal", group: "more", focus: "more", classicLabel: "Agent Config" },
  { id: "mods", label: "Mods", path: "/mods", icon: "Puzzle", group: "more", focus: "more" },
  { id: "teamCharts", label: "Team charts", path: "/team/charts", icon: "ChartColumn", group: "more", focus: "more", classicLabel: "Team Charts" },
  { id: "evals", label: "Evals", path: "/evals", icon: "FlaskConical", group: "more", feature: "staff", focus: "more" },
  // The palette alone: pages reached by name, a link or a header control.
  { id: "plans", label: "Plans", path: "/plans", icon: "Signpost", group: "palette", focus: "more" },
  { id: "community", label: "Community", path: "/community", icon: "Users", group: "palette", focus: "more" },
  { id: "feed", label: "Message feed", path: "/feed", icon: "Rss", group: "palette", focus: "more", classicLabel: "Message Feed", formerLabels: ["Feed"] },
  { id: "routines", label: "Routines", path: "/routines", icon: "GitBranch", group: "palette", focus: "more", classicLabel: "Workflows" },
  { id: "trial", label: "Trial", path: "/trial", icon: "ScrollText", group: "palette", feature: "line", focus: "more" },
  { id: "expectations", label: "Expectations", path: "/expectations", icon: "ListChecks", group: "palette", focus: "more" },
  { id: "flowSettings", label: "Flow settings", path: "/flows/settings", icon: "Settings", group: "palette", feature: "line", focus: "more" },
  { id: "notifications", label: "Notifications", path: "/notifications", icon: "Bell", group: "palette", focus: "more" },
  { id: "search", label: "Search", path: "/search", icon: "Search", group: "palette", focus: "more" },
  { id: "settings", label: "Settings", path: "/settings", icon: "Settings", group: "palette", focus: "more" },
] as const satisfies readonly NavRowSpec[];

export type NavId = (typeof ROWS)[number]["id"];
export type NavRow = Omit<NavRowSpec, "id"> & { id: NavId };

/** Every row, in the rail's order (top, then each group, then More), then the palette's own. */
export const NAV_REGISTRY: readonly NavRow[] = ROWS;

/** The rail's groups in order, with the heading each one wears (none on the
 *  top rows). Classic's rail called its automation group "Agents". */
export const RAIL_GROUPS: ReadonlyArray<{ group: Exclude<NavGroup, "palette" | "more">; heading: string | null; classicHeading?: string }> = [
  { group: "top", heading: null },
  { group: "team", heading: "Team" },
  { group: "work", heading: "Work" },
  { group: "automation", heading: "Automation", classicHeading: "Agents" },
  { group: "code", heading: "Code & Ops" },
];

/** The rail's list of project folders, which Classic heads "Workspaces"
 *  beside the workspace switcher that means something else. */
export const FOLDERS_HEADING = { label: "Folders", classicLabel: "Workspaces" } as const;

const BY_ID = new Map<string, NavRow>(NAV_REGISTRY.map((row) => [row.id, row]));
const BY_PATH = new Map<string, NavRow>(NAV_REGISTRY.map((row) => [row.path, row]));

export function navRow(id: NavId): NavRow {
  return BY_ID.get(id)!;
}

/** Whether a short rail keeps `row`: the registry's "keep" rows, and in Modern
 *  focused its daily pages (Inbox, Decisions, Chat, Calls, Tasks, Docs). */
export function keptOnShortRail(row: NavRow, daily = false): boolean {
  return row.focus === "keep" || (daily && row.dailyPage === true);
}

export function navRowsIn(group: NavGroup): NavRow[] {
  return NAV_REGISTRY.filter((row) => row.group === group);
}

/** The name of the page at exactly this address (no query), if it is one of ours. */
export function navLabelOfPath(path: string): string | undefined {
  return BY_PATH.get(path)?.label;
}

/** Whether a row shows for these gates: true, "offer" (shown, marked new), or false. */
export function navRowShown(row: Pick<NavRow, "feature">, gates: NavGates): boolean | "offer" {
  return row.feature ? gates[row.feature] ?? false : true;
}

function under(path: string, base: string): boolean {
  return path === base || path.startsWith(`${base}/`);
}

/** The rail row a pathname lights: the longest of the rail rows' addresses
 *  it sits on. Palette rows light nothing (/plans lights Docs through Docs'
 *  own match). */
export function navActiveId(pathname: string | null | undefined): NavId | null {
  const p = (pathname ?? "").split("?")[0].split("#")[0];
  let best: { id: NavId; len: number } | null = null;
  for (const row of NAV_REGISTRY) {
    if (row.group === "palette") continue;
    for (const base of row.match ?? [row.path]) {
      if (under(p, base) && (!best || base.length > best.len)) best = { id: row.id, len: base.length };
    }
  }
  return best?.id ?? null;
}

/** Whether a title stored for a tab or a visit at `path` is a name the page
 *  does not go by in Modern (its classic or a former name, or the bare address
 *  segment an older pathLabel fell back to), so Modern shows its own name
 *  instead. Classic and Minimal keep every stored title as they always have:
 *  a tab titled while Modern was on keeps its Modern name there until the
 *  page is visited again. */
export function staleNavTitle(path: string, title: string, modern: boolean): boolean {
  if (!modern) return false;
  const clean = path.split("?")[0].split("#")[0];
  const row = BY_PATH.get(clean);
  if (!row || title === row.label) return false;
  return title === row.classicLabel || (row.formerLabels ?? []).includes(title) || title === clean.split("/").pop();
}
