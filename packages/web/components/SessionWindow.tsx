import { memo, useCallback, useRef } from "react";
import { Rnd } from "react-rnd";
import { useWindowManager, type WindowState } from "../store/windowManagerStore";
import { useTrackedStore, isSessionEffectivelyIdle, getSessionRenderKey } from "../store/inboxStore";
import { InboxConversation } from "./GlobalSessionPanel";
import { cleanTitle } from "../lib/conversationProcessor";
import { Minus, Square, X, Maximize2 } from "lucide-react";

interface SessionWindowProps {
  win: WindowState;
  isFocused: boolean;
}

export const SessionWindow = memo(function SessionWindow({ win, isFocused }: SessionWindowProps) {
  const { bringToFront, updateBounds, minimizeWindow, maximizeWindow, restoreWindow, closeWindow } = useWindowManager();
  const rndRef = useRef<Rnd>(null);

  const s = useTrackedStore([
    s => s.sessions[win.sessionId],
    s => s.dismissedSessions[win.sessionId],
  ]);
  const session = s.sessions[win.sessionId] ?? s.dismissedSessions[win.sessionId];
  const isIdle = session ? isSessionEffectivelyIdle(session) : true;
  const renderKey = getSessionRenderKey(session);
  const title = cleanTitle(session?.title || "New Session");

  const handleMouseDown = useCallback(() => {
    bringToFront(win.id);
  }, [bringToFront, win.id]);

  const handleMaxToggle = useCallback(() => {
    if (win.maximized) {
      restoreWindow(win.id);
    } else {
      maximizeWindow(win.id, {
        width: window.innerWidth,
        height: window.innerHeight,
      });
    }
  }, [win.id, win.maximized, maximizeWindow, restoreWindow]);

  if (win.minimized) return null;

  const statusColor = !session
    ? "var(--sol-text-dim)"
    : isIdle
      ? "var(--sol-text-dim)"
      : "var(--sol-green)";

  const statusPulse = session && !isIdle;

  return (
    <Rnd
      ref={rndRef}
      position={{ x: win.x, y: win.y }}
      size={{ width: win.width, height: win.height }}
      minWidth={360}
      minHeight={280}
      style={{ zIndex: win.zIndex }}
      bounds="parent"
      dragHandleClassName="window-drag-handle"
      onDragStart={handleMouseDown}
      onDragStop={(_e, d) => {
        updateBounds(win.id, { x: d.x, y: d.y });
      }}
      onResizeStop={(_e, _dir, ref, _delta, position) => {
        updateBounds(win.id, {
          x: position.x,
          y: position.y,
          width: ref.offsetWidth,
          height: ref.offsetHeight,
        });
      }}
      enableResizing={!win.maximized}
      disableDragging={win.maximized}
    >
      <div
        className={`h-full flex flex-col rounded-lg overflow-hidden shadow-2xl border transition-shadow duration-150 ${
          isFocused
            ? "border-sol-cyan/40 shadow-[0_8px_40px_rgba(0,0,0,0.45)]"
            : "border-sol-border/30 shadow-[0_4px_20px_rgba(0,0,0,0.3)]"
        }`}
        style={{ background: "var(--sol-bg)" }}
        onMouseDown={handleMouseDown}
      >
        {/* Title bar */}
        <div
          className="window-drag-handle flex items-center gap-2 px-3 py-1.5 select-none cursor-grab active:cursor-grabbing flex-shrink-0"
          style={{
            background: isFocused
              ? "color-mix(in srgb, var(--sol-bg-alt) 80%, var(--sol-cyan) 8%)"
              : "var(--sol-bg-alt)",
            borderBottom: "1px solid color-mix(in srgb, var(--sol-border) 50%, transparent)",
          }}
          onDoubleClick={handleMaxToggle}
        >
          {/* Status dot */}
          <span className="relative flex h-2.5 w-2.5 flex-shrink-0">
            {statusPulse && (
              <span
                className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-40"
                style={{ backgroundColor: statusColor, animationDuration: "1.5s" }}
              />
            )}
            <span
              className="relative inline-flex rounded-full h-2.5 w-2.5"
              style={{ backgroundColor: statusColor }}
            />
          </span>

          {/* Title */}
          <span className="flex-1 min-w-0 truncate text-xs font-medium text-sol-text-muted">
            {title}
          </span>

          {/* Window controls */}
          <div className="flex items-center gap-0.5 flex-shrink-0">
            <button
              onClick={(e) => { e.stopPropagation(); minimizeWindow(win.id); }}
              className="p-1 rounded hover:bg-sol-text-dim/15 text-sol-text-dim/60 hover:text-sol-text-muted transition-colors"
              title="Minimize"
            >
              <Minus className="w-3 h-3" />
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); handleMaxToggle(); }}
              className="p-1 rounded hover:bg-sol-text-dim/15 text-sol-text-dim/60 hover:text-sol-text-muted transition-colors"
              title={win.maximized ? "Restore" : "Maximize"}
            >
              {win.maximized ? <Maximize2 className="w-3 h-3" /> : <Square className="w-3 h-3" />}
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); closeWindow(win.id); }}
              className="p-1 rounded hover:bg-red-500/20 text-sol-text-dim/60 hover:text-red-400 transition-colors"
              title="Close"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        </div>

        {/* Conversation content */}
        <div className="flex-1 min-h-0 overflow-hidden">
          {session ? (
            <InboxConversation
              key={renderKey || win.sessionId}
              sessionId={win.sessionId}
              isIdle={isIdle}
              onSendAndAdvance={() => {}}
              lastUserMessage={session.last_user_message}
              sessionError={session.session_error}
            />
          ) : (
            <div className="h-full flex items-center justify-center text-sol-text-dim text-sm">
              Session not found
            </div>
          )}
        </div>
      </div>
    </Rnd>
  );
});
