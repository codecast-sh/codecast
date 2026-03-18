import { lazy, Suspense } from "react";
import { Routes, Route } from "react-router";
import { Providers } from "./providers";
import { MarketingLayout } from "./layouts/MarketingLayout";
import { PaletteLayout } from "./layouts/PaletteLayout";
import { SettingsLayout } from "./layouts/SettingsLayout";

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

const Docs = lazy(() => import("@/app/docs/page"));
const DocDetail = lazy(() => import("@/app/docs/[id]/page"));
const Plans = lazy(() => import("@/app/plans/page"));
const PlanDetail = lazy(() => import("@/app/plans/[id]/page"));
const Tasks = lazy(() => import("@/app/tasks/page"));
const TaskDetail = lazy(() => import("@/app/tasks/[id]/page"));
const Workflows = lazy(() => import("@/app/workflows/page"));

const Team = lazy(() => import("@/app/team/page"));
const TeamActivity = lazy(() => import("@/app/team/activity/page"));
const TeamMember = lazy(() => import("@/app/team/[username]/page"));

const Orchestration = lazy(() => import("@/app/orchestration/page"));
const Roadmap = lazy(() => import("@/app/roadmap/page"));
const Cli = lazy(() => import("@/app/cli/page"));
const AdminDaemonLogs = lazy(() => import("@/app/admin/daemon-logs/page"));
const ConfigPage = lazy(() => import("@/app/config/page"));

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
const SettingsIntegrationsGithub = lazy(() => import("@/app/settings/integrations/github-app/page"));
const SettingsDesktop = lazy(() => import("@/app/settings/desktop/page"));

export function App() {
  return (
    <Providers>
      <Suspense>
        <Routes>
          {/* Marketing - light mode layout */}
          <Route element={<MarketingLayout />}>
            <Route index element={<Landing />} />
            <Route path="about" element={<About />} />
            <Route path="features" element={<Features />} />
            <Route path="documentation" element={<Documentation />} />
            <Route path="privacy" element={<Privacy />} />
            <Route path="security" element={<Security />} />
            <Route path="support" element={<Support />} />
            <Route path="terms" element={<Terms />} />
          </Route>

          {/* Auth */}
          <Route path="login" element={<Login />} />
          <Route path="signup" element={<Signup />} />
          <Route path="forgot-password" element={<ForgotPassword />} />
          <Route path="reset-password" element={<ResetPassword />} />
          <Route path="auth/cli" element={<AuthCli />} />
          <Route path="join/:code" element={<JoinTeam />} />

          {/* App */}
          <Route path="dashboard" element={<Dashboard />} />
          <Route path="inbox" element={<Inbox />} />
          <Route path="feed" element={<Feed />} />
          <Route path="search" element={<Search />} />
          <Route path="explore" element={<Explore />} />
          <Route path="timeline" element={<Timeline />} />
          <Route path="notifications" element={<Notifications />} />

          {/* Conversations & sharing */}
          <Route path="conversation/:id" element={<Conversation />} />
          <Route path="conversation/:id/diff" element={<ConversationDiff />} />
          <Route path="share/:token" element={<Share />} />
          <Route path="share/message/:token" element={<ShareMessage />} />

          {/* Code review */}
          <Route path="commit/:owner/:repo/:sha" element={<CommitView />} />
          <Route path="pr/:owner/:repo/:number" element={<PrView />} />
          <Route path="review/:id" element={<ReviewView />} />
          <Route path="review/batch" element={<ReviewBatch />} />

          {/* Docs, plans, tasks */}
          <Route path="docs" element={<Docs />} />
          <Route path="docs/:id" element={<DocDetail />} />
          <Route path="plans" element={<Plans />} />
          <Route path="plans/:id" element={<PlanDetail />} />
          <Route path="tasks" element={<Tasks />} />
          <Route path="tasks/:id" element={<TaskDetail />} />
          <Route path="workflows" element={<Workflows />} />

          {/* Team */}
          <Route path="team" element={<Team />} />
          <Route path="team/activity" element={<TeamActivity />} />
          <Route path="team/:username" element={<TeamMember />} />

          {/* Misc */}
          <Route path="orchestration" element={<Orchestration />} />
          <Route path="roadmap" element={<Roadmap />} />
          <Route path="cli" element={<Cli />} />
          <Route path="admin/daemon-logs" element={<AdminDaemonLogs />} />
          <Route path="config" element={<ConfigPage />} />

          {/* Palette - transparent bg */}
          <Route element={<PaletteLayout />}>
            <Route path="palette" element={<Palette />} />
          </Route>

          {/* Settings - shared sidebar layout */}
          <Route path="settings" element={<SettingsLayout />}>
            <Route index element={<Settings />} />
            <Route path="cli" element={<SettingsCli />} />
            <Route path="agents" element={<SettingsAgents />} />
            <Route path="sync" element={<SettingsSync />} />
            <Route path="profile" element={<SettingsProfile />} />
            <Route path="accounts" element={<SettingsAccounts />} />
            <Route path="accounts/link-github" element={<SettingsAccountsLinkGithub />} />
            <Route path="team" element={<SettingsTeam />} />
            <Route path="team/create" element={<SettingsTeamCreate />} />
            <Route path="team/join" element={<SettingsTeamJoin />} />
            <Route path="integrations/github-app" element={<SettingsIntegrationsGithub />} />
            <Route path="desktop" element={<SettingsDesktop />} />
          </Route>
        </Routes>
      </Suspense>
    </Providers>
  );
}
