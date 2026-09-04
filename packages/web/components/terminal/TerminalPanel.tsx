"use client";

// Integrated terminal panel, docked across the bottom of the dashboard.
//
// The panel is chrome; the machinery lives in lib/terminal/: endpoint.ts
// resolves the local daemon's loopback endpoint, termSessions.ts owns the
// xterm instances and sockets (module-level, so terminals survive panel
// close/open and re-renders — local-first, no store churn). Terminals are
// backed by tmux sessions on the user's machine, so they also survive page
// reloads: reopening the panel reattaches to whatever was running.

import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import { useConvex } from "convex/react";
import { Plus, X, Trash2, ChevronDown, ChevronUp, RotateCw, TerminalSquare, Eye } from "lucide-react";
import { useInboxStore } from "../../store/inboxStore";
import { DEFAULT_TERMINAL_HEIGHT } from "../../lib/terminal/panelPrefs";
import {
  getTerminalEndpoint,
  probeEndpoint,
  killTerminalSession,
  type TerminalEndpoint,
  type TerminalSessionInfo,
} from "../../lib/terminal/endpoint";
import {
  attachToContainer,
  closeTab,
  getActiveTabId,
  getInstance,
  getTerminalsVersion,
  listTabs,
  openTerminal,
  setActiveTab,
  subscribeTerminals,
  type TermTabState,
} from "../../lib/terminal/termSessions";
import { ContextMenu, useContextMenu, CtxItem, CtxSeparator } from "../ui/context-menu";
import { SplitResizeHandle } from "../SplitResizeHandle";
import "@xterm/xterm/css/xterm.css";

import { useWatchEffect } from "../../hooks/useWatchEffect";
const MIN_HEIGHT = 110;
const DEFAULT_HEIGHT = 280;

type EndpointState =
  | { phase: "idle" }
  | { phase: "resolving" }
  | { phase: "ready"; endpoint: TerminalEndpoint }
  | { phase: "unavailable"; reason: string };

