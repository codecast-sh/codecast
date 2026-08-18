import { memo, useCallback, type RefObject } from "react";
import { useWindowManager, TASKBAR_HEIGHT_PX, type ArrangeMode } from "../store/windowManagerStore";
import { useTrackedStore, useInboxStore, isSessionEffectivelyIdle } from "../store/inboxStore";
import { cleanTitle } from "../lib/conversationProcessor";
import { LayoutGrid, Layers, Columns, Rows, X, Plus } from "lucide-react";

const arrangeOptions: { mode: ArrangeMode; icon: typeof LayoutGrid; label: string }[] = [
  { mode: "tile", icon: LayoutGrid, label: "Tile" },
  { mode: "cascade", icon: Layers, label: "Cascade" },
  { mode: "horizontal", icon: Columns, label: "Side by side" },
  { mode: "vertical", icon: Rows, label: "Stack" },
];

function getContainerViewport(el: HTMLDivElement | null): { width: number; height: number } {
  if (el) {
    const rect = el.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  }
  return { width: window.innerWidth, height: window.innerHeight };
}

export const WindowTaskbar = memo(function WindowTaskbar({ containerRef }: { containerRef: RefObject<HTMLDivElement | null> }) {
  const { windows, autoArrange, closeAll, openWindow } = useWindowManager();
  const minimized = Object.values(windows).filter(w => w.minimized);
  const windowCount = Object.keys(windows).length;

  const handleArrange = useCallback((mode: ArrangeMode) => {
    autoArrange(mode, getContainerViewport(containerRef.current));
  }, [autoArrange, containerRef]);

  const handleAddSession = useCallback((sessionId: string) => {
    // openWindow brings an already-open session's window to the front instead
    // of duplicating it, so the picker needs no exclusion list.
    openWindow(sessionId);
    setTimeout(() => {
      autoArrange("tile", getContainerViewport(containerRef.current));
    }, 0);
  }, [openWindow, autoArrange, containerRef]);

  // Choosing the session is the command palette in pick mode.
  const pickSession = useCallback(() => {
    useInboxStore.getState().openPalette({
      pick: {
        title: "Open session in a window…",
        kinds: ["session"],
        onPick: (t) => { if (t.kind === "session") handleAddSession(t.id); },
      },
    });
  }, [handleAddSession]);

  return (
    <div
      className="flex items-center gap-2 px-3 flex-shrink-0 border-t border-sol-border/30 relative"
      style={{
        height: TASKBAR_HEIGHT_PX,
        background: "color-mix(in srgb, var(--sol-bg-alt) 90%, var(--sol-bg) 10%)",
        zIndex: 10000,
      }}
    >
      {/* Arrange controls */}
      <div className="flex items-center gap-0.5">
        {arrangeOptions.map(({ mode, icon: Icon, label }) => (
          <button
            key={mode}
            onClick={() => handleArrange(mode)}
            disabled={windowCount === 0}
            className="p-1.5 rounded text-sol-text-dim/50 hover:text-sol-text-muted hover:bg-sol-text-dim/10 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            title={label}
          >
            <Icon className="w-3.5 h-3.5" />
          </button>
        ))}
        <div className="w-px h-5 bg-sol-border/30 mx-1" />
        <button
          onClick={pickSession}
          className="p-1.5 rounded text-sol-text-dim/50 hover:text-sol-cyan hover:bg-sol-cyan/10 transition-colors"
          title="Add window"
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Minimized windows */}
      <div className="flex-1 flex items-center gap-1 min-w-0 overflow-x-auto">
        {minimized.map(win => (
          <MinimizedPill key={win.id} windowId={win.id} sessionId={win.sessionId} />
        ))}
      </div>

      {/* Window count + close all */}
      {windowCount > 0 && (
        <div className="flex items-center gap-2 flex-shrink-0">
          <span className="text-[11px] font-mono tabular-nums text-sol-text-dim/50">
            {windowCount} window{windowCount !== 1 ? "s" : ""}
          </span>
          <button
            onClick={closeAll}
            className="p-1 rounded text-sol-text-dim/40 hover:text-red-400 hover:bg-red-500/10 transition-colors"
            title="Close all windows"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

    </div>
  );
});

const MinimizedPill = memo(function MinimizedPill({ windowId, sessionId }: { windowId: string; sessionId: string }) {
  const { restoreWindow, bringToFront, closeWindow } = useWindowManager();
  const s = useTrackedStore([
    s => s.sessions[sessionId],
  ]);
  const session = s.sessions[sessionId];
  const isIdle = session ? isSessionEffectivelyIdle(session) : true;
  const title = cleanTitle(session?.title || "New Session");

  const handleClick = useCallback(() => {
    restoreWindow(windowId);
    bringToFront(windowId);
  }, [restoreWindow, bringToFront, windowId]);

  return (
    <button
      onClick={handleClick}
      className="group flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-sol-text-dim/8 hover:bg-sol-text-dim/15 border border-sol-border/20 hover:border-sol-cyan/30 transition-all max-w-[180px] flex-shrink-0"
      title={title}
    >
      <span className="relative flex h-2 w-2 flex-shrink-0">
        {!isIdle && (
          <span
            className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-40"
            style={{ backgroundColor: "var(--sol-green)", animationDuration: "1.5s" }}
          />
        )}
        <span
          className="relative inline-flex rounded-full h-2 w-2"
          style={{ backgroundColor: isIdle ? "var(--sol-text-dim)" : "var(--sol-green)" }}
        />
      </span>
      <span className="text-[11px] text-sol-text-muted truncate">{title}</span>
      <button
        onClick={(e) => { e.stopPropagation(); closeWindow(windowId); }}
        className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-red-500/20 text-sol-text-dim/40 hover:text-red-400 transition-all"
      >
        <X className="w-2.5 h-2.5" />
      </button>
    </button>
  );
});
