import { lazy, Suspense, ReactNode, useEffect } from "react";
import { BootFallback } from "@/components/BootFallback";
import { Routes, Route } from "react-router";
import NProgress from "nprogress";
import { Providers } from "./providers";
import { MarketingLayout } from "./layouts/MarketingLayout";
import { TransparentWindowLayout } from "./layouts/TransparentWindowLayout";
import { SettingsLayout } from "./layouts/SettingsLayout";
import DashboardShell from "./layouts/DashboardShell";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { useMentionLinkNavigation } from "@/hooks/useMentionLinkNavigation";

const Landing = lazy(() => import("@/app/(marketing)/page"));
const About = lazy(() => import("@/app/(marketing)/about/page"));
const Features = lazy(() => import("@/app/(marketing)/features/page"));
const Documentation = lazy(() => import("@/app/(marketing)/documentation/page"));
const DocumentationGuide = lazy(() => import("@/app/(marketing)/documentation/guides/GuidePage"));
const Privacy = lazy(() => import("@/app/(marketing)/privacy/page"));
const Security = lazy(() => import("@/app/(marketing)/security/page"));
const Support = lazy(() => import("@/app/(marketing)/support/page"));
const Terms = lazy(() => import("@/app/(marketing)/terms/page"));
const Changelog = lazy(() => import("@/app/(marketing)/changelog/page"));
const Pricing = lazy(() => import("@/app/(marketing)/pricing/page"));
const Download = lazy(() => import("@/app/(marketing)/download/page"));
const BlogIndex = lazy(() => import("@/app/(marketing)/blog/page"));
const BlogGitBlame = lazy(() => import("@/app/(marketing)/blog/git-blame-for-ai-agents/page"));
const BlogAgentInbox = lazy(() => import("@/app/(marketing)/blog/an-inbox-for-your-agents/page"));
const BlogTeamMemory = lazy(() => import("@/app/(marketing)/blog/your-agents-forget-your-team-does-not/page"));
const BlogTriggers = lazy(() => import("@/app/(marketing)/blog/this-post-wrote-itself/page"));
const BlogPublish = lazy(() => import("@/app/(marketing)/blog/a-url-for-everything-your-agent-makes/page"));
const CompareIndex = lazy(() => import("@/app/(marketing)/compare/page"));
const Compare = lazy(() => import("@/app/(marketing)/compare/ComparePage"));

const Login = lazy(() => import("@/app/login/page"));
const Signup = lazy(() => import("@/app/signup/page"));
const ForgotPassword = lazy(() => import("@/app/forgot-password/page"));
const ResetPassword = lazy(() => import("@/app/reset-password/page"));
const AuthCli = lazy(() => import("@/app/auth/cli/page"));
const ArtifactAuth = lazy(() => import("@/app/artifacts/auth/page"));
const JoinTeam = lazy(() => import("@/app/join/[code]/page"));

const Inbox = lazy(() => import("@/app/inbox/page"));
const Feed = lazy(() => import("@/app/feed/page"));
const Crosstalk = lazy(() => import("@/app/crosstalk/page"));
const Chat = lazy(() => import("@/app/chat/page"));
const Search = lazy(() => import("@/app/search/page"));
const Explore = lazy(() => import("@/app/explore/page"));
const Timeline = lazy(() => import("@/app/timeline/page"));
const Notifications = lazy(() => import("@/app/notifications/page"));
const Questions = lazy(() => import("@/app/questions/page"));
const Threads = lazy(() => import("@/app/threads/page"));

const Conversation = lazy(() => import("@/app/conversation/[id]/page"));
const ConversationDiff = lazy(() => import("@/app/conversation/[id]/diff/page"));
const Share = lazy(() => import("@/app/share/[token]/page"));
const ShareMessage = lazy(() => import("@/app/share/message/[token]/page"));
const ShareDoc = lazy(() => import("@/app/share/doc/[token]/page"));
const SharePlan = lazy(() => import("@/app/share/plan/[token]/page"));
const PublicProfile = lazy(() => import("@/app/u/[username]/page"));

