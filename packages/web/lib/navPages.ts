// The palette's Pages rows, and which of them a viewer sees. Kept out of the
// palette so the rule (team features, then the surface registry's pages) is
// testable without mounting it.
import type { TeamFeatureKey } from "@codecast/shared/contracts";
import { localDay } from "./changesDay";
import type { SurfaceMode } from "./surfaceRules";
import type { ShortcutAction } from "../shortcuts/registry";

// Ranked by expected use. `secondary` pages are reachable only by typing:
// they'd otherwise pad the empty-palette view that lives or dies by scan speed.
export const NAV_PAGES: ReadonlyArray<{
  /** The developer name; a page named by mode reads SurfaceMode.page. */
  label: string;
  /** A function when the address depends on when the row is picked (yesterday's edition). */
  path: string | (() => string);
  icon: string;
  keywords: string;
  /** Other names the page answers to as if they were its label, such as the
   *  retired pages it replaced: typing one ranks the page like its own name. */
  aliases?: readonly string[];
  secondary?: boolean;
  /** Only listed while the active team has this opt-in feature on. */
  feature?: TeamFeatureKey;
  /** The shortcut that opens the page, shown on its row so the palette
   *  teaches the fast way. */
  action?: ShortcutAction;
}> = [
  { label: "Dashboard", path: "/team/activity", icon: "grid", keywords: "home sessions main activity feed team" },
  { label: "Inbox", path: "/inbox", icon: "inbox", keywords: "idle queue waiting", action: "nav.inbox" },
  // "Approvals" in hosted mode (SurfaceMode.page), where Cmd+2 opens it.
  { label: "Questions", path: "/questions", icon: "bell", keywords: "ok approve approvals questions decisions waiting answer" },
  { label: "Threads", path: "/threads", icon: "message", keywords: "threads replies comments conversations unread mentions dms" },
  { label: "Chat", path: "/chat", icon: "message", keywords: "channels team talk messages rooms", feature: "chat" },
  { label: "Community", path: "/community", icon: "message", keywords: "public rooms codecast users support questions" },
  { label: "Tasks", path: "/tasks", icon: "check", keywords: "todo work items" },
  { label: "Plans", path: "/plans", icon: "map", keywords: "milestones planning steps" },
  { label: "Calls", path: "/calls", icon: "phone", keywords: "huddle call transcript recording meeting summary voice", feature: "calls" },
  // "Docs", as the rail names it, so the palette and the rail agree.
  { label: "Docs", path: "/docs", icon: "file", keywords: "documents notes plans specs" },
  { label: "Code", path: "/repo", icon: "code", keywords: "repositories repository github git source commits branches pull requests history browse code" },
  { label: "Files", path: "/files", icon: "folder", keywords: "notes markdown obsidian files vault local" },
  { label: "Memory", path: "/memory", icon: "file", keywords: "claude code memories memory.md index recall learned facts feedback map graph" },
  { label: "Evals", path: "/evals", icon: "grid", keywords: "evals evaluations prompts surfaces regression trend freezes runs judge bisect attribution score", secondary: true },
  { label: "Multiplayer sim", path: "/evals/sim", icon: "workflow", keywords: "multiplayer sim simulator store invariants interleave scenarios shrink swim lanes sync", secondary: true },
  { label: "Triggers", path: "/triggers", icon: "clock", keywords: "triggers routines schedules cron automation recurring followup reminders" },
  { label: "Ops", path: "/ops", icon: "radar", keywords: "ops errors issues sentry posthog incidents checks jobs replays metrics alerts deploys production monitoring" },
  { label: "Ops: issues", path: "/ops/issues", icon: "radar", keywords: "errors issues groups exceptions stack sentry", secondary: true },
  { label: "Ops: replays", path: "/ops/replays", icon: "radar", keywords: "session replays recordings repro", secondary: true },
  { label: "Agent features", path: "/agent-features", icon: "grid", keywords: "agent features snippets cast install memory messaging tasks triggers browser computer skills stable context teach" },
  { label: "Capabilities", path: "/capabilities", icon: "grid", keywords: "skills mcp plugins drift machines library apps connect" },
  { label: "Pages", path: "/pages", icon: "file", keywords: "published html artifacts share cast publish gallery" },
  { label: "Mods", path: "/mods", icon: "grid", keywords: "mods plugins extensions customize panes commands blocks", secondary: true },
  { label: "Team Charts", path: "/team/charts", icon: "grid", keywords: "activity punchcard heatmap hours messages typed sends members stats graphs" },
  // The company on one canvas, and its two read views. Teams without the org
  // feature keep them too: goals and projects need no agents.
  { label: "Org", path: "/org", icon: "network", aliases: ["Team", "Company"], keywords: "people mission roles organization org chart reporting structure members canvas" },
  { label: "Goals", path: "/org/goals", icon: "map", aliases: ["Roadmap"], keywords: "goal initiatives objectives strategy mission health progress owner" },
  { label: "Projects", path: "/org/projects", icon: "grid", keywords: "project leads progress status active planning paused" },
  { label: "Changes", path: "/changes", icon: "newspaper", keywords: "open changes edition shipped released landed today commits stories what changed changelog", feature: "changes" },
  { label: "Changes: yesterday", path: () => `/changes?d=${localDay(-1)}`, icon: "newspaper", keywords: "edition shipped landed commits stories what changed", feature: "changes", secondary: true },
  { label: "Changes: risks only", path: "/changes?risk=1", icon: "newspaper", keywords: "edition risky risk flags deploy shipped what changed", feature: "changes", secondary: true },
  { label: "Search", path: "/search", icon: "search", keywords: "find query" },
  { label: "Settings", path: "/settings", icon: "settings", keywords: "preferences config profile general" },
  { label: "Workflows", path: "/routines", icon: "workflow", keywords: "orchestration runs graph dot gates routines", secondary: true },
  { label: "Expectations", path: "/expectations", icon: "file", keywords: "expectations how the product should behave rules behavior spec quoted sources proposals findings breaks judges", secondary: true },
  { label: "Line", path: "/line", icon: "workflow", keywords: "the line signals causes build cards watch shipped factory throughput", secondary: true },
  { label: "Line settings", path: "/line/settings", icon: "settings", keywords: "line profile finders principles prompting commands check prove eval ship size budget watch days cards cap stations prompts customize line.toml", secondary: true },
  { label: "Live Sessions", path: "/sessions", icon: "session", keywords: "running machines devices liveness", secondary: true },
  { label: "Resources", path: "/resources", icon: "session", keywords: "cpu memory activity monitor load pressure processes offload cloud", secondary: true },
  { label: "Notifications", path: "/notifications", icon: "bell", keywords: "alerts updates", secondary: true },
  { label: "Team Settings", path: "/settings/team", icon: "settings", keywords: "members invite workspace", secondary: true },
  { label: "Claude Accounts", path: "/settings/claude-accounts", icon: "settings", keywords: "account switch login oauth recovery auto continue resume retry", secondary: true },
  { label: "Sync & Privacy", path: "/settings/sync", icon: "settings", keywords: "projects sharing private", secondary: true },
  { label: "Devices", path: "/settings/devices", icon: "cpu", keywords: "machines daemons keys cli hosts", secondary: true },
  { label: "Migrate Sessions", path: "/settings/migrate", icon: "cpu", keywords: "move bulk cloud host laptop transfer batch", secondary: true },
  { label: "Plan", path: "/settings/plan", icon: "settings", keywords: "plan usage billing allowance upgrade subscription month meter plus pro free", secondary: true },
  { label: "Integrations", path: "/settings/integrations", icon: "link", keywords: "slack github linear google gmail notion connect oauth apps webhooks issues sync whisk mail email calendar", secondary: true },
  { label: "Provider Keys", path: "/settings/provider-keys", icon: "settings", keywords: "api keys openrouter anthropic openai", secondary: true },
  { label: "Notifications", path: "/settings/notifications", icon: "settings", keywords: "push email digest mentions mute", secondary: true },
  { label: "Sounds", path: "/settings/sounds", icon: "settings", keywords: "audio volume mute chime walkie", secondary: true },
  { label: "Calls", path: "/settings/calls", icon: "settings", keywords: "camera microphone mic devices walkie huddle meeting record", secondary: true },
];

export type NavPage = (typeof NAV_PAGES)[number];

/** A page's address for the surface registry: a dated address is still its
 *  page (/changes?d=... is /changes). */
export function pagePath(page: NavPage): string {
  return typeof page.path === "string" ? page.path : page.path();
}

/** The Pages rows to list, each with its name in this mode. Secondary pages
 *  show only while searching; a page whose team feature is off, or whose
 *  surface the mode hides (SurfaceMode.showsPage), never shows. */
export function palettePages(
  mode: SurfaceMode,
  featureOn: (feature: TeamFeatureKey | undefined) => boolean | undefined,
  searching: boolean,
): Array<{ page: NavPage; label: string }> {
  return NAV_PAGES
    .filter((p) => (searching || !p.secondary) && featureOn(p.feature) && mode.showsPage(pagePath(p)))
    .map((page) => ({ page, label: mode.page(pagePath(page), page.label) }));
}
