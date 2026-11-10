// The palette's Pages rows, and which of them a viewer sees. Kept out of the
// palette so the rule (team features) is testable without mounting it.
import type { TeamFeatureKey } from "@codecast/shared/contracts";
import { localDay } from "./changesDay";
import type { ShortcutAction } from "../shortcuts/registry";
import type { NavIconName } from "./navRegistry";
import { buildModernNavPages } from "./navPagesModern";

// Ranked by expected use. `secondary` pages are reachable only by typing:
// they'd otherwise pad the empty-palette view that lives or dies by scan speed.
export const NAV_PAGES: ReadonlyArray<{
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
  /** Modern's rows (lib/navPagesModern): the page's icon as the rail draws it. */
  navIcon?: NavIconName;
}> = [
  // "Feed", as the rail names it; the old palette name still finds it.
  { label: "Feed", path: "/team/activity", icon: "grid", aliases: ["Dashboard"], keywords: "home sessions main activity feed team" },
  { label: "Inbox", path: "/inbox", icon: "inbox", keywords: "idle queue waiting", action: "nav.inbox" },
  { label: "Decisions", path: "/decisions", icon: "bell", keywords: "ok approve approvals questions decisions waiting answer team mine" },
  { label: "Threads", path: "/threads", icon: "message", keywords: "threads replies comments conversations unread mentions dms" },
  { label: "Chat", path: "/chat", icon: "message", keywords: "channels team talk messages rooms", feature: "chat" },
  { label: "Community", path: "/community", icon: "message", keywords: "public rooms codecast users support questions" },
  { label: "Tasks", path: "/tasks", icon: "check", keywords: "todo work items" },
  { label: "Plans", path: "/plans", icon: "map", keywords: "milestones planning steps" },
  { label: "Calls", path: "/calls", icon: "phone", keywords: "huddle call transcript recording meeting summary voice", feature: "calls" },
  // "Docs", as the rail names it, so the palette and the rail agree.
  { label: "Docs", path: "/docs", icon: "file", keywords: "documents notes plans specs" },
  { label: "Code", path: "/repo", icon: "code", keywords: "repositories repository github git source commits branches pull requests history browse code" },
  { label: "Files", path: "/files", icon: "folder", keywords: "notes markdown obsidian files local" },
  { label: "Vault", path: "/vault", icon: "key", keywords: "secrets passwords keys api tokens credentials sign-ins logins 2fa otp env" },
  { label: "Memory", path: "/memory", icon: "file", keywords: "claude code memories memory.md index recall learned facts feedback map graph" },
  { label: "Evals", path: "/evals", icon: "grid", keywords: "evals evaluations prompts surfaces regression trend freezes runs judge bisect attribution score", secondary: true },
  { label: "Multiplayer sim", path: "/evals/sim", icon: "workflow", keywords: "multiplayer sim simulator store invariants interleave scenarios shrink swim lanes sync", secondary: true },
  { label: "Triggers", path: "/triggers", icon: "clock", keywords: "triggers routines schedules cron automation recurring followup reminders" },
  { label: "Ops", path: "/ops", icon: "radar", aliases: ["Signals"], keywords: "ops overview whats wrong now alerting regressed incidents errors issues sentry posthog checks jobs replays metrics alerts deploys production monitoring", action: "nav.ops" },
  // The Ops tabs in the shell's own order (opsPaths OPS_TABS).
  { label: "Ops: Timeline", path: "/ops/timeline", icon: "radar", aliases: ["Timeline"], keywords: "timeline events deploys transitions history", secondary: true },
  { label: "Ops: Issues", path: "/ops/issues", icon: "radar", aliases: ["Issues", "Errors"], keywords: "errors issues groups exceptions stack sentry regressed", secondary: true },
  { label: "Ops: Replays", path: "/ops/replays", icon: "radar", aliases: ["Replays", "Recordings"], keywords: "session replays recordings repro posthog rrweb", secondary: true },
  { label: "Ops: Metrics", path: "/ops/metrics", icon: "radar", aliases: ["Metrics", "Watches"], keywords: "metrics watches alerts thresholds hogql series charts", secondary: true },
  { label: "Ops: Apps", path: "/ops/apps", icon: "radar", keywords: "app connector readers actions grants calls", secondary: true },
  { label: "Ops: Sources", path: "/settings/integrations#product-sources", icon: "radar", aliases: ["Sources", "Source settings"], keywords: "ops sources connect sentry posthog ingest key sdk github ci health", secondary: true },
  { label: "Agent features", path: "/agent-features", icon: "grid", keywords: "agent features snippets cast install memory messaging tasks triggers browser computer skills stable context teach" },
  { label: "Capabilities", path: "/capabilities", icon: "grid", keywords: "skills mcp plugins drift machines library apps connect" },
  { label: "Pages", path: "/pages", icon: "file", keywords: "published html artifacts share cast publish gallery" },
  { label: "Mods", path: "/mods", icon: "grid", keywords: "mods plugins extensions customize panes commands blocks", secondary: true },
  { label: "Prompts", path: "/prompts", icon: "message", keywords: "prompts typed messages sent sessions day people what everyone asked wrote today yesterday" },
  { label: "Team Charts", path: "/team/charts", icon: "grid", keywords: "activity punchcard heatmap hours messages typed sends members stats graphs" },
  // The company on one canvas, and its two read views, at the rail's own
  // addresses. Teams without the org feature keep them too: goals and
  // projects need no agents.
  { label: "Session Map", path: "/map", icon: "map", aliases: ["Board", "Desk"], keywords: "canvas zoom piles arrange sessions board desk spatial roles reporting org overview all sessions" },
  { label: "Org", path: "/org", icon: "network", aliases: ["Team", "Company"], keywords: "people mission roles organization org chart reporting structure members canvas" },
  { label: "Goals", path: "/goals", icon: "map", aliases: ["Roadmap"], keywords: "goal initiatives objectives strategy mission health progress owner" },
  { label: "Projects", path: "/projects", icon: "grid", keywords: "project leads progress status active planning paused" },
  { label: "Deploys", path: "/deploys", icon: "rocket", aliases: ["Releases"], keywords: "deploy ship release live waiting rollback roll back ci backend web cli mobile desktop" },
  { label: "Changes", path: "/changes", icon: "newspaper", keywords: "open changes edition shipped released landed today commits stories what changed changelog", feature: "changes" },
  { label: "Changes: yesterday", path: () => `/changes?d=${localDay(-1)}`, icon: "newspaper", keywords: "edition shipped landed commits stories what changed", feature: "changes", secondary: true },
  { label: "Changes: risks only", path: "/changes?risk=1", icon: "newspaper", keywords: "edition risky risk flags deploy shipped what changed", feature: "changes", secondary: true },
  { label: "Search", path: "/search", icon: "search", keywords: "find query" },
  { label: "Settings", path: "/settings", icon: "settings", keywords: "preferences config profile general" },
  { label: "Workflows", path: "/routines", icon: "workflow", keywords: "orchestration runs graph dot gates routines", secondary: true },
  { label: "Trial", path: "/trial", icon: "file", keywords: "trial cards agentwatch line runs stop at the card review answer what would ship", secondary: true, feature: "line" },
  { label: "Expectations", path: "/expectations", icon: "file", keywords: "expectations how the product should behave rules behavior spec quoted sources proposals findings breaks judges", secondary: true },
  { label: "Flows", path: "/flows", icon: "workflow", keywords: "flows line findings problems signals causes build cards watch shipped factory throughput owners", secondary: true, feature: "line" },
  { label: "Flow settings", path: "/flows/settings", icon: "settings", keywords: "flow line profile finders principles prompting commands check prove eval ship size budget watch days cards cap stations steps prompts customize line.toml", secondary: true, feature: "line" },
  { label: "Live Sessions", path: "/sessions", icon: "session", keywords: "running machines devices liveness", secondary: true },
  { label: "Resources", path: "/resources", icon: "session", keywords: "cpu memory activity monitor load pressure processes offload cloud", secondary: true },
  { label: "Notifications", path: "/notifications", icon: "bell", keywords: "alerts updates", secondary: true },
  { label: "Team Settings", path: "/settings/team", icon: "settings", keywords: "members invite workspace", secondary: true },
  { label: "Managed devices", path: "/settings/managed-devices", icon: "settings", keywords: "mdm jamf kandji intune enrollment profile pkg policy fleet", secondary: true },
  { label: "Account pool", path: "/settings/account-pool", icon: "settings", keywords: "shared team claude accounts usage who spent tokens", secondary: true },
  { label: "Claude Accounts", path: "/settings/claude-accounts", icon: "settings", keywords: "account switch login oauth recovery auto continue resume retry", secondary: true },
  { label: "Sync & Privacy", path: "/settings/sync", icon: "settings", keywords: "projects sharing private", secondary: true },
  { label: "Devices", path: "/settings/devices", icon: "cpu", keywords: "machines daemons keys cli hosts", secondary: true },
  { label: "Migrate Sessions", path: "/settings/migrate", icon: "cpu", keywords: "move bulk cloud host laptop transfer batch", secondary: true },
  { label: "Plan", path: "/settings/plan", icon: "settings", keywords: "plan usage billing allowance upgrade subscription month meter plus pro free", secondary: true },
  { label: "Integrations", path: "/settings/integrations", icon: "link", keywords: "slack github linear google gmail notion connect oauth apps webhooks issues sync whisk mail email calendar", secondary: true },
  { label: "Provider Keys", path: "/settings/provider-keys", icon: "settings", keywords: "api keys openrouter anthropic openai", secondary: true },
  { label: "Settings: Notifications", path: "/settings/notifications", icon: "settings", keywords: "push email digest mentions mute", secondary: true },
  { label: "Keyboard Shortcuts", path: "/settings/keyboard", icon: "settings", keywords: "keys hotkeys keybindings rebind customize chords", secondary: true },
  { label: "Sounds", path: "/settings/sounds", icon: "settings", keywords: "audio volume mute chime walkie", secondary: true },
  { label: "Settings: Calls", path: "/settings/calls", icon: "settings", keywords: "camera microphone mic devices walkie huddle meeting record", secondary: true },
];

