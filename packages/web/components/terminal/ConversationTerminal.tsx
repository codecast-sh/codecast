"use client";

// Per-conversation terminal split: a live, read-only view of the agent's tmux
// pane docked between the message feed and the composer — scoped to ONE
// conversation, unlike the global bottom panel. Backed by the same terminal
// registry (a `detached` instance: no panel tab), so theme, lifecycle and the
// loopback transport are all shared.
//
// Open state and heights live at module level keyed by conversation, so
// switching conversations and back preserves the split (and its xterm buffer)
// without touching inboxStore — same reasoning as termSessions.ts.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useConvex } from "convex/react";
import { X, RotateCw } from "lucide-react";
import { getTerminalEndpoint } from "../../lib/terminal/endpoint";
import {
  attachToContainer,
  closeTab,
  getInstance,
  getTerminalsVersion,
  openTerminal,
  subscribeTerminals,
} from "../../lib/terminal/termSessions";

const DEFAULT_HEIGHT = 260;
const MIN_HEIGHT = 90;

interface SplitState {
  termId: string | null;
  target: string;
  height: number;
}

const splits = new Map<string, SplitState>();
let version = 0;
const listeners = new Set<() => void>();

function bump(): void {
  version++;
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function getVersion(): number {
  return version;
}

export function isConversationTerminalOpen(convKey: string): boolean {
  return splits.has(convKey);
}

export function toggleConversationTerminal(convKey: string, target: string): void {
  const existing = splits.get(convKey);
  if (existing) {
    if (existing.termId) closeTab(existing.termId);
    splits.delete(convKey);
  } else {
    splits.set(convKey, { termId: null, target, height: DEFAULT_HEIGHT });
  }
  bump();
}

export function ConversationTerminalSplit({ convKey, tmuxSession }: { convKey: string; tmuxSession?: string | null }) {
  useSyncExternalStore(subscribe, getVersion, getVersion);
  const split = splits.get(convKey);
  if (!split) return null;
  return <SplitBody convKey={convKey} split={split} tmuxSession={tmuxSession ?? null} />;
}

function SplitBody({ convKey, split, tmuxSession }: { convKey: string; split: SplitState; tmuxSession: string | null }) {
  useSyncExternalStore(subscribeTerminals, getTerminalsVersion, getTerminalsVersion);
  const convex = useConvex();
  const containerRef = useRef<HTMLDivElement>(null);
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const connecting = useRef(false);

  // The pane can move on session restart (tmux_session changes) — follow it.
  const target = tmuxSession ?? split.target;

  const connect = useCallback(async () => {
    if (connecting.current) return;
    connecting.current = true;
    setFailure(null);
    try {
      const endpoint = await getTerminalEndpoint(convex);
      const current = splits.get(convKey);
      if (!current) return;
      if (!endpoint) {
        setFailure("No local daemon reachable — the agent runs on another machine or cast isn't running here.");
        return;
      }
      current.termId = openTerminal({
        endpoint,
        kind: "attach",
        target,
        title: target,
        detached: true,
        // Interactive, same as a manual `tmux attach` — the pill is just the
        // safe version of it (ignore-size, no nesting).
        interactive: true,
      });
      current.target = target;
      bump();
    } finally {
      connecting.current = false;
    }
  }, [convex, convKey, target]);

  useEffect(() => {
    const current = splits.get(convKey);
    if (!current) return;
    const inst = current.termId ? getInstance(current.termId) : null;
    // (Re)connect when nothing is live yet, or the pane moved under us.
    if (!inst || (current.target !== target && target)) {
      if (inst && current.target !== target) {
        closeTab(current.termId!);
        current.termId = null;
      }
      if (target) void connect();
    }
  }, [convKey, target, connect]);

  const inst = split.termId ? getInstance(split.termId) : null;
  const status = inst?.state.status;

  useEffect(() => {
    if (split.termId && containerRef.current && status === "open") {
      attachToContainer(split.termId, containerRef.current);
    }
  }, [split.termId, status]);

  const reconnect = useCallback(() => {
    const current = splits.get(convKey);
    if (current?.termId) {
      closeTab(current.termId);
      current.termId = null;
    }
    void connect();
  }, [convKey, connect]);

  const onHandlePointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = split.height;
    const maxH = Math.round(window.innerHeight * 0.7);
    let latest = startHeight;
    const onMove = (ev: PointerEvent) => {
      // Top-docked: dragging DOWN grows the split.
      latest = Math.min(Math.max(startHeight + (ev.clientY - startY), MIN_HEIGHT), maxH);
      setDragHeight(latest);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      split.height = latest;
      setDragHeight(null);
      bump();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "row-resize";
  };

  const close = () => toggleConversationTerminal(convKey, target);

  return (
    <div
      data-terminal-panel
      className="flex-shrink-0 flex flex-col bg-sol-bg"
      style={{ height: dragHeight ?? split.height }}
    >
      <div className="flex items-center h-[24px] px-2 gap-1.5 flex-shrink-0 bg-sol-bg-alt/30 border-b border-sol-border/20 select-none">
        <span
          className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
            status === "open" ? "bg-sol-violet" : status === "connecting" ? "bg-sol-yellow animate-pulse" : "bg-sol-text-dim/40"
          }`}
        />
        <span className="text-[10px] font-mono text-sol-text-muted truncate">{target}</span>
        <span className="flex-1" />
        {(status === "exited" || status === "error" || status === "offline" || failure) && (
          <button
            onClick={reconnect}
            title="Reconnect"
            className="p-0.5 rounded text-sol-text-dim/50 hover:text-sol-cyan transition-colors"
          >
            <RotateCw className="w-3 h-3" />
          </button>
        )}
        <button onClick={close} title="Close terminal view" className="p-0.5 rounded text-sol-text-dim/50 hover:text-sol-text-muted transition-colors">
          <X className="w-3 h-3" />
        </button>
      </div>

      <div className="relative flex-1 min-h-0">
        {failure ? (
          <div className="absolute inset-0 flex items-center justify-center text-[11px] font-mono text-sol-text-dim text-center px-6">{failure}</div>
        ) : status === "offline" ? (
          <div className="absolute inset-0 flex items-center justify-center text-[11px] font-mono text-center px-6">
            <span>
              <span className="text-sol-yellow">no connection</span>
              <span className="text-sol-text-dim"> — the terminal needs the daemon reachable on this machine · </span>
              <button onClick={reconnect} className="text-sol-cyan hover:underline">
                retry
              </button>
            </span>
          </div>
        ) : status === "exited" || status === "error" ? (
          <div className="absolute inset-0 flex items-center justify-center text-[11px] font-mono text-sol-text-dim text-center px-6">
            {inst?.state.statusDetail ?? "session ended"}
          </div>
        ) : null}
        <div
          ref={containerRef}
          className={`absolute inset-0 overflow-auto pl-2 pt-1 ${status === "open" ? "" : "invisible"}`}
        />
      </div>

      <div onPointerDown={onHandlePointerDown} className="group relative h-[3px] -mb-[2px] flex-shrink-0 z-10 cursor-row-resize">
        <div className="absolute inset-x-0 -top-[3px] -bottom-[3px]" />
        <div className="absolute inset-x-0 bottom-[1px] h-px bg-transparent group-hover:bg-sol-cyan transition-colors duration-150" />
      </div>
    </div>
  );
}
