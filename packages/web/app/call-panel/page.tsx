import { useInboxStore } from "../../store/inboxStore";
import { AppLoader } from "../../components/AppLoader";
import { AuthGuard } from "../../components/AuthGuard";
import { ErrorBoundary } from "../../components/ErrorBoundary";
import { CallPanel } from "../../components/calls/CallPanel";
import { TeamMembersPump } from "../../components/TeamAvatarBar";
import { useEnsureDispatch } from "../../hooks/useEnsureDispatch";
import { useChatChannelsSync } from "../../hooks/useChatSync";
import { useSyncTeams } from "../../hooks/useSyncTeams";
import { useCallSync } from "../../hooks/useCallSync";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";

/**
 * /call-panel — a huddle as a whole window, in whichever of its four sizes.
 *
 * Like /people it bypasses DashboardShell and DashboardLayout: no tab shell, no
 * sidebar, no shared tab state to write. On the desktop the shell gives it a
 * real window (main.js createCallWindow) — frameless and see-through, because
 * its small sizes are circles of people's faces floating over the work and
 * `transparent` cannot be turned on after a window is built. The route is also
 * what an older desktop build lands on through the detached-tab rung of the
 * popout ladder. It is never a browser popup — that was the bug this window
 * exists to end.
 *
 * Its pumps are deliberately the SHORT list. This window is not the phone: the
 * ring, the knock and the walkie belong to the people window (or the main
 * window), which is where a person answers things. Mounting them here would
 * put a second answerer on the same events for as long as a call runs. What it
 * does need is the call plane itself — `useCallSync` is also what binds the
 * Convex client into callManager, so without it this window could not join at
 * all — plus the few collections the stage names a room from.
 */
export default function CallPanelPage() {
  return (
    <AuthGuard>
      <CallPanelWindow />
    </AuthGuard>
  );
}

function CallPanelWindow() {
  // Hold the first paint until IDB hydration lands, exactly as /people does:
  // React's first frame otherwise races loadCache() and the window paints an
  // empty stage for a beat. The flag flips true even on an empty or unreadable
  // cache, so it cannot hang.
  //
  // With ONE exception, and it is the whole reason the size is in the URL. In
  // the small sizes this window is a few circles over somebody's work, and
  // a loading card floating on top of their screen is worse than the empty
  // moment it replaces. Nothing at all is the honest first frame there.
  const hydrated = useInboxStore((s) => s.clientStateInitialized);
  const small = typeof window !== "undefined" && /[?&]size=(circles|speaker)/.test(window.location.search);
  if (!hydrated) return small ? null : <AppLoader />;
  return (
    <>
      {/* Each pump behind its own inline boundary: a Convex query that throws
          here degrades to "this data didn't arrive", never to a dead window
          with somebody's microphone open in it. */}
      <ErrorBoundary name="Call panel sync" level="inline" fallback={null}>
        <CallPanelSyncEffects />
      </ErrorBoundary>
      <ErrorBoundary name="Call panel" level="inline">
        <CallPanel />
      </ErrorBoundary>
    </>
  );
}

function CallPanelSyncEffects() {
  const activeTeamId = useInboxStore((s) => s.clientState.ui?.active_team_id) as
    | Id<"teams">
    | undefined;
  // The stage's chat rail sends messages, so this window needs the server
  // dispatch wired. Idempotent across windows.
  useEnsureDispatch();
  // teamHasFeature reads the teams collection; without a feeder, calling looks
  // switched off rather than unknown. The sidebar used to be the only feeder,
  // which held until routes started rendering without a sidebar.
  useSyncTeams();
  // Channel rooms are named from the rail (a huddle in #design says so).
  useChatChannelsSync();
  // The call plane: occupancy, live rooms, the lock — and `bindConvex`, which
  // is what lets this window take the call over in the first place.
  useCallSync();
  return <TeamMembersPump teamId={activeTeamId} />;
}
