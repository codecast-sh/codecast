import { lazy } from "react";
import type { LazyExoticComponent, ComponentType } from "react";

/**
 * routes.manifest.ts — PROPOSED single source of truth for web routing (Wave 1 seed).
 *
 * Adding a page today means editing FOUR independent lists that must agree, and 3 of
 * the 4 drift modes are silent:
 *   1. src/App.tsx                — the React Router <Route> table (what URL renders what).
 *   2. components/TabContent.tsx  — the tab-shell pattern→component table (what the
 *                                   persistent dashboard tab system can render in place).
 *   3. src/compat/tabRouting.ts   — NON_TAB_EXACT / NON_TAB_PREFIXES (which routes live
 *                                   OUTSIDE the tab shell; intercepting them rewrites the
 *                                   URL without navigating).
 *   4. components/DashboardLayout — the isOnXPage booleans that compose isFullWidthPage
 *                                   (which pages drop the centered max-w container).
 *
 * This manifest captures every route once, with its real tab membership, full-width flag,
 * and guest-allowance, so a single edit can eventually drive all four (Wave 2 cutover).
 *
 * THIS FILE IS ADDITIVE. It does not yet drive any consumer. routes.manifest.test.ts is a
 * completeness/parity guard that fails loudly if any of the four sources drifts from here —
 * that guard is what makes the Wave 2 cutover safe.
 */

export type RouteEntry = {
  /**
   * The React Router path pattern, WITHOUT a leading slash for the root entry ("") and
   * WITH react-router `:param` syntax for dynamic segments — i.e. the exact `path` prop
   * passed to <Route> in App.tsx (children are pre-joined to their absolute path here, so
   * e.g. the Settings index is "settings", `/settings/cli` is "settings/cli").
   */
  path: string;
  /** Lazy component reference, mirroring the App.tsx / TabContent import target. */
  component: LazyExoticComponent<ComponentType<unknown>>;
  /**
   * The App.tsx layout group this route renders under. Drives nothing yet; recorded so the
   * Wave 2 generator can re-create the nested <Route element={<Layout/>}> structure.
   */
  layout: RouteLayout;
  /**
   * Set when the dashboard tab shell (TabContent) can render this route in place. The value
   * is the *static* TabContent pattern key (the path with `:param` placeholders), which is
   * how the parity test joins a TabContent regex back to its manifest entry. Routes that are
   * NOT tab-routable (marketing, auth, settings, share, palette, standalone-only) omit it.
   */
  tab?: string;
  /**
   * True when DashboardLayout treats this as a full-width page (one of the isOnXPage
   * booleans that compose isFullWidthPage) — it drops the centered `max-w-4xl` container.
   * Dynamic detail routes inherit this from their `startsWith("/x/")` check.
   */
  fullWidth?: boolean;
  /**
   * Guest (unauthenticated) access. Two flavors, both marked true here; the parity test and
   * Wave 2 must preserve BOTH (see rootCauseNotes):
   *   - "public": rendered with no AuthGuard at all (marketing, auth, share). guestKind="public".
   *   - "shell":  inside DashboardShell but explicitly allowed via guestOk (the /conversation/
   *               read-only share path). guestKind="shell".
   */
  guestOk?: boolean;
  guestKind?: "public" | "shell";
};

export type RouteLayout =
  | "marketing"
  | "auth"
  | "dashboardShell"
  | "standalone"
  | "share"
  | "codeReview"
  | "palette"
  | "settings";

// -- Lazy component refs — import targets copied verbatim from App.tsx / TabContent.tsx so
//    the manifest points at the exact same modules. --

const cast = <P>(c: LazyExoticComponent<ComponentType<P>>) =>
  c as unknown as LazyExoticComponent<ComponentType<unknown>>;

// Marketing
const Landing = lazy(() => import("@/app/(marketing)/page"));
const About = lazy(() => import("@/app/(marketing)/about/page"));
const Features = lazy(() => import("@/app/(marketing)/features/page"));
const Documentation = lazy(() => import("@/app/(marketing)/documentation/page"));
const Privacy = lazy(() => import("@/app/(marketing)/privacy/page"));
const Security = lazy(() => import("@/app/(marketing)/security/page"));
const Support = lazy(() => import("@/app/(marketing)/support/page"));
const Terms = lazy(() => import("@/app/(marketing)/terms/page"));
const Changelog = lazy(() => import("@/app/(marketing)/changelog/page"));

