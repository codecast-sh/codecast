import { memo, useCallback, useState, useMemo, useRef, useEffect } from "react";
import { useWindowManager, TASKBAR_HEIGHT_PX, type ArrangeMode } from "../store/windowManagerStore";
import { useTrackedStore, isSessionEffectivelyIdle } from "../store/inboxStore";
import { cleanTitle } from "../lib/conversationProcessor";
import { LayoutGrid, Layers, Columns, Rows, X, Plus } from "lucide-react";

const arrangeOptions: { mode: ArrangeMode; icon: typeof LayoutGrid; label: string }[] = [
  { mode: "tile", icon: LayoutGrid, label: "Tile" },
  { mode: "cascade", icon: Layers, label: "Cascade" },
  { mode: "horizontal", icon: Columns, label: "Side by side" },
  { mode: "vertical", icon: Rows, label: "Stack" },
];

export const WindowTaskbar = memo(function WindowTaskbar() {
  const { windows, autoArrange, closeAll, openWindow } = useWindowManager();
  const minimized = Object.values(windows).filter(w => w.minimized);
  const windowCount = Object.keys(windows).length;
  const [pickerOpen, setPickerOpen] = useState(false);

  const handleArrange = useCallback((mode: ArrangeMode) => {
    autoArrange(mode, { width: window.innerWidth, height: window.innerHeight });
  }, [autoArrange]);

  const handleAddSession = useCallback((sessionId: string) => {
    openWindow(sessionId);
    setPickerOpen(false);
    setTimeout(() => {
      autoArrange("tile", { width: window.innerWidth, height: window.innerHeight });
    }, 0);
  }, [openWindow, autoArrange]);

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
          onClick={() => setPickerOpen(!pickerOpen)}
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

      {/* Session picker popover */}
      {pickerOpen && (
        <SessionPicker
          onSelect={handleAddSession}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
});

function SessionPicker({ onSelect, onClose }: { onSelect: (id: string) => void; onClose: () => void }) {
  const s = useTrackedStore([s => s.sessions]);
  const { windows } = useWindowManager();
  const ref = useRef<HTMLDivElement>(null);
  const [search, setSearch] = useState("");

  const openSessionIds = useMemo(
    () => new Set(Object.values(windows).map(w => w.sessionId)),
    [windows],
  );

  const available = useMemo(() => {
    const all = Object.values(s.sessions).filter(
      sess => !openSessionIds.has(sess._id) && sess.message_count > 0,
    );
    if (!search) return all;
    const q = search.toLowerCase();
    return all.filter(sess => (sess.title || "").toLowerCase().includes(q));
  }, [s.sessions, openSessionIds, search]);

  // Close on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="absolute bottom-full left-0 mb-1 w-80 max-h-[360px] flex flex-col rounded-lg border border-sol-border/30 shadow-2xl overflow-hidden"
      style={{ background: "var(--sol-bg)", zIndex: 9999 }}
    >
      <div className="p-2 border-b border-sol-border/20">
        <input
          autoFocus
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search sessions..."
          className="w-full px-2.5 py-1.5 rounded-md bg-sol-bg-alt border border-sol-border/20 text-sm text-sol-text placeholder:text-sol-text-dim/40 outline-none focus:border-sol-cyan/40"
        />
      </div>
      <div className="flex-1 overflow-y-auto p-1">
        {available.length === 0 ? (
          <div className="px-3 py-4 text-center text-sm text-sol-text-dim/50">
            {search ? "No matching sessions" : "All sessions already open"}
          </div>
        ) : (
          available.slice(0, 30).map(sess => {
            const idle = isSessionEffectivelyIdle(sess);
            return (
              <button
                key={sess._id}
                onClick={() => onSelect(sess._id)}
                className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md hover:bg-sol-text-dim/8 transition-colors text-left"
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
                <span className="flex-1 min-w-0 truncate text-xs text-sol-text-muted">
                  {cleanTitle(sess.title || "New Session")}
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

const MinimizedPill = memo(function MinimizedPill({ windowId, sessionId }: { windowId: string; sessionId: string }) {
  const { restoreWindow, bringToFront, closeWindow } = useWindowManager();
  const s = useTrackedStore([
    s => s.sessions[sessionId],
    s => s.dismissedSessions[sessionId],
  ]);
  const session = s.sessions[sessionId] ?? s.dismissedSessions[sessionId];
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