const CommitView = lazy(() => import("@/app/commit/[owner]/[repo]/[sha]/page"));
const PrView = lazy(() => import("@/app/pr/[owner]/[repo]/[number]/page"));
const ReviewView = lazy(() => import("@/app/review/[id]/page"));
const ReviewBatch = lazy(() => import("@/app/review/batch/page"));

const Docs = lazy(() => import("@/app/docs/page"));
const Capabilities = lazy(() => import("@/app/capabilities/page"));
const Vault = lazy(() => import("@/app/vault/page"));
const Artifacts = lazy(() => import("@/app/artifacts/page"));
const DocDetail = lazy(() => import("@/app/docs/[id]/page"));
const Plans = lazy(() => import("@/app/plans/page"));
const Calls = lazy(() => import("@/app/calls/page"));
const CallDetailEntry = lazy(() => import("@/app/calls/[id]/page"));
const PlanDetail = lazy(() => import("@/app/plans/[id]/page"));
const Tasks = lazy(() => import("@/app/tasks/page"));
const TaskDetail = lazy(() => import("@/app/tasks/[id]/page"));
const Projects = lazy(() => import("@/app/projects/page"));
const ProjectDetail = lazy(() => import("@/app/projects/[id]/page"));
// Routines = our DOT-graph orchestration (was "Workflows"); the graph page lives at /routines.
// Workflows = Anthropic dynamic-workflow runs dashboard at /workflows.
const Routines = lazy(() => import("@/app/workflows/page"));
const Workflows = lazy(() => import("@/app/workflows/dashboard"));
// Triggers (renamed from "Schedules"; /schedules stays routable as an alias).
const Triggers = lazy(() => import("@/app/triggers/page"));
const TriggerDetail = lazy(() => import("@/app/triggers/[id]/page"));
const Anchor = lazy(() => import("@/app/anchor/page"));

const Team = lazy(() => import("@/app/team/page"));
const TeamActivity = lazy(() => import("@/app/team/activity/page"));
const TeamCharts = lazy(() => import("@/app/team/charts/page"));
const TeamMember = lazy(() => import("@/app/team/[username]/page"));

const Orchestration = lazy(() => import("@/app/orchestration/page"));
const Roadmap = lazy(() => import("@/app/roadmap/page"));
const Cli = lazy(() => import("@/app/cli/page"));
const AdminDaemonLogs = lazy(() => import("@/app/admin/daemon-logs/page"));
const ConfigPage = lazy(() => import("@/app/config/page"));
const Sessions = lazy(() => import("@/app/sessions/page"));
const Windows = lazy(() => import("@/app/windows/page"));

const Palette = lazy(() => import("@/app/palette/page"));
const People = lazy(() => import("@/app/people/page"));
const CallPanel = lazy(() => import("@/app/call-panel/page"));
const Faces = lazy(() => import("@/app/faces/page"));
const MeetingOffer = lazy(() => import("@/app/meeting-offer/page"));
const CallRing = lazy(() => import("@/app/call-ring/page"));

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
const SettingsIntegrations = lazy(() => import("@/app/settings/integrations/page"));
const SettingsDesktop = lazy(() => import("@/app/settings/desktop/page"));

function E({ name, children }: { name: string; children: ReactNode }) {
  return <ErrorBoundary name={name} level="panel">{children}</ErrorBoundary>;
}

function RouteFallback() {
  useEffect(() => {
    NProgress.start();
    return () => { NProgress.done(); };
  }, []);
  return null;
}