// Auth
const Login = lazy(() => import("@/app/login/page"));
const Signup = lazy(() => import("@/app/signup/page"));
const ForgotPassword = lazy(() => import("@/app/forgot-password/page"));
const ResetPassword = lazy(() => import("@/app/reset-password/page"));
const AuthCli = lazy(() => import("@/app/auth/cli/page"));
const JoinTeam = lazy(() => import("@/app/join/[code]/page"));

// Dashboard / tab-routable
const Inbox = lazy(() => import("@/app/inbox/page"));
const Feed = lazy(() => import("@/app/feed/page"));
const Crosstalk = lazy(() => import("@/app/crosstalk/page"));
const Search = lazy(() => import("@/app/search/page"));
const Notifications = lazy(() => import("@/app/notifications/page"));
const Conversation = lazy(() => import("@/app/conversation/[id]/page"));
const ConversationDiff = lazy(() => import("@/app/conversation/[id]/diff/page"));
const Docs = lazy(() => import("@/app/docs/page"));
const DocDetail = lazy(() => import("@/app/docs/[id]/page"));
const Plans = lazy(() => import("@/app/plans/page"));
const PlanDetail = lazy(() => import("@/app/plans/[id]/page"));
const Tasks = lazy(() => import("@/app/tasks/page"));
const TaskDetail = lazy(() => import("@/app/tasks/[id]/page"));
const Projects = lazy(() => import("@/app/projects/page"));
const ProjectDetail = lazy(() => import("@/app/projects/[id]/page"));
// Routines = our DOT-graph orchestration page at /routines (App import: @/app/workflows/page).
// Workflows = Anthropic dynamic-workflow runs dashboard at /workflows (import: @/app/workflows/dashboard).
const Routines = lazy(() => import("@/app/workflows/page"));
const Workflows = lazy(() => import("@/app/workflows/dashboard"));
const Schedules = lazy(() => import("@/app/schedules/page"));
const Sessions = lazy(() => import("@/app/sessions/page"));
const Anchor = lazy(() => import("@/app/anchor/page"));
const Team = lazy(() => import("@/app/team/page"));
const TeamActivity = lazy(() => import("@/app/team/activity/page"));
const TeamMember = lazy(() => import("@/app/team/[username]/page"));
const AdminDaemonLogs = lazy(() => import("@/app/admin/daemon-logs/page"));
const ConfigPage = lazy(() => import("@/app/config/page"));

// Standalone shell pages (outside the shared shell — page-specific props / not tab-routable)
const Explore = lazy(() => import("@/app/explore/page"));
const Timeline = lazy(() => import("@/app/timeline/page"));
const Windows = lazy(() => import("@/app/windows/page"));
const Orchestration = lazy(() => import("@/app/orchestration/page"));
const Roadmap = lazy(() => import("@/app/roadmap/page"));
const Cli = lazy(() => import("@/app/cli/page"));
const PublicProfile = lazy(() => import("@/app/u/[username]/page"));

// Sharing
const Share = lazy(() => import("@/app/share/[token]/page"));
const ShareMessage = lazy(() => import("@/app/share/message/[token]/page"));

// Code review
const CommitView = lazy(() => import("@/app/commit/[owner]/[repo]/[sha]/page"));
const PrView = lazy(() => import("@/app/pr/[owner]/[repo]/[number]/page"));
const ReviewView = lazy(() => import("@/app/review/[id]/page"));
const ReviewBatch = lazy(() => import("@/app/review/batch/page"));

// Palette
const Palette = lazy(() => import("@/app/palette/page"));

// Settings
const Settings = lazy(() => import("@/app/settings/page"));
const SettingsCli = lazy(() => import("@/app/settings/cli/page"));
const SettingsAgents = lazy(() => import("@/app/settings/agents/page"));
const SettingsDevices = lazy(() => import("@/app/settings/devices/page"));
const SettingsSync = lazy(() => import("@/app/settings/sync/page"));
const SettingsProfile = lazy(() => import("@/app/settings/profile/page"));
const SettingsAccounts = lazy(() => import("@/app/settings/accounts/page"));
const SettingsAccountsLinkGithub = lazy(() => import("@/app/settings/accounts/link-github/page"));
const SettingsClaudeAccounts = lazy(() => import("@/app/settings/claude-accounts/page"));
const SettingsTeam = lazy(() => import("@/app/settings/team/page"));
const SettingsTeamCreate = lazy(() => import("@/app/settings/team/create/page"));
const SettingsTeamJoin = lazy(() => import("@/app/settings/team/join/page"));
const SettingsNotifications = lazy(() => import("@/app/settings/notifications/page"));
const SettingsIntegrationsGithub = lazy(() => import("@/app/settings/integrations/github-app/page"));
const SettingsDesktop = lazy(() => import("@/app/settings/desktop/page"));

