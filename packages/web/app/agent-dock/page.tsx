"use client";

// /agent-dock — the pill on the screen's edge and the card beside it, in the
// shell's see-through dock window (main.js "The agent dock"). Opt-in per
// machine from Settings → Desktop.
//
// The pump list is the palette's: this window is never the app, so it is a
// sync follower that keeps its own live inbox feed (useLiveInboxSessions) and
// wires dispatch so the answers and replies it sends actually leave.
import { AuthGuard } from "../../components/AuthGuard";
import { ErrorBoundary } from "../../components/ErrorBoundary";
import { ShortcutProvider } from "../../shortcuts";
import { useEnsureDispatch } from "../../hooks/useEnsureDispatch";
import { useLiveInboxSessions } from "../../hooks/useLiveInboxSessions";
import { useSyncReplication } from "../../hooks/useSyncRole";
import { AgentDock } from "../../components/agentDock/AgentDock";

export default function AgentDockPage() {
  return (
    <AuthGuard>
      <ErrorBoundary name="Agent dock sync" level="inline" fallback={null}>
        <AgentDockSync />
      </ErrorBoundary>
      {/* A query that throws must degrade to no dock, never to a dead pane of
          glass pinned over somebody's screen. */}
      <ErrorBoundary name="Agent dock" level="inline" fallback={null}>
        <ShortcutProvider>
          <div className="flex h-screen w-screen items-start justify-end">
            <AgentDock />
          </div>
        </ShortcutProvider>
      </ErrorBoundary>
    </AuthGuard>
  );
}

function AgentDockSync() {
  useEnsureDispatch();
  useSyncReplication(false);
  useLiveInboxSessions();
  return null;
}
