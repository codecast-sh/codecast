import { useInboxStore } from "../../store/inboxStore";
import { AuthGuard } from "../../components/AuthGuard";
import { ErrorBoundary } from "../../components/ErrorBoundary";
import { PresenceFaces } from "../../components/people/PresenceFaces";
import { TeamMembersPump } from "../../components/TeamAvatarBar";
import { useEnsureDispatch } from "../../hooks/useEnsureDispatch";
import { useMountEffect } from "../../hooks/useMountEffect";
import { useSyncInboxSessions } from "../../hooks/useSyncInboxSessions";
import { useSyncTeamInboxSessions } from "../../hooks/useSyncTeamInboxSessions";
import { useChatChannelsSync } from "../../hooks/useChatSync";
import { useSyncReplication } from "../../hooks/useSyncRole";
import { useSyncTeams } from "../../hooks/useSyncTeams";
import { useCallSync } from "../../hooks/useCallSync";
import { useWalkieSync } from "../../hooks/useWalkieSync";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";

/**
 * /faces — the team as circles floating over the work, when there is no call.
 *
 * Like /call-panel it bypasses DashboardShell and DashboardLayout, and on the
 * desktop the shell gives it a see-through always-on-top window (main.js
 * createFacesWindow) that shares the call circles' spot and yields to them
 * during a call. There is no browser fallback: a transparent click-through
 * window is something only the shell can make, and the people window is the
 * browser's version of keeping the team beside your work.
 *
 * Its pumps are the roster's, not the phone's. The faces hold-to-talk, so the
 * walkie engine is bound here (useWalkieSync — the door decides which window
 * actually speaks for the app), but the ring, the knock and their sounds stay
 * with the people window and the main window: a click-through overlay must
 * never be the only thing answering.
 *
 * The first paint waits for nothing and shows nothing: this window floats
 * over somebody's work, and a loading card there is worse than the empty
 * moment it replaces.
 */
export default function FacesPage() {
  return (
    // blankSignedOut: signed out, this window is invisible inert glass — never
    // a loader card or a redirected home page floating over the work.
    <AuthGuard blankSignedOut>
      <FacesWindow />
    </AuthGuard>
  );
}

function FacesWindow() {
  const hydrated = useInboxStore((s) => s.clientStateInitialized);
  // The class presenceFaces.css scopes window-wide rules to (currently the
  // toast suppression): the toaster is a sibling of the route's subtree, so
  // only a document-level mark can reach it.
  useMountEffect(() => {
    document.documentElement.classList.add("faces-overlay-window");
    return () => document.documentElement.classList.remove("faces-overlay-window");
  });
  if (!hydrated) return null;
  return (
    <>
      {/* Each pump behind its own inline boundary: a Convex query that throws
          here degrades to "this data didn't arrive", never to a dead pane of
          invisible glass floating over the person's work. */}
      <ErrorBoundary name="Faces sync" level="inline" fallback={null}>
        <FacesSyncEffects />
      </ErrorBoundary>
      <ErrorBoundary name="Faces" level="inline" fallback={null}>
        <PresenceFaces />
      </ErrorBoundary>
    </>
  );
}

function FacesSyncEffects() {
  const activeTeamId = useInboxStore((s) => s.clientState.ui?.active_team_id) as
    | Id<"teams">
    | undefined;
  // The faces open DMs and hold-to-talk, so the server dispatch is wired.
  useEnsureDispatch();
  // teamHasFeature reads the teams collection; without it calls gate off and
  // the overlay quietly becomes a row of pictures.
  useSyncTeams();
  // Sessions feed the activity lines and the ask rings, same pair as /people.
  useSyncInboxSessions();
  useSyncTeamInboxSessions();
  // DM unread badges, and the channel ids the walkie resolves rooms through.
  useSyncReplication(false);
  useChatChannelsSync();
  // The call plane: occupancy for the huddle chips, and what binds the Convex
  // client into callManager so a hold can open a room at all.
  useCallSync();
  // The walkie's ear. The machine door decides which window speaks for the
  // app, so a second mount is coordination, not a second answerer.
  useWalkieSync();
  return <TeamMembersPump teamId={activeTeamId} />;
}
