import { useInboxStore } from "../../store/inboxStore";
import { AppLoader } from "../../components/AppLoader";
import { AuthGuard } from "../../components/AuthGuard";
import { ErrorBoundary } from "../../components/ErrorBoundary";
import { PeoplePanel } from "../../components/people/PeoplePanel";
import { TeamMembersPump } from "../../components/TeamAvatarBar";
import { useEnsureDispatch } from "../../hooks/useEnsureDispatch";
import { useSyncInboxSessions } from "../../hooks/useSyncInboxSessions";
import { useSyncTeamInboxSessions } from "../../hooks/useSyncTeamInboxSessions";
import { useChatChannelsSync } from "../../hooks/useChatSync";
import { useSyncReplication } from "../../hooks/useSyncRole";
import { useSyncTeams } from "../../hooks/useSyncTeams";
import { useCallSync } from "../../hooks/useCallSync";
import { useCallRing } from "../../hooks/useCallRing";
import { useWalkieSync } from "../../hooks/useWalkieSync";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";

/**
 * /people — the floating buddy list, as a whole window.
 *
 * It deliberately bypasses DashboardShell and DashboardLayout: there is no tab
 * shell here, no sidebar, and no shared tab state to write. The window renders
 * one surface and stays on it, the same law a detached tab window lives under.
 *
 * Which means it must mount its own pumps. On the desktop this window is the
 * shell's notification leader while it exists, so the ring, the walkie and the
 * knock are ITS job — a buddy list that could not ring would be an ornament.
 */
export default function PeoplePage() {
  return (
    <AuthGuard>
      <PeopleWindow />
    </AuthGuard>
  );
}

function PeopleWindow() {
  // Hold the first paint until the IDB hydration pass lands, exactly as the
  // dashboard does. Without it React's first frame races loadCache() and the
  // window paints "No teammates yet" for a beat before the roster pops in.
  // The flag flips true even on an empty or unreadable cache, so it can't hang.
  const hydrated = useInboxStore((s) => s.clientStateInitialized);
  if (!hydrated) return <AppLoader />;
  return (
    <>
      {/* Each pump behind its own inline boundary: a Convex query that throws
          here degrades to "this data didn't arrive", never to a blank window. */}
      <ErrorBoundary name="People sync" level="inline" fallback={null}>
        <PeopleSyncEffects />
      </ErrorBoundary>
      <ErrorBoundary name="People" level="inline">
        <PeoplePanel />
      </ErrorBoundary>
    </>
  );
}

function PeopleSyncEffects() {
  const activeTeamId = useInboxStore((s) => s.clientState.ui?.active_team_id) as
    | Id<"teams">
    | undefined;
  // This window creates DMs, sets a status and flips the walkie door, so it
  // needs the server dispatch wired. Idempotent across windows.
  useEnsureDispatch();
  // The teams collection. Not decoration: teamHasFeature reads it, so without
  // it calls, chat and the walkie all gate off and the panel quietly becomes a
  // list of names. The sidebar used to be the only feeder, which held until a
  // route rendered without a sidebar.
  useSyncTeams();
  // The roster itself. One subscription for the window; the panel reads the
  // store, whose teamMembers ref only changes when something displayable did.
  // Sessions feed the activity lines ("2 agents working · fixing auth"). Same
  // pair the dashboard mounts, so the panel and the hover card can never
  // disagree about what a teammate is doing — including the team feeder's own
  // rule that it fetches nothing until the viewer is in team scope.
  useSyncInboxSessions();
  useSyncTeamInboxSessions();
  // The chat rail: the DM unread counts on the rows, and the channel ids the
  // walkie and the call occupancy both resolve their rooms through.
  useSyncReplication(false);
  useChatChannelsSync();
  // The phone. Ring toasts and knock sounds land in this window because the
  // shell elects it leader while it lives; these are what produce them.
  useCallSync();
  useCallRing();
  useWalkieSync();
  return <TeamMembersPump teamId={activeTeamId} />;
}
