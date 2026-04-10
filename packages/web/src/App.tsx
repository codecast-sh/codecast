import { lazy, Suspense, ReactNode } from "react";
import { Routes, Route } from "react-router";
import { Providers } from "./providers";
import { MarketingLayout } from "./layouts/MarketingLayout";
import { PaletteLayout } from "./layouts/PaletteLayout";
import { SettingsLayout } from "./layouts/SettingsLayout";
import { ErrorBoundary } from "@/components/ErrorBoundary";

const Landing = lazy(() => import("@/app/(marketing)/page"));
const About = lazy(() => import("@/app/(marketing)/about/page"));
const Features = lazy(() => import("@/app/(marketing)/features/page"));
const Documentation = lazy(() => import("@/app/(marketing)/documentation/page"));
const Privacy = lazy(() => import("@/app/(marketing)/privacy/page"));
const Security = lazy(() => import("@/app/(marketing)/security/page"));
const Support = lazy(() => import("@/app/(marketing)/support/page"));
const Terms = lazy(() => import("@/app/(marketing)/terms/page"));

const Login = lazy(() => import("@/app/login/page"));
const Signup = lazy(() => import("@/app/signup/page"));
const ForgotPassword = lazy(() => import("@/app/forgot-password/page"));
const ResetPassword = lazy(() => import("@/app/reset-password/page"));
const AuthCli = lazy(() => import("@/app/auth/cli/page"));
const JoinTeam = lazy(() => import("@/app/join/[code]/page"));

const Dashboard = lazy(() => import("@/app/dashboard/page"));
const Inbox = lazy(() => import("@/app/inbox/page"));
const Feed = lazy(() => import("@/app/feed/page"));
const Search = lazy(() => import("@/app/search/page"));
const Explore = lazy(() => import("@/app/explore/page"));
const Timeline = lazy(() => import("@/app/timeline/page"));
const Notifications = lazy(() => import("@/app/notifications/page"));

const Conversation = lazy(() => import("@/app/conversation/[id]/page"));
const ConversationDiff = lazy(() => import("@/app/conversation/[id]/diff/page"));
const Share = lazy(() => import("@/app/share/[token]/page"));
const ShareMessage = lazy(() => import("@/app/share/message/[token]/page"));

const CommitView = lazy(() => import("@/app/commit/[owner]/[repo]/[sha]/page"));
const PrView = lazy(() => import("@/app/pr/[owner]/[repo]/[number]/page"));
const ReviewView = lazy(() => import("@/app/review/[id]/page"));
const ReviewBatch = lazy(() => import("@/app/review/batch/page"));

const DocsLayout = lazy(() => import("@/app/docs/layout"));
const Docs = lazy(() => import("@/app/docs/page"));
const DocDetail = lazy(() => import("@/app/docs/[id]/page"));
const Plans = lazy(() => import("@/app/plans/page"));
const PlanDetail = lazy(() => import("@/app/plans/[id]/page"));
const Tasks = lazy(() => import("@/app/tasks/page"));
const TaskDetail = lazy(() => import("@/app/tasks/[id]/page"));
const Projects = lazy(() => import("@/app/projects/page"));
const ProjectDetail = lazy(() => import("@/app/projects/[id]/page"));
const Workflows = lazy(() => import("@/app/workflows/page"));

const Team = lazy(() => import("@/app/team/page"));
const TeamActivity = lazy(() => import("@/app/team/activity/page"));
const TeamMember = lazy(() => import("@/app/team/[username]/page"));

const Orchestration = lazy(() => import("@/app/orchestration/page"));
const Roadmap = lazy(() => import("@/app/roadmap/page"));
const Cli = lazy(() => import("@/app/cli/page"));
const AdminDaemonLogs = lazy(() => import("@/app/admin/daemon-logs/page"));
const ConfigPage = lazy(() => import("@/app/config/page"));
const Sessions = lazy(() => import("@/app/sessions/page"));
const Windows = lazy(() => import("@/app/windows/page"));