export function TerminalPanel() {
  // Open state and height are the dock slot's — one layout model, and
  // SLOT_PERSISTENCE keeps this region device-local without its own store.
  const open = useInboxStore((st) => st.workspace.dock.pane != null);
  const storedHeight = useInboxStore((st) => st.workspace.dock.size) ?? DEFAULT_TERMINAL_HEIGHT;

  const convex = useConvex();
  const [ep, setEp] = useState<EndpointState>({ phase: "idle" });
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const [maximized, setMaximized] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const everOpened = useRef(false);
  const restoredOnce = useRef(false);

  const tabCtxMenu = useContextMenu<TermTabState>();
  const tabsVersion = useSyncExternalStore(subscribeTerminals, getTerminalsVersion, getTerminalsVersion);
  const tabs = listTabs();
  const activeId = getActiveTabId();
  const activeTab = tabs.find((t) => t.id === activeId) ?? null;
  void tabsVersion;

  const defaultCwd = useCallback((): string | undefined => {
    const st = useInboxStore.getState();
    const convId = st.currentSessionId;
    const meta = convId ? (st.conversations[convId] ?? st.sessions[convId]) : null;
    return (meta as { project_path?: string } | null)?.project_path ?? undefined;
  }, []);

  const openShellTab = useCallback(
    (endpoint: TerminalEndpoint, opts?: { name?: string; cwd?: string; title?: string }) => {
      openTerminal({
        endpoint,
        kind: "shell",
        name: opts?.name,
        cwd: opts?.cwd ?? defaultCwd(),
        title: opts?.title,
      });
    },
    [defaultCwd],
  );

  // Resolve the endpoint on first open (and on retry). On success, restore
  // tabs for tmux sessions that survived a reload; if none, open a fresh one.
  const resolve = useCallback(
    async (force?: boolean) => {
      setEp({ phase: "resolving" });
      const endpoint = await getTerminalEndpoint(convex, { force });
      if (!endpoint) {
        setEp({
          phase: "unavailable",
          reason: "No local daemon reachable. The terminal needs `cast` running on this machine.",
        });
        return;
      }
      setEp({ phase: "ready", endpoint });
      if (!restoredOnce.current) {
        restoredOnce.current = true;
        const existing = (await probeEndpoint(endpoint)) ?? [];
        const openNames = new Set(listTabs().map((t) => t.sessionName));
        for (const sess of existing) {
          // Belt-and-braces: never try to restore a name the daemon would
          // reject (guards against list-format skew between versions).
          if (!/^cast-term-[A-Za-z0-9_-]+$/.test(sess.name)) continue;
          if (!openNames.has(sess.name)) {
            openShellTab(endpoint, { name: sess.name, cwd: sess.path || undefined });
          }
        }
        if (listTabs().length === 0) openShellTab(endpoint);
      } else if (listTabs().length === 0) {
        openShellTab(endpoint);
      }
    },
    [convex, openShellTab],
  );

  useWatchEffect(() => {
    if (open && !everOpened.current) {
      everOpened.current = true;
      void resolve();
    }
  }, [open, resolve]);

  // --- drag resize ---
  const heightRef = useRef(storedHeight);
  const onHandlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (maximized) return;
      e.preventDefault();
      const startY = e.clientY;
      const startHeight = heightRef.current;
      // Full vertical range: everything from the top of the content area
      // (the panel's flex sibling) down to the panel's bottom edge. The main
      // content is flex-1 min-h-0, so it collapses to zero cleanly.
      const panelEl = panelRef.current;
      const contentEl = panelEl?.previousElementSibling as HTMLElement | null;
      const maxH =
        panelEl && contentEl
          ? Math.round(panelEl.getBoundingClientRect().bottom - contentEl.getBoundingClientRect().top)
          : Math.round(window.innerHeight * 0.9);
      let latest = startHeight;
      // Window-level listeners (not pointer capture): the terminal body is an
      // iframe-free but event-hungry surface, and window listeners keep the
      // drag alive wherever the cursor goes, including outside the viewport.
      const onMove = (ev: PointerEvent) => {
        latest = Math.min(Math.max(startHeight + (startY - ev.clientY), MIN_HEIGHT), maxH);
        setDragHeight(latest);
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
        heightRef.current = latest;
        setDragHeight(null);
        if (latest !== startHeight) useInboxStore.getState().wsSetSize("dock", latest);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
      // Suppress text selection and keep the row-resize cursor for the whole
      // drag, even while the pointer crosses xterm's selection layer.
      document.body.style.userSelect = "none";
      document.body.style.cursor = "row-resize";
    },
    [maximized],
  );
  useWatchEffect(() => {
    heightRef.current = storedHeight;
  }, [storedHeight]);

  const height = dragHeight ?? storedHeight;

  const endpoint = ep.phase === "ready" ? ep.endpoint : null;

  const handleNewTab = () => {
    if (endpoint) openShellTab(endpoint);
    else void resolve(true);
  };

  const handleRestart = (tab: TermTabState) => {
    if (!endpoint) return;
    const { kind, sessionName, cwd, target, title } = tab;
    closeTab(tab.id);
    if (kind === "shell") openShellTab(endpoint, { name: sessionName, cwd, title });
    else if (target) openTerminal({ endpoint, kind: "attach", target, title });
  };

  const handleKill = (tab: TermTabState) => {
    if (tab.kind === "shell" && tab.sessionName && endpoint) {
      if (tab.status === "exited" || tab.status === "error" || tab.status === "offline") {
        void killTerminalSession(endpoint, tab.sessionName);
        closeTab(tab.id);
      } else {
        closeTab(tab.id, { killSession: true });
      }
    } else {
      closeTab(tab.id);
    }
  };

  // Keep the DOM (and thus xterm instances) alive when closed: hide, don't unmount.
  return (
    <div
      data-terminal-panel
      ref={panelRef}
      // Maximized: a huge grow factor lets flexbox hand the panel all free
      // space (the flex-1 content sibling collapses to ~0) — no pixel math,
      // and it tracks window resizes for free.
      className={`flex-col bg-sol-bg ${open ? "flex" : "hidden"} ${maximized ? "flex-[999_1_0%] min-h-0" : "flex-shrink-0"}`}
      style={maximized ? undefined : { height: open ? height : 0 }}
    >
      {/* drag handle */}
      <SplitResizeHandle
        onPointerDown={onHandlePointerDown}
        onDoubleClick={() => setMaximized((m) => !m)}
        disabled={maximized}
        title="Drag to resize · double-click to maximize"
      />

      {/* header */}
      <div className="cc-panel__head gap-1.5">
        <TerminalSquare className="w-3.5 h-3.5 text-sol-text-dim/60 flex-shrink-0" />
        <div className="flex items-center gap-0.5 overflow-x-auto scrollbar-none flex-1 min-w-0">
          {tabs.map((tab) => {
            const isActive = tab.id === activeId;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                onContextMenu={(e) => tabCtxMenu.open(e, tab)}
                className={`group flex items-center gap-1.5 px-2.5 h-[22px] rounded text-[11px] leading-none max-w-[180px] flex-shrink-0 transition-all duration-100 ${
                  isActive
                    ? "bg-sol-bg text-sol-text shadow-sm border border-sol-border/30"
                    : "text-sol-text-dim/70 hover:text-sol-text-muted hover:bg-sol-bg/50"
                }`}
              >
                <span
                  className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                    tab.status === "open"
                      ? tab.kind === "attach"
                        ? "bg-sol-violet"
                        : "bg-sol-green"
                      : tab.status === "connecting"
                        ? "bg-sol-yellow animate-pulse"
                        : "bg-sol-text-dim/40"
                  }`}
                />
                <span className="truncate font-mono">{tab.title}</span>
                {tab.readOnly && <Eye className="w-3 h-3 text-sol-text-dim/50 flex-shrink-0" />}
                <span
                  role="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(tab.id);
                  }}
                  title={tab.kind === "shell" ? "Close tab (shell keeps running in tmux)" : "Close tab"}
                  className={`flex-shrink-0 rounded-sm p-0.5 -mr-1 transition-colors ${
                    isActive
                      ? "text-sol-text-dim/50 hover:text-sol-text hover:bg-sol-text-dim/15"
                      : "opacity-0 group-hover:opacity-100 text-sol-text-dim/40 hover:text-sol-text-dim hover:bg-sol-text-dim/15"
                  }`}
                >
                  <X className="w-3 h-3" />
                </span>
              </button>
            );
          })}
          <button
            onClick={handleNewTab}
            title="New terminal"
            className="flex-shrink-0 p-1 rounded text-sol-text-dim/40 hover:text-sol-text-dim hover:bg-sol-bg/50 transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="flex items-center gap-0.5 flex-shrink-0">
          {activeTab && (activeTab.status === "exited" || activeTab.status === "error" || activeTab.status === "offline") && (
            <button
              onClick={() => handleRestart(activeTab)}
              title="Restart terminal"
              className="p-1 rounded text-sol-text-dim/50 hover:text-sol-cyan transition-colors"
            >
              <RotateCw className="w-3.5 h-3.5" />
            </button>
          )}
          {activeTab && activeTab.kind === "shell" && (
            <button
              onClick={() => handleKill(activeTab)}
              title="Kill terminal session (ends the tmux session)"
              className="p-1 rounded text-sol-text-dim/50 hover:text-sol-red transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
          <button
            onClick={() => setMaximized((m) => !m)}
            title={maximized ? "Restore panel size" : "Maximize panel"}
            className="p-1 rounded text-sol-text-dim/50 hover:text-sol-text-muted transition-colors"
          >
            {maximized ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
          </button>
          <button
            onClick={() => useInboxStore.getState().setDockOpen(false)}
            title="Hide terminal (ctrl+`)"
            className="p-1 rounded text-sol-text-dim/50 hover:text-sol-text-muted transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* body */}
      <div
        className="relative flex-1 min-h-0"
        onMouseDown={(e) => {
          // Click anywhere in the body (including margins below a short
          // buffer) focuses the active terminal — a click that misses xterm
          // by a few pixels must never leave keystrokes routed to whatever
          // input the app focused last (that's how a stray Enter can send a
          // drafted message). Skip real controls (Retry button etc.).
          if ((e.target as HTMLElement).closest("button, a, input, textarea")) return;
          if (activeId) {
            const inst = getInstance(activeId);
            if (inst && inst.state.status === "open") {
              e.preventDefault();
              inst.term.focus();
            }
          }
        }}
      >
        {ep.phase === "resolving" && <ConnectingNote label="Connecting to local daemon…" />}
        {ep.phase === "unavailable" && (
          <CenteredNote>
            <div className="space-y-2">
              <div>{ep.reason}</div>
              <button
                onClick={() => void resolve(true)}
                className="px-2 py-0.5 rounded border border-sol-border/40 text-sol-text-muted hover:text-sol-text hover:border-sol-cyan/50 transition-colors text-[11px]"
              >
                Retry
              </button>
            </div>
          </CenteredNote>
        )}
        {tabs.map((tab) => (
          <TermContainer key={tab.id} tab={tab} active={tab.id === activeId} />
        ))}
        {activeTab?.status === "error" && (
          <div className="absolute inset-x-0 bottom-0 px-3 py-1.5 text-[11px] font-mono text-sol-red bg-sol-bg/90 border-t border-sol-border/20">
            {activeTab.statusDetail ?? "terminal error"}
          </div>
        )}
        {activeTab?.status === "offline" && (
          <div className="absolute inset-x-0 bottom-0 px-3 py-1.5 text-[11px] font-mono bg-sol-bg/90 border-t border-sol-yellow/30">
            <span className="text-sol-yellow">no connection</span>
            <span className="text-sol-text-dim"> — the terminal needs the daemon reachable on this machine · </span>
            <button
              onClick={() => handleRestart(activeTab)}
              className="text-sol-cyan hover:underline"
            >
              retry
            </button>
          </div>
        )}
        {activeTab?.readOnly && activeTab.status === "open" && (
          <div className="absolute top-1.5 right-3 px-1.5 py-0.5 rounded text-[10px] font-mono text-sol-violet border border-sol-violet/30 bg-sol-bg/80 pointer-events-none">
            read-only
          </div>
        )}
      </div>

      {/* One menu instance serves the whole tab strip; tabs call open(e, tab).
          The xterm body has no onContextMenu — native selection/copy stays intact. */}
      <ContextMenu state={tabCtxMenu}>
        {(tab) => (
          <>
            <CtxItem icon={Plus} onSelect={handleNewTab}>
              New terminal
            </CtxItem>
            {(tab.status === "exited" || tab.status === "error" || tab.status === "offline") && (
              <CtxItem icon={RotateCw} onSelect={() => handleRestart(tab)}>
                Restart terminal
              </CtxItem>
            )}
            <CtxSeparator />
            {tab.kind === "shell" && (
              <CtxItem icon={Trash2} danger onSelect={() => handleKill(tab)}>
                Kill terminal session
              </CtxItem>
            )}
            <CtxItem icon={X} onSelect={() => closeTab(tab.id)}>
              Close tab
            </CtxItem>
          </>
        )}
      </ContextMenu>
    </div>
  );
}

function CenteredNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center text-[12px] font-mono text-sol-text-dim text-center px-6">
      <div>{children}</div>
    </div>
  );
}

/** Spinner + label, centered in the terminal body. Shared with the per-conversation split. */
export function ConnectingNote({ label }: { label: string }) {
  return (
    <CenteredNote>
      <span className="inline-block w-3 h-3 border border-sol-text-dim/40 border-t-sol-cyan rounded-full animate-spin align-middle mr-2" />
      {label}
    </CenteredNote>
  );
}

function TermContainer({ tab, active }: { tab: TermTabState; active: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useWatchEffect(() => {
    if (ref.current) attachToContainer(tab.id, ref.current);
  }, [tab.id]);
  // overflow-auto matters for ATTACH tabs: they render at the agent pane's
  // fixed size, which usually exceeds the panel — the container scrolls and
  // attachToContainer keeps it pinned to the pane's bottom. Fitted shells
  // exactly fill the container, so it never scrolls for them.
  return (
    <div className={`absolute inset-0 ${active ? "" : "invisible"}`}>
      <div ref={ref} className="w-full h-full overflow-auto pl-3 pt-1.5" />
    </div>
  );
}
