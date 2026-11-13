import { useCallback, useMemo, useRef } from "react";
import { DashboardLayout } from "@/components/DashboardLayout";
import { SessionWindow } from "@/components/SessionWindow";
import { WindowTaskbar } from "@/components/WindowTaskbar";
import { useWindowManager } from "@/store/windowManagerStore";
import { useTrackedStore, isSessionEffectivelyIdle, filterInboxScopeFromState, sessionsWakeSig, teamInboxIdsOf, type InboxSession } from "@/store/inboxStore";
import { makeCollectionSig } from "@/store/wakeSig";
import { cleanTitle } from "@/lib/conversationProcessor";
import { Plus, MousePointerClick } from "lucide-react";
import { useIsModernStyle } from "@/hooks/useVisualStyle";
import { ModernWindowRow } from "./ModernWindowRow";
import { modernButton } from "../../components/ui/modernLook";

export default function WindowsPage() {
  return (
    <DashboardLayout hideSidebar>
      <WindowManagerView />
    </DashboardLayout>
  );
}

/** Get the actual pixel dimensions of an element, falling back to viewport */
function getContainerViewport(el: HTMLDivElement | null): { width: number; height: number } {
  if (el) {
    const rect = el.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  }
  return { width: window.innerWidth, height: window.innerHeight };
}

// What the empty state draws of each row with messages: its name, its dot,
// and who owns it (the scope rule). A heartbeat moves none of these, so the
// page wakes only when the list it shows changes.
const windowRowsSig = makeCollectionSig<InboxSession>((r) =>
  r.message_count > 0 ? `${r.title ?? ""}|${isSessionEffectivelyIdle(r) ? 1 : 0}|${r.user_id ?? ""}|${r.owner_user_id ?? ""}` : null);

/** How many windows "open the newest" opens at once. */
const OPEN_ALL_CAP = 8;

function WindowManagerView() {
  const { windows, focusedWindowId, openWindow, autoArrange } = useWindowManager();
  // Modern rows say each session's state, so they wake on what decides it.
  const modern = useIsModernStyle();
  const s = useTrackedStore([
    (st) => windowRowsSig(st.sessions),
    (st) => (modern ? sessionsWakeSig(st.sessions) : null),
    // The scope pref lives in the UI prefs; the chokepoint reads it from there.
    (st) => st.clientState.ui,
    (st) => st.currentUser?._id?.toString?.() ?? null,
    (st) => teamInboxIdsOf(st),
    (st) => st.currentSessionId,
  ]);
  const rowsSig = windowRowsSig(s.sessions);
  const containerRef = useRef<HTMLDivElement>(null);

  const windowList = useMemo(
    () => Object.values(windows).sort((a, b) => a.zIndex - b.zIndex),
    [windows],
  );

  const hasWindows = windowList.length > 0;

  const openSessionIds = useMemo(
    () => new Set(Object.values(windows).map(w => w.sessionId)),
    [windows],
  );
  // Scoped enumeration — the cache holds rows from other inbox scopes/teams.
  // Newest first, so "open the newest" and the list below agree.
  const availableSessions = useMemo(
    () => Object.values(filterInboxScopeFromState(s))
      .filter(sess => !openSessionIds.has(sess._id) && sess.message_count > 0)
      .sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rowsSig stands in for the churny sessions ref
    [rowsSig, modern ? sessionsWakeSig(s.sessions) : null, s.clientState.ui, s.currentUser?._id, teamInboxIdsOf(s), s.currentSessionId, openSessionIds],
  );

  const handleOpenSession = useCallback((sessionId: string) => {
    openWindow(sessionId);
    setTimeout(() => {
      autoArrange("tile", getContainerViewport(containerRef.current));
    }, 0);
  }, [openWindow, autoArrange]);

  const handleOpenAll = useCallback(() => {
    const toOpen = availableSessions.slice(0, OPEN_ALL_CAP);
    toOpen.forEach(sess => openWindow(sess._id));
    setTimeout(() => {
      autoArrange("tile", getContainerViewport(containerRef.current));
    }, 0);
  }, [availableSessions, openWindow, autoArrange]);

  return (
    <div className="h-full flex flex-col" style={{ background: "var(--sol-bg)" }}>
      {/* Window area */}
      <div ref={containerRef} className="flex-1 min-h-0 relative overflow-hidden">
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

      <WindowTaskbar containerRef={containerRef} />
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
  const modern = useIsModernStyle();
  return (
    <div className="h-full flex flex-col items-center justify-center gap-6 px-8">
      <div className="text-center space-y-2">
        <MousePointerClick className="w-10 h-10 mx-auto text-sol-text-dim" />
        <h2 className="text-lg font-medium text-sol-text-muted">Window Manager</h2>
      </div>

      {sessions.length > 0 ? (
        <div className="w-full max-w-lg space-y-3">
          <button
            onClick={onOpenAll}
            className={`w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg border border-sol-cyan/30 bg-sol-cyan/8 text-sol-cyan hover:bg-sol-cyan/15 transition-colors text-sm font-medium ${modernButton({ variant: "primary", size: "lg" })}`}
          >
            <Plus className="w-4 h-4" />
            {sessions.length === 1 ? "Open it" : `Open the ${Math.min(OPEN_ALL_CAP, sessions.length)} newest`}
          </button>

          <div className="max-h-[300px] overflow-y-auto space-y-1 rounded-lg border border-sol-border/20 p-2 modern:rounded-card modern:border-sol-border modern:bg-sol-card modern:p-1">
            {sessions.slice(0, 20).map(sess => {
              if (modern) return <ModernWindowRow key={sess._id} session={sess} now={Date.now()} onOpen={onOpenSession} />;
              const idle = isSessionEffectivelyIdle(sess);
              return (
                <button
                  key={sess._id}
                  onClick={() => onOpenSession(sess._id)}
                  className="w-full flex items-center gap-2.5 px-3 py-2 rounded-md hover:bg-sol-text-dim/8 transition-colors text-left group"
                >
                  <span
                    className="inline-flex rounded-full h-2 w-2 flex-shrink-0"
                    title={idle ? "Idle" : "Working"}
                    style={{ backgroundColor: idle ? "var(--sol-text-dim)" : "var(--sol-green)" }}
                  />
                  <span className="flex-1 min-w-0 truncate text-sm text-sol-text-muted group-hover:text-sol-text">
                    {cleanTitle(sess.title || "New Session")}
                  </span>
                  <Plus className="w-3.5 h-3.5 text-sol-text-dim group-hover:text-sol-cyan transition-colors" />
                </button>
              );
            })}
          </div>
        </div>
      ) : (
        <p className="text-sm text-sol-text-dim">No sessions</p>
      )}
    </div>
  );
}