const Palette = lazy(() => import("@/app/palette/page"));

const Settings = lazy(() => import("@/app/settings/page"));
const SettingsCli = lazy(() => import("@/app/settings/cli/page"));
const SettingsAgents = lazy(() => import("@/app/settings/agents/page"));
const SettingsSync = lazy(() => import("@/app/settings/sync/page"));
const SettingsProfile = lazy(() => import("@/app/settings/profile/page"));
const SettingsAccounts = lazy(() => import("@/app/settings/accounts/page"));
const SettingsAccountsLinkGithub = lazy(() => import("@/app/settings/accounts/link-github/page"));
const SettingsTeam = lazy(() => import("@/app/settings/team/page"));
const SettingsTeamCreate = lazy(() => import("@/app/settings/team/create/page"));
const SettingsTeamJoin = lazy(() => import("@/app/settings/team/join/page"));
const SettingsNotifications = lazy(() => import("@/app/settings/notifications/page"));
const SettingsIntegrationsGithub = lazy(() => import("@/app/settings/integrations/github-app/page"));
const SettingsDesktop = lazy(() => import("@/app/settings/desktop/page"));

function E({ name, children }: { name: string; children: ReactNode }) {
  return <ErrorBoundary name={name} level="panel">{children}</ErrorBoundary>;
}

