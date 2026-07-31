"use client";

// Integrated terminal panel, docked across the bottom of the dashboard.
//
// The panel is chrome; the machinery lives in lib/terminal/: endpoint.ts
// resolves the local daemon's loopback endpoint, termSessions.ts owns the
// xterm instances and sockets (module-level, so terminals survive panel
// close/open and re-renders — local-first, no store churn). Terminals are
// backed by tmux sessions on the user's machine, so they also survive page
// reloads: reopening the panel reattaches to whatever was running.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useConvex } from "convex/react";
import { Plus, X, Trash2, ChevronDown, ChevronUp, RotateCw, TerminalSquare, Eye } from "lucide-react";
import { useInboxStore, useTrackedStore } from "../../store/inboxStore";
import {
  getTerminalEndpoint,
  probeEndpoint,
  killTerminalSession,
  type TerminalEndpoint,
  type TerminalSessionInfo,
} from "../../lib/terminal/endpoint";
import {
  applyTerminalTheme,
  attachToContainer,
  closeTab,
  getActiveTabId,
  getTerminalsVersion,
  listTabs,
  openTerminal,
  setActiveTab,
  subscribeTerminals,
  type TermTabState,
} from "../../lib/terminal/termSessions";
import { buildTerminalTheme, observeTheme } from "../../lib/terminal/theme";
import "@xterm/xterm/css/xterm.css";

const MIN_HEIGHT = 110;
const DEFAULT_HEIGHT = 280;

type EndpointState =
  | { phase: "idle" }
  | { phase: "resolving" }
  | { phase: "ready"; endpoint: TerminalEndpoint }
  | { phase: "unavailable"; reason: string };

export function TerminalPanel() {
  const s = useTrackedStore([
    (st) => st.clientState.ui?.terminal_open,
    (st) => st.clientState.ui?.terminal_height,
  ]);
  const open = s.clientState.ui?.terminal_open ?? false;
  const storedHeight = s.clientState.ui?.terminal_height ?? DEFAULT_HEIGHT;

  const convex = useConvex();
  const [ep, setEp] = useState<EndpointState>({ phase: "idle" });
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const [maximized, setMaximized] = useState(false);
  const preMaxHeight = useRef(storedHeight);
  const everOpened = useRef(false);
  const restoredOnce = useRef(false);

  const tabsVersion = useSyncExternalStore(subscribeTerminals, getTerminalsVersion, getTerminalsVersion);
  const tabs = listTabs();
  const activeId = getActiveTabId();
  const activeTab = tabs.find((t) => t.id === activeId) ?? null;
  void tabsVersion;

  // Theme: build once + follow light/dark flips live.
  useEffect(() => {
    const apply = () => applyTerminalTheme(buildTerminalTheme());
    apply();
    return observeTheme(apply);
  }, []);

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

  useEffect(() => {
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
      const handle = e.currentTarget as HTMLElement;
      handle.setPointerCapture(e.pointerId);
      const startY = e.clientY;
      const startHeight = heightRef.current;
      const maxH = Math.round(window.innerHeight * 0.8);
      let latest = startHeight;
      const onMove = (ev: PointerEvent) => {
        latest = Math.min(Math.max(startHeight + (startY - ev.clientY), MIN_HEIGHT), maxH);
        setDragHeight(latest);
      };
      const onUp = () => {
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
        handle.removeEventListener("pointercancel", onUp);
        heightRef.current = latest;
        setDragHeight(null);
        useInboxStore.getState().updateClientUI({ terminal_height: latest });
      };
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
      handle.addEventListener("pointercancel", onUp);
    },
    [maximized],
  );
  useEffect(() => {
    heightRef.current = storedHeight;
  }, [storedHeight]);

  const height = maximized
    ? Math.round(typeof window !== "undefined" ? window.innerHeight * 0.75 : 600)
    : (dragHeight ?? storedHeight);

  const setOpen = (value: boolean) => useInboxStore.getState().updateClientUI({ terminal_open: value });

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
      if (tab.status === "exited" || tab.status === "error") {
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
      className={`flex-shrink-0 flex-col bg-sol-bg border-t border-sol-border/40 ${open ? "flex" : "hidden"}`}
      style={{ height: open ? height : 0 }}
    >
      {/* drag handle */}
      <div
        onPointerDown={onHandlePointerDown}
        onDoubleClick={() => setMaximized((m) => !m)}
        className={`group relative h-[3px] -mt-[2px] flex-shrink-0 z-20 ${maximized ? "" : "cursor-row-resize"}`}
      >
        <div className="absolute inset-x-0 -top-[3px] -bottom-[3px]" />
        <div className="absolute inset-x-0 top-[1px] h-px bg-transparent group-hover:bg-sol-cyan transition-colors duration-150" />
      </div>

      {/* header */}
      <div className="flex items-center h-[30px] pl-2 pr-1 gap-1.5 flex-shrink-0 bg-sol-bg-alt/30 border-b border-sol-border/20 select-none">
        <TerminalSquare className="w-3.5 h-3.5 text-sol-text-dim/60 flex-shrink-0" />
        <div className="flex items-center gap-0.5 overflow-x-auto scrollbar-none flex-1 min-w-0">
          {tabs.map((tab) => {
            const isActive = tab.id === activeId;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
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
          {activeTab && (activeTab.status === "exited" || activeTab.status === "error") && (
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
            onClick={() => setOpen(false)}
            title="Hide terminal (ctrl+`)"
            className="p-1 rounded text-sol-text-dim/50 hover:text-sol-text-muted transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* body */}
      <div className="relative flex-1 min-h-0">
        {ep.phase === "resolving" && (
          <CenteredNote>
            <span className="inline-block w-3 h-3 border border-sol-text-dim/40 border-t-sol-cyan rounded-full animate-spin align-middle mr-2" />
            Connecting to local daemon…
          </CenteredNote>
        )}
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
        {activeTab?.readOnly && activeTab.status === "open" && (
          <div className="absolute top-1.5 right-3 px-1.5 py-0.5 rounded text-[10px] font-mono text-sol-violet border border-sol-violet/30 bg-sol-bg/80 pointer-events-none">
            read-only
          </div>
        )}
      </div>
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

function TermContainer({ tab, active }: { tab: TermTabState; active: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) attachToContainer(tab.id, ref.current);
  }, [tab.id]);
  return (
    <div className={`absolute inset-0 pl-3 pt-1.5 ${active ? "" : "invisible"}`}>
      <div ref={ref} className="w-full h-full" />
    </div>
  );
}
