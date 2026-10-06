"use client";

// /agent-dock — the pill on the screen's edge and the card beside it, in the
// shell's see-through dock window (main.js "The agent dock"). Off by
// default; turned on per machine from Settings, once released.
//
// Unreleased (AGENT_DOCK_RELEASED), the page draws nothing and tells the
// shell to turn the dock off: desktop 1.1.169 to 1.1.172 open this window on
// their own, and only the web half reaches them.
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
import { useMountEffect } from "../../hooks/useMountEffect";
import { AGENT_DOCK_RELEASED, setAgentDock } from "../../lib/desktopAgentDock";

export default function AgentDockPage() {
  return AGENT_DOCK_RELEASED ? <ReleasedAgentDock /> : <UnreleasedAgentDock />;
}

function UnreleasedAgentDock() {
  useMountEffect(() => {
    void setAgentDock({ enabled: false });
  });
  return null;
}

function ReleasedAgentDock() {
  return (
    <AuthGuard blankSignedOut>
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