export function App() {
  return (
    <Providers>
      <ErrorBoundary name="App" level="panel">
        <Suspense>
          <Routes>
            {/* Marketing - light mode layout */}
            <Route element={<MarketingLayout />}>
              <Route index element={<E name="Landing"><Landing /></E>} />
              <Route path="about" element={<E name="About"><About /></E>} />
              <Route path="features" element={<E name="Features"><Features /></E>} />
              <Route path="documentation" element={<E name="Documentation"><Documentation /></E>} />
              <Route path="privacy" element={<E name="Privacy"><Privacy /></E>} />
              <Route path="security" element={<E name="Security"><Security /></E>} />
              <Route path="support" element={<E name="Support"><Support /></E>} />
              <Route path="terms" element={<E name="Terms"><Terms /></E>} />
            </Route>

            {/* Auth */}
            <Route path="login" element={<E name="Login"><Login /></E>} />
            <Route path="signup" element={<E name="Signup"><Signup /></E>} />
            <Route path="forgot-password" element={<E name="ForgotPassword"><ForgotPassword /></E>} />
            <Route path="reset-password" element={<E name="ResetPassword"><ResetPassword /></E>} />
            <Route path="auth/cli" element={<E name="AuthCli"><AuthCli /></E>} />
            <Route path="join/:code" element={<E name="JoinTeam"><JoinTeam /></E>} />

            {/* App */}
            <Route path="dashboard" element={<E name="Dashboard"><Dashboard /></E>} />
            <Route path="inbox" element={<E name="Inbox"><Inbox /></E>} />
            <Route path="feed" element={<E name="Feed"><Feed /></E>} />
            <Route path="search" element={<E name="Search"><Search /></E>} />
            <Route path="explore" element={<E name="Explore"><Explore /></E>} />
            <Route path="timeline" element={<E name="Timeline"><Timeline /></E>} />
            <Route path="notifications" element={<E name="Notifications"><Notifications /></E>} />

            {/* Conversations & sharing */}
            <Route path="conversation/:id" element={<E name="Conversation"><Conversation /></E>} />
            <Route path="conversation/:id/diff" element={<E name="ConversationDiff"><ConversationDiff /></E>} />
            <Route path="share/:token" element={<E name="Share"><Share /></E>} />
            <Route path="share/message/:token" element={<E name="ShareMessage"><ShareMessage /></E>} />

            {/* Code review */}
            <Route path="commit/:owner/:repo/:sha" element={<E name="CommitView"><CommitView /></E>} />
            <Route path="pr/:owner/:repo/:number" element={<E name="PrView"><PrView /></E>} />
            <Route path="review/:id" element={<E name="ReviewView"><ReviewView /></E>} />
            <Route path="review/batch" element={<E name="ReviewBatch"><ReviewBatch /></E>} />

            {/* Docs - shared layout with persistent list panel */}
            <Route path="docs" element={<E name="DocsLayout"><DocsLayout /></E>}>
              <Route index element={<E name="Docs"><Docs /></E>} />
              <Route path=":id" element={<E name="DocDetail"><DocDetail /></E>} />
            </Route>
            <Route path="plans" element={<E name="Plans"><Plans /></E>} />
            <Route path="plans/:id" element={<E name="PlanDetail"><PlanDetail /></E>} />
            <Route path="tasks" element={<E name="Tasks"><Tasks /></E>} />
            <Route path="tasks/:id" element={<E name="TaskDetail"><TaskDetail /></E>} />
            <Route path="projects" element={<E name="Projects"><Projects /></E>} />
            <Route path="projects/:id" element={<E name="ProjectDetail"><ProjectDetail /></E>} />
            <Route path="workflows" element={<E name="Workflows"><Workflows /></E>} />

            {/* Team */}
            <Route path="team" element={<E name="Team"><Team /></E>} />
            <Route path="team/activity" element={<E name="TeamActivity"><TeamActivity /></E>} />
            <Route path="team/:username" element={<E name="TeamMember"><TeamMember /></E>} />

            {/* Misc */}
            <Route path="orchestration" element={<E name="Orchestration"><Orchestration /></E>} />
            <Route path="roadmap" element={<E name="Roadmap"><Roadmap /></E>} />
            <Route path="cli" element={<E name="Cli"><Cli /></E>} />
            <Route path="sessions" element={<E name="Sessions"><Sessions /></E>} />
            <Route path="windows" element={<E name="Windows"><Windows /></E>} />
            <Route path="admin/daemon-logs" element={<E name="AdminDaemonLogs"><AdminDaemonLogs /></E>} />
            <Route path="config" element={<E name="ConfigPage"><ConfigPage /></E>} />

            {/* Palette - transparent bg */}
            <Route element={<PaletteLayout />}>
              <Route path="palette" element={<E name="Palette"><Palette /></E>} />
            </Route>

            {/* Settings - shared sidebar layout */}
            <Route path="settings" element={<SettingsLayout />}>
              <Route index element={<E name="Settings"><Settings /></E>} />
              <Route path="cli" element={<E name="SettingsCli"><SettingsCli /></E>} />
              <Route path="agents" element={<E name="SettingsAgents"><SettingsAgents /></E>} />
              <Route path="sync" element={<E name="SettingsSync"><SettingsSync /></E>} />
              <Route path="profile" element={<E name="SettingsProfile"><SettingsProfile /></E>} />
              <Route path="accounts" element={<E name="SettingsAccounts"><SettingsAccounts /></E>} />
              <Route path="accounts/link-github" element={<E name="SettingsLinkGithub"><SettingsAccountsLinkGithub /></E>} />
              <Route path="team" element={<E name="SettingsTeam"><SettingsTeam /></E>} />
              <Route path="team/create" element={<E name="SettingsTeamCreate"><SettingsTeamCreate /></E>} />
              <Route path="team/join" element={<E name="SettingsTeamJoin"><SettingsTeamJoin /></E>} />
              <Route path="notifications" element={<E name="SettingsNotifications"><SettingsNotifications /></E>} />
              <Route path="integrations/github-app" element={<E name="SettingsIntegrations"><SettingsIntegrationsGithub /></E>} />
              <Route path="desktop" element={<E name="SettingsDesktop"><SettingsDesktop /></E>} />
            </Route>
          </Routes>
        </Suspense>
      </ErrorBoundary>
    </Providers>
  );
}