/**
 * The single source of truth. Order is grouped to mirror App.tsx for reviewability; the
 * test never relies on order (TabContent's own specificity ordering is independent).
 */
export const ROUTES: RouteEntry[] = [
  // -- Marketing (MarketingLayout, no AuthGuard → public) --
  { path: "", component: cast(Landing), layout: "marketing", guestOk: true, guestKind: "public" },
  { path: "about", component: cast(About), layout: "marketing", guestOk: true, guestKind: "public" },
  { path: "features", component: cast(Features), layout: "marketing", guestOk: true, guestKind: "public" },
  { path: "documentation", component: cast(Documentation), layout: "marketing", guestOk: true, guestKind: "public" },
  { path: "privacy", component: cast(Privacy), layout: "marketing", guestOk: true, guestKind: "public" },
  { path: "security", component: cast(Security), layout: "marketing", guestOk: true, guestKind: "public" },
  { path: "support", component: cast(Support), layout: "marketing", guestOk: true, guestKind: "public" },
  { path: "terms", component: cast(Terms), layout: "marketing", guestOk: true, guestKind: "public" },
  { path: "changelog", component: cast(Changelog), layout: "marketing", guestOk: true, guestKind: "public" },

  // -- Auth (bare routes, no AuthGuard → public) --
  { path: "login", component: cast(Login), layout: "auth", guestOk: true, guestKind: "public" },
  { path: "signup", component: cast(Signup), layout: "auth", guestOk: true, guestKind: "public" },
  { path: "forgot-password", component: cast(ForgotPassword), layout: "auth", guestOk: true, guestKind: "public" },
  { path: "reset-password", component: cast(ResetPassword), layout: "auth", guestOk: true, guestKind: "public" },
  { path: "auth/cli", component: cast(AuthCli), layout: "auth", guestOk: true, guestKind: "public" },
  { path: "join/:code", component: cast(JoinTeam), layout: "auth", guestOk: true, guestKind: "public" },

  // -- Dashboard tab shell (DashboardShell) — tab-routable; conversation routes are guest-OK --
  { path: "inbox", component: cast(Inbox), layout: "dashboardShell", tab: "/inbox", fullWidth: true },
  { path: "feed", component: cast(Feed), layout: "dashboardShell", tab: "/feed" },
  { path: "crosstalk", component: cast(Crosstalk), layout: "dashboardShell", tab: "/crosstalk", fullWidth: true },
  { path: "search", component: cast(Search), layout: "dashboardShell", tab: "/search" },
  { path: "notifications", component: cast(Notifications), layout: "dashboardShell", tab: "/notifications" },
  { path: "conversation/:id", component: cast(Conversation), layout: "dashboardShell", tab: "/conversation/:id", fullWidth: true, guestOk: true, guestKind: "shell" },
  { path: "conversation/:id/diff", component: cast(ConversationDiff), layout: "dashboardShell", tab: "/conversation/:id/diff", fullWidth: true, guestOk: true, guestKind: "shell" },
  { path: "docs", component: cast(Docs), layout: "dashboardShell", tab: "/docs", fullWidth: true },
  { path: "docs/:id", component: cast(DocDetail), layout: "dashboardShell", tab: "/docs/:id", fullWidth: true },
  { path: "plans", component: cast(Plans), layout: "dashboardShell", tab: "/plans", fullWidth: true },
  { path: "plans/:id", component: cast(PlanDetail), layout: "dashboardShell", tab: "/plans/:id", fullWidth: true },
  { path: "tasks", component: cast(Tasks), layout: "dashboardShell", tab: "/tasks", fullWidth: true },
  { path: "tasks/:id", component: cast(TaskDetail), layout: "dashboardShell", tab: "/tasks/:id", fullWidth: true },
  { path: "projects", component: cast(Projects), layout: "dashboardShell", tab: "/projects", fullWidth: true },
  { path: "projects/:id", component: cast(ProjectDetail), layout: "dashboardShell", tab: "/projects/:id", fullWidth: true },
  { path: "workflows", component: cast(Workflows), layout: "dashboardShell", tab: "/workflows", fullWidth: true },
  { path: "routines", component: cast(Routines), layout: "dashboardShell", tab: "/routines", fullWidth: true },
  { path: "schedules", component: cast(Schedules), layout: "dashboardShell", tab: "/schedules", fullWidth: true },
  { path: "sessions", component: cast(Sessions), layout: "dashboardShell", tab: "/sessions" },
  // Full-bleed via pageLayout's FULL_WIDTH_PATTERNS (like /sessions), not an isOnXPage flag.
  { path: "anchor", component: cast(Anchor), layout: "dashboardShell", tab: "/anchor" },
  { path: "team", component: cast(Team), layout: "dashboardShell", tab: "/team" },
  { path: "team/activity", component: cast(TeamActivity), layout: "dashboardShell", tab: "/team/activity" },
  { path: "team/:username", component: cast(TeamMember), layout: "dashboardShell", tab: "/team/:username" },
  { path: "admin/daemon-logs", component: cast(AdminDaemonLogs), layout: "dashboardShell", tab: "/admin/daemon-logs" },
  { path: "config", component: cast(ConfigPage), layout: "dashboardShell", tab: "/config" },

  // -- Standalone shell pages (outside the shared shell) --
  // `windows` is NOT in DashboardShell in App.tsx, yet TabContent CAN render it in
  // place — so it carries a `tab` here even though its layout is "standalone".
  { path: "explore", component: cast(Explore), layout: "standalone" },
  { path: "timeline", component: cast(Timeline), layout: "standalone" },
  { path: "windows", component: cast(Windows), layout: "standalone", tab: "/windows", fullWidth: true },
  { path: "orchestration", component: cast(Orchestration), layout: "standalone" },
  { path: "roadmap", component: cast(Roadmap), layout: "standalone" },
  { path: "cli", component: cast(Cli), layout: "standalone" },

  // -- Sharing (no AuthGuard → public) --
  { path: "share/:token", component: cast(Share), layout: "share", guestOk: true, guestKind: "public" },
  { path: "share/message/:token", component: cast(ShareMessage), layout: "share", guestOk: true, guestKind: "public" },

  // -- Code review --
  { path: "commit/:owner/:repo/:sha", component: cast(CommitView), layout: "codeReview", fullWidth: true },
  { path: "pr/:owner/:repo/:number", component: cast(PrView), layout: "codeReview", fullWidth: true },
  { path: "review/:id", component: cast(ReviewView), layout: "codeReview" },
  { path: "review/batch", component: cast(ReviewBatch), layout: "codeReview" },

  // -- Palette (PaletteLayout, transparent) --
  { path: "palette", component: cast(Palette), layout: "palette" },

  // -- Settings (SettingsLayout; index = /settings) --
  { path: "settings", component: cast(Settings), layout: "settings" },
  { path: "settings/cli", component: cast(SettingsCli), layout: "settings" },
  { path: "settings/agents", component: cast(SettingsAgents), layout: "settings" },
  { path: "settings/devices", component: cast(SettingsDevices), layout: "settings" },
  { path: "settings/sync", component: cast(SettingsSync), layout: "settings" },
  { path: "settings/profile", component: cast(SettingsProfile), layout: "settings" },
  { path: "settings/accounts", component: cast(SettingsAccounts), layout: "settings" },
  { path: "settings/accounts/link-github", component: cast(SettingsAccountsLinkGithub), layout: "settings" },
  { path: "settings/claude-accounts", component: cast(SettingsClaudeAccounts), layout: "settings" },
  { path: "settings/team", component: cast(SettingsTeam), layout: "settings" },
  { path: "settings/team/create", component: cast(SettingsTeamCreate), layout: "settings" },
  { path: "settings/team/join", component: cast(SettingsTeamJoin), layout: "settings" },
  { path: "settings/notifications", component: cast(SettingsNotifications), layout: "settings" },
  { path: "settings/integrations/github-app", component: cast(SettingsIntegrationsGithub), layout: "settings" },
  { path: "settings/desktop", component: cast(SettingsDesktop), layout: "settings" },

  // -- Public profiles (anonymous, guest-viewable, at the ROOT: /<handle>) --
  // MUST stay last: React Router ranks static segments above this dynamic one, so
  // every real route wins; only unmatched single-segment paths fall through here.
  // Claim collisions are blocked by RESERVED_USERNAMES in convex/users.ts.
  { path: ":username", component: cast(PublicProfile), layout: "standalone", guestOk: true, guestKind: "public" },
];

// -- Helpers (used by the parity test; safe for Wave 2 consumers too) --

/** Absolute URL form of a route's `path` (leading slash; "" → "/"). */
export function routeHref(path: string): string {
  return path === "" ? "/" : `/${path}`;
}

/** All tab-routable entries (those TabContent can render in place), keyed by their `tab` value. */
export function tabRoutes(): RouteEntry[] {
  return ROUTES.filter((r) => r.tab !== undefined);
}
