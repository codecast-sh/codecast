import { useCallback, useMemo } from "react";
import { DashboardLayout } from "@/components/DashboardLayout";
import { SessionWindow } from "@/components/SessionWindow";
import { WindowTaskbar } from "@/components/WindowTaskbar";
import { useWindowManager } from "@/store/windowManagerStore";
import { useTrackedStore, isSessionEffectivelyIdle, categorizeSessions, type InboxSession } from "@/store/inboxStore";
import { cleanTitle } from "@/lib/conversationProcessor";
import { Plus, MousePointerClick } from "lucide-react";

export default function WindowsPage() {
  return (
    <DashboardLayout hideSidebar>
      <WindowManagerView />
    </DashboardLayout>
  );
}

function WindowManagerView() {
  const { windows, focusedWindowId, openWindow, autoArrange } = useWindowManager();
  const s = useTrackedStore([s => s.sessions]);

  const windowList = useMemo(
    () => Object.values(windows).sort((a, b) => a.zIndex - b.zIndex),
    [windows],
  );

  const hasWindows = windowList.length > 0;

  // Sessions available to open (not already in a window)
  const openSessionIds = useMemo(
    () => new Set(Object.values(windows).map(w => w.sessionId)),
    [windows],
  );
  const availableSessions = useMemo(
    () => Object.values(s.sessions).filter(sess => !openSessionIds.has(sess._id) && sess.message_count > 0),
    [s.sessions, openSessionIds],
  );

  const handleOpenSession = useCallback((sessionId: string) => {
    openWindow(sessionId);
    setTimeout(() => {
      autoArrange("tile", { width: window.innerWidth, height: window.innerHeight });
    }, 0);
  }, [openWindow, autoArrange]);

  const handleOpenAll = useCallback(() => {
    const categorized = categorizeSessions(s.sessions, new Set());
    const toOpen = [
      ...categorized.needsInput.filter(sess => !openSessionIds.has(sess._id)),
      ...categorized.working.filter(sess => !openSessionIds.has(sess._id)),
    ].slice(0, 8);

    toOpen.forEach(sess => openWindow(sess._id));
    setTimeout(() => {
      autoArrange("tile", { width: window.innerWidth, height: window.innerHeight });
    }, 0);
  }, [s.sessions, openSessionIds, openWindow, autoArrange]);

  return (
    <div className="h-full flex flex-col" style={{ background: "var(--sol-bg)" }}>
      {/* Window area */}
      <div className="flex-1 min-h-0 relative overflow-hidden">
        {hasWindows ? (
          <div className="w-full h-full relative">
            {windowList.map(win => (
              <SessionWindow
                key={win.id}
                win={win}
                isFocused={win.id === focusedWindowId}
              />
            ))}
          </div>
        ) : (
          <EmptyState
            sessions={availableSessions}
            onOpenSession={handleOpenSession}
            onOpenAll={handleOpenAll}
          />
        )}
      </div>

      <WindowTaskbar />
    </div>
  );
}

function EmptyState({
  sessions,
  onOpenSession,
  onOpenAll,
}: {
  sessions: InboxSession[];
  onOpenSession: (id: string) => void;
  onOpenAll: () => void;
}) {
  const needsInput = sessions.filter(s => isSessionEffectivelyIdle(s));
  const working = sessions.filter(s => !isSessionEffectivelyIdle(s));

  return (
    <div className="h-full flex flex-col items-center justify-center gap-6 px-8">
      <div className="text-center space-y-2">
        <MousePointerClick className="w-10 h-10 mx-auto text-sol-text-dim/30" />
        <h2 className="text-lg font-medium text-sol-text-muted">Window Manager</h2>
        <p className="text-sm text-sol-text-dim/60 max-w-md">
          Open sessions as floating windows to monitor and interact with multiple conversations at once.
        </p>
      </div>

      {sessions.length > 0 ? (
        <div className="w-full max-w-lg space-y-3">
          {(needsInput.length > 0 || working.length > 0) && (
            <button
              onClick={onOpenAll}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg border border-sol-cyan/30 bg-sol-cyan/8 text-sol-cyan hover:bg-sol-cyan/15 transition-colors text-sm font-medium"
            >
              <Plus className="w-4 h-4" />
              Open all active sessions ({needsInput.length + working.length})
            </button>
          )}

          <div className="max-h-[300px] overflow-y-auto space-y-1 rounded-lg border border-sol-border/20 p-2">
            {sessions.slice(0, 20).map(sess => {
              const idle = isSessionEffectivelyIdle(sess);
              return (
                <button
                  key={sess._id}
                  onClick={() => onOpenSession(sess._id)}
                  className="w-full flex items-center gap-2.5 px-3 py-2 rounded-md hover:bg-sol-text-dim/8 transition-colors text-left group"
                >
                  <span className="relative flex h-2 w-2 flex-shrink-0">
                    {!idle && (
                      <span
                        className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-40"
                        style={{ backgroundColor: "var(--sol-green)", animationDuration: "1.5s" }}
                      />
                    )}
                    <span
                      className="relative inline-flex rounded-full h-2 w-2"
                      style={{ backgroundColor: idle ? "var(--sol-text-dim)" : "var(--sol-green)" }}
                    />
                  </span>
                  <span className="flex-1 min-w-0 truncate text-sm text-sol-text-muted group-hover:text-sol-text">
                    {cleanTitle(sess.title || "New Session")}
                  </span>
                  <Plus className="w-3.5 h-3.5 text-sol-text-dim/30 group-hover:text-sol-cyan transition-colors" />
                </button>
              );
            })}
          </div>
        </div>
      ) : (
        <p className="text-sm text-sol-text-dim/40">No active sessions to display</p>
      )}
    </div>
  );
}