export function App() {
  useMentionLinkNavigation();
  return (
    <Suspense fallback={<BootFallback />}>
    <Providers>
      <ErrorBoundary name="App" level="panel">
        <Suspense fallback={<RouteFallback />}>
          <Routes>
            {/* Marketing - light mode layout */}
            <Route element={<MarketingLayout />}>
              <Route index element={<E name="Landing"><Landing /></E>} />
              <Route path="about" element={<E name="About"><About /></E>} />
              <Route path="features" element={<E name="Features"><Features /></E>} />
              <Route path="documentation" element={<E name="Documentation"><Documentation /></E>} />
              <Route path="documentation/:slug" element={<E name="DocumentationGuide"><DocumentationGuide /></E>} />
              <Route path="privacy" element={<E name="Privacy"><Privacy /></E>} />
              <Route path="security" element={<E name="Security"><Security /></E>} />
              <Route path="support" element={<E name="Support"><Support /></E>} />
              <Route path="terms" element={<E name="Terms"><Terms /></E>} />
              <Route path="changelog" element={<E name="Changelog"><Changelog /></E>} />
              <Route path="pricing" element={<E name="Pricing"><Pricing /></E>} />
              <Route path="download" element={<E name="Download"><Download /></E>} />
              <Route path="blog" element={<E name="BlogIndex"><BlogIndex /></E>} />
              <Route path="blog/git-blame-for-ai-agents" element={<E name="BlogGitBlame"><BlogGitBlame /></E>} />
              <Route path="blog/an-inbox-for-your-agents" element={<E name="BlogAgentInbox"><BlogAgentInbox /></E>} />
              <Route path="blog/your-agents-forget-your-team-does-not" element={<E name="BlogTeamMemory"><BlogTeamMemory /></E>} />
              <Route path="blog/this-post-wrote-itself" element={<E name="BlogTriggers"><BlogTriggers /></E>} />
              <Route path="blog/a-url-for-everything-your-agent-makes" element={<E name="BlogPublish"><BlogPublish /></E>} />
              <Route path="compare" element={<E name="CompareIndex"><CompareIndex /></E>} />
              <Route path="compare/:slug" element={<E name="Compare"><Compare /></E>} />
            </Route>

            {/* Auth */}
            <Route path="login" element={<E name="Login"><Login /></E>} />
            <Route path="signup" element={<E name="Signup"><Signup /></E>} />
            <Route path="forgot-password" element={<E name="ForgotPassword"><ForgotPassword /></E>} />
            <Route path="reset-password" element={<E name="ResetPassword"><ResetPassword /></E>} />
            <Route path="auth/cli" element={<E name="AuthCli"><AuthCli /></E>} />
            {/* Identity relay for published-page comments (artifact bar → sign in). */}
            <Route path="pages/auth" element={<E name="ArtifactAuth"><ArtifactAuth /></E>} />
            <Route path="join/:code" element={<E name="JoinTeam"><JoinTeam /></E>} />

            {/* Dashboard tab shell — one stable layout route keeps the sidebar,
                tab bar and mounted TabContent panes alive across navigations so
                browser back/forward never remounts the shell. Only tab-routable
                pages (those TabContent can render) belong here. */}
            <Route element={<DashboardShell />}>
              <Route path="inbox" element={<E name="Inbox"><Inbox /></E>} />
              <Route path="feed" element={<E name="Feed"><Feed /></E>} />
              <Route path="crosstalk" element={<E name="Crosstalk"><Crosstalk /></E>} />
              {/* Team chat. The bare route picks the busiest channel; the
                  parameterized one is the permalink the server mints
                  (convex/chatText.ts chatPermalink → /chat/<id>?m=<msg>). */}
              <Route path="chat" element={<E name="Chat"><Chat /></E>} />
              <Route path="chat/:channelId" element={<E name="Chat"><Chat /></E>} />
              <Route path="search" element={<E name="Search"><Search /></E>} />
              <Route path="notifications" element={<E name="Notifications"><Notifications /></E>} />
              <Route path="questions" element={<E name="Questions"><Questions /></E>} />
              <Route path="threads" element={<E name="Threads"><Threads /></E>} />
              <Route path="conversation/:id" element={<E name="Conversation"><Conversation /></E>} />
              <Route path="conversation/:id/diff" element={<E name="ConversationDiff"><ConversationDiff /></E>} />
              <Route path="docs" element={<E name="Docs"><Docs /></E>} />
              <Route path="capabilities" element={<E name="Capabilities"><Capabilities /></E>} />
              <Route path="files" element={<E name="Files"><Vault /></E>} />
              {/* /vault = pre-rename alias for /files. Permanent: `cast vault open`
                  has printed /vault?f=… deep links into sessions, notes and users'
                  markdown files since before the rename. Never remove it. */}
              <Route path="vault" element={<E name="Files"><Vault /></E>} />
              <Route path="pages" element={<E name="Pages"><Artifacts /></E>} />
              {/* /artifacts = pre-rename alias for /pages */}
              <Route path="artifacts" element={<E name="Pages"><Artifacts /></E>} />
              <Route path="docs/:id" element={<E name="DocDetail"><DocDetail /></E>} />
              <Route path="calls" element={<E name="Calls"><Calls /></E>} />
              <Route path="calls/:id" element={<E name="CallDetailEntry"><CallDetailEntry /></E>} />
              <Route path="plans" element={<E name="Plans"><Plans /></E>} />
              <Route path="plans/:id" element={<E name="PlanDetail"><PlanDetail /></E>} />
              <Route path="tasks" element={<E name="Tasks"><Tasks /></E>} />
              <Route path="tasks/:id" element={<E name="TaskDetail"><TaskDetail /></E>} />
              <Route path="projects" element={<E name="Projects"><Projects /></E>} />
              <Route path="projects/:id" element={<E name="ProjectDetail"><ProjectDetail /></E>} />
              {/* A task opened inside a project — same component as the project
                  itself, so the project never unmounts around it. */}
              <Route path="projects/:id/:taskId" element={<E name="ProjectDetail"><ProjectDetail /></E>} />
              <Route path="workflows" element={<E name="Workflows"><Workflows /></E>} />
              <Route path="routines" element={<E name="Routines"><Routines /></E>} />
              <Route path="triggers" element={<E name="Triggers"><Triggers /></E>} />
              <Route path="triggers/:id" element={<E name="TriggerDetail"><TriggerDetail /></E>} />
              <Route path="schedules" element={<E name="Triggers"><Triggers /></E>} />
              <Route path="schedules/:id" element={<E name="TriggerDetail"><TriggerDetail /></E>} />
              <Route path="sessions" element={<E name="Sessions"><Sessions /></E>} />
              <Route path="anchor" element={<E name="Anchor"><Anchor /></E>} />
              <Route path="team" element={<E name="Team"><Team /></E>} />
              <Route path="team/activity" element={<E name="TeamActivity"><TeamActivity /></E>} />
              <Route path="team/charts" element={<E name="TeamCharts"><TeamCharts /></E>} />
              <Route path="team/:username" element={<E name="TeamMember"><TeamMember /></E>} />
              <Route path="admin/daemon-logs" element={<E name="AdminDaemonLogs"><AdminDaemonLogs /></E>} />
              <Route path="config" element={<E name="ConfigPage"><ConfigPage /></E>} />
            </Route>

            {/* Standalone shell pages — kept outside the shared shell because they
                pass page-specific props to DashboardLayout (windows' hideSidebar) or
                aren't tab-routable. */}
            <Route path="explore" element={<E name="Explore"><Explore /></E>} />
            <Route path="timeline" element={<E name="Timeline"><Timeline /></E>} />
            <Route path="windows" element={<E name="Windows"><Windows /></E>} />
            <Route path="orchestration" element={<E name="Orchestration"><Orchestration /></E>} />
            <Route path="roadmap" element={<E name="Roadmap"><Roadmap /></E>} />
            <Route path="cli" element={<E name="Cli"><Cli /></E>} />

            {/* Sharing. (Published artifacts at /a/<slug> are NOT here: they're
                a server-rendered page — Hono route in prod, vite middleware in
                dev — so the share link never boots the SPA.) */}
            <Route path="share/:token" element={<E name="Share"><Share /></E>} />
            <Route path="share/message/:token" element={<E name="ShareMessage"><ShareMessage /></E>} />
            <Route path="share/doc/:token" element={<E name="ShareDoc"><ShareDoc /></E>} />
            <Route path="share/plan/:token" element={<E name="SharePlan"><SharePlan /></E>} />

            {/* Code review */}
            <Route path="commit/:owner/:repo/:sha" element={<E name="CommitView"><CommitView /></E>} />
            <Route path="pr/:owner/:repo/:number" element={<E name="PrView"><PrView /></E>} />
            <Route path="review/:id" element={<E name="ReviewView"><ReviewView /></E>} />
            <Route path="review/batch" element={<E name="ReviewBatch"><ReviewBatch /></E>} />

            {/* The windows with no background: the palette card, and the call
                window, whose two small sizes are circles of people's faces over
                the work. Both are frameless transparent Electron windows; the
                layout is what keeps the app's own body background from filling
                their glass.

                The call window MUST stay above ":username" or the profile
                catch-all eats it — same rule as /people. */}
            <Route element={<TransparentWindowLayout />}>
              <Route path="palette" element={<E name="Palette"><Palette /></E>} />
              <Route path="call-panel" element={<E name="CallPanel"><CallPanel /></E>} />
              <Route path="faces" element={<E name="Faces"><Faces /></E>} />
              <Route path="meeting-offer" element={<E name="MeetingOffer"><MeetingOffer /></E>} />
              <Route path="call-ring" element={<E name="CallRing"><CallRing /></E>} />
            </Route>

            {/* The people window (AIM buddy list): the roster, calling and the
                walkie in a window of their own. Own <Route>, no tab shell and no
                DashboardLayout — it is a whole window, not a page inside one.
                MUST stay above ":username" or the profile catch-all eats it. */}
            <Route path="people" element={<E name="People"><People /></E>} />

            {/* Settings - shared sidebar layout */}
            <Route path="settings" element={<SettingsLayout />}>
              <Route index element={<E name="Settings"><Settings /></E>} />
              <Route path="cli" element={<E name="SettingsCli"><SettingsCli /></E>} />
              <Route path="agents" element={<E name="SettingsAgents"><SettingsAgents /></E>} />
              <Route path="devices" element={<E name="SettingsDevices"><SettingsDevices /></E>} />
              <Route path="sync" element={<E name="SettingsSync"><SettingsSync /></E>} />
              <Route path="profile" element={<E name="SettingsProfile"><SettingsProfile /></E>} />
              <Route path="accounts" element={<E name="SettingsAccounts"><SettingsAccounts /></E>} />
              <Route path="accounts/link-github" element={<E name="SettingsLinkGithub"><SettingsAccountsLinkGithub /></E>} />
              <Route path="claude-accounts" element={<E name="SettingsClaudeAccounts"><SettingsClaudeAccounts /></E>} />
              <Route path="team" element={<E name="SettingsTeam"><SettingsTeam /></E>} />
              <Route path="team/create" element={<E name="SettingsTeamCreate"><SettingsTeamCreate /></E>} />
              <Route path="team/join" element={<E name="SettingsTeamJoin"><SettingsTeamJoin /></E>} />
              <Route path="notifications" element={<E name="SettingsNotifications"><SettingsNotifications /></E>} />
              <Route path="integrations" element={<E name="SettingsIntegrations"><SettingsIntegrations /></E>} />
              {/* Old deep link; the GitHub install flow still returns here. */}
              <Route path="integrations/github-app" element={<E name="SettingsIntegrations"><SettingsIntegrations /></E>} />
              <Route path="desktop" element={<E name="SettingsDesktop"><SettingsDesktop /></E>} />
            </Route>

            {/* Public profiles — anonymous, guest-viewable, at the ROOT (/<handle>).
                MUST be last: React Router ranks static segments above this dynamic
                one, so every real route still wins; only unmatched single-segment
                paths fall through here. Claim collisions are blocked by
                RESERVED_USERNAMES in convex/users.ts (keep it in sync with the
                top-level routes above). NOT in the dashboard shell or TabContent;
                the query layer enforces the opt-in 404. */}
            <Route path=":username" element={<E name="PublicProfile"><PublicProfile /></E>} />
          </Routes>
        </Suspense>
      </ErrorBoundary>
    </Providers>
    </Suspense>
  );
}
