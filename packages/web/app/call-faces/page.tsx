import { useInboxStore } from "../../store/inboxStore";
import { AuthGuard } from "../../components/AuthGuard";
import { ErrorBoundary } from "../../components/ErrorBoundary";
import { CallFaces } from "../../components/calls/CallFaces";
import { TeamMembersPump } from "../../components/TeamAvatarBar";
import { useCallSync } from "../../hooks/useCallSync";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";

/**
 * /call-faces — the call minimized to circles of people's faces.
 *
 * The call panel's sibling: no tab shell, no sidebar, no shared tab state. On
 * the desktop the shell gives it a frameless transparent always-on-top window
 * (main.js createFacesWindow) and this route is its whole contents.
 *
 * Its pumps are shorter than even the panel's. This window shows faces and
 * hosts media; it has no rail, no chat and no room name to render, so the only
 * feeder it needs is the call plane — `useCallSync`, which carries occupancy
 * (who is in the room, who is muted) and binds the Convex client into
 * callManager, without which this window could not take the call over at all —
 * plus the team roster the avatars come from.
 *
 * No AppLoader gate. The panel holds its first paint for IDB hydration because
 * it paints a whole stage; this window paints circles over somebody's work, and
 * a loading card floating on top of their screen would be worse than the empty
 * moment it replaces.
 */
export default function CallFacesPage() {
  return (
    <AuthGuard>
      {/* Each behind its own inline boundary: a Convex query that throws here
          degrades to "this data didn't arrive", never to a dead transparent
          window with somebody's microphone open inside it. */}
      <ErrorBoundary name="Call faces sync" level="inline" fallback={null}>
        <CallFacesSyncEffects />
      </ErrorBoundary>
      <ErrorBoundary name="Call faces" level="inline" fallback={null}>
        <CallFaces />
      </ErrorBoundary>
    </AuthGuard>
  );
}

function CallFacesSyncEffects() {
  const activeTeamId = useInboxStore((s) => s.clientState.ui?.active_team_id) as
    | Id<"teams">
    | undefined;
  useCallSync();
  return <TeamMembersPump teamId={activeTeamId} />;
}