export type NavPage = (typeof NAV_PAGES)[number];

let modernPages: ReadonlyArray<NavPage> | null = null;
/** Modern's rows (lib/navPagesModern), built once from these. */
function modernNavPages(): ReadonlyArray<NavPage> {
  return (modernPages ??= buildModernNavPages(NAV_PAGES));
}

/** A page's address: a dated address is still its page (/changes?d=... is /changes). */
export function pagePath(page: NavPage): string {
  return typeof page.path === "string" ? page.path : page.path();
}

/** The Pages rows to list. Secondary pages show only while searching; a
 *  page whose team feature is off never shows. The Modern style lists the
 *  registry's pages under the Modern rail's names (lib/navPagesModern). */
export function palettePages(
  featureOn: (feature: TeamFeatureKey | undefined) => boolean | undefined,
  searching: boolean,
  modern = false,
): Array<{ page: NavPage; label: string }> {
  return (modern ? modernNavPages() : NAV_PAGES)
    .filter((p) => (searching || !p.secondary) && featureOn(p.feature))
    .map((page) => ({ page, label: page.label }));
}

/**
 * Whether a query names a page, so the palette leads with Pages (a
 * destination before the objects named alike): one of a page's names (its
 * label or an alias) is the query, or starts with it once the query is
 * `minPrefix` letters long.
 */
export function queryNamesPage(rows: ReadonlyArray<{ page: Pick<NavPage, "aliases">; label: string }>, query: string, minPrefix: number): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return false;
  return rows.some(({ page, label }) => [label, ...(page.aliases ?? [])].some((name) => {
    const n = name.toLowerCase();
    return n === q || (q.length >= minPrefix && n.startsWith(q));
  }));
}
