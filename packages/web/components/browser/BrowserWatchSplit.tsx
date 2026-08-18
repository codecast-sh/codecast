"use client";

// Live view of the browser tab an agent is driving, docked into the
// conversation the same way the terminal split is (ConversationTerminal.tsx),
// and reachable over the same transport: the daemon's loopback endpoint,
// discovered once via getTerminalEndpoint. Read-only — frames flow in, no
// clicks flow back. Closing the pane closes the socket, which is the daemon's
// signal to stop the screencast.
//
// Open state and heights live at module level keyed by conversation, so
// switching conversations and back preserves the split — but unlike the
// terminal (whose xterm buffer is expensive to rebuild) the stream itself is
// torn down on unmount and redialed on mount: a screencast nobody is looking
// at should not keep Chrome encoding JPEGs.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useConvex } from "convex/react";
import { X, RotateCw } from "lucide-react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { deviceDisplayName } from "../DeviceBadge";
import { SplitResizeHandle } from "../SplitResizeHandle";
import type { SessionMachine } from "../tmuxAttach";
import { getTerminalEndpoint } from "../../lib/terminal/endpoint";
import { connectBrowserWatch, type WatchConnection, type WatchTabInfo } from "../../lib/browserWatch";

const DEFAULT_HEIGHT = 320;
const MIN_HEIGHT = 120;

interface SplitState {
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

export function isBrowserWatchOpen(convKey: string): boolean {
  return splits.has(convKey);
}

/** Reactive open-state, for affordances that toggle the split. */
export function useBrowserWatchOpen(convKey: string | undefined): boolean {
  useSyncExternalStore(subscribe, getVersion, getVersion);
  return !!convKey && splits.has(convKey);
}

export function toggleBrowserWatch(convKey: string): void {
  if (splits.has(convKey)) splits.delete(convKey);
  else splits.set(convKey, { height: DEFAULT_HEIGHT });
  bump();
}

type Status =
  | { kind: "connecting" }
  | { kind: "live" }
  | { kind: "failed"; message: string; canRetry: boolean };

function exitMessage(reason: string): string {
  switch (reason) {
    case "tab-closed":
      return "the agent's browser tab was closed";
    case "browser-closed":
      return "the managed browser is no longer running";
    case "timeout":
      return "stream paused after 30 minutes — reconnect to keep watching";
    default:
      return "stream ended";
  }
}

function errorMessage(code: string, message: string): string {
  switch (code) {
    case "no-browser":
      return "no managed browser is running on the agent's machine";
    case "no-tab":
      return "this session hasn't driven a browser tab yet";
    case "forbidden":
      return "the daemon refused the stream — reload to refresh the endpoint";
    default:
      return message || "could not open the stream";
  }
}

export function BrowserWatchSplit({
  convKey,
  sessionUuid,
  tmuxSession,
}: {
  convKey: string;
  sessionUuid?: string | null;
  tmuxSession?: string | null;
}) {
  useSyncExternalStore(subscribe, getVersion, getVersion);
  const split = splits.get(convKey);
  if (!split) return null;
  return <SplitBody convKey={convKey} split={split} sessionUuid={sessionUuid ?? null} tmuxSession={tmuxSession ?? null} />;
}

function SplitBody({
  convKey,
  split,
  sessionUuid,
  tmuxSession,
}: {
  convKey: string;
  split: SplitState;
  sessionUuid: string | null;
  tmuxSession: string | null;
}) {
  const convex = useConvex();
  const [status, setStatus] = useState<Status>({ kind: "connecting" });
  const [tab, setTab] = useState<WatchTabInfo | null>(null);
  const [frame, setFrame] = useState<string | null>(null);
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const connRef = useRef<WatchConnection | null>(null);
  // Bumped to force a reconnect; the connect effect depends on it.
  const [attempt, setAttempt] = useState(0);

  // Which machine the agent (and so its browser) lives on. Enrichment only —
  // useQueryNoThrow per the header-outage rule; without an answer we still try
  // local discovery, which is the correct behaviour on a one-machine setup.
  const machineQuery = useQueryNoThrow(
    api.devices.getConversationMachine,
    convKey ? ({ conversation_id: convKey as any } as any) : "skip",
  );
  const machine = machineQuery.data as SessionMachine | null | undefined;
  const machineSettled = machine !== undefined || !!machineQuery.error;
  const machineName = machine ? deviceDisplayName(machine as any) : null;
  const foreign = !!machine && !machine.is_mine;

  useEffect(() => {
    if (!machineSettled) return;
    let cancelled = false;
    setStatus({ kind: "connecting" });

    (async () => {
      if (foreign) {
        setStatus({
          kind: "failed",
          message: `This agent's browser runs on ${machineName ?? "someone else's machine"}, which only its owner can watch.`,
          canRetry: false,
        });
        return;
      }
      const endpoint = await getTerminalEndpoint(convex, { deviceId: machine?.device_id });
      if (cancelled) return;
      if (!endpoint) {
        setStatus({
          kind: "failed",
          message: machine?.device_id
            ? `The browser runs on ${machineName ?? "another of your machines"} — watching works from a browser on that machine.`
            : "No local daemon reachable — the watch pane needs cast running on this machine.",
          canRetry: true,
        });
        return;
      }
      connRef.current = connectBrowserWatch(
        endpoint,
        { sessionUuid, tmuxSession },
        {
          onReady(t) {
            if (cancelled) return;
            setTab(t);
            setStatus({ kind: "live" });
          },
          onFrame(dataUrl) {
            if (!cancelled) setFrame(dataUrl);
          },
          onTab(t) {
            if (!cancelled) setTab(t);
          },
          onError(code, message) {
            if (!cancelled) setStatus({ kind: "failed", message: errorMessage(code, message), canRetry: true });
          },
          onExit(reason) {
            if (!cancelled) setStatus({ kind: "failed", message: exitMessage(reason), canRetry: true });
          },
        },
      );
    })();

    return () => {
      cancelled = true;
      connRef.current?.close();
      connRef.current = null;
    };
  }, [convex, convKey, sessionUuid, tmuxSession, machineSettled, foreign, machine?.device_id, machineName, attempt]);

  const reconnect = useCallback(() => setAttempt((n) => n + 1), []);
  const close = () => toggleBrowserWatch(convKey);

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

  const live = status.kind === "live";

  return (
    <div className="flex-shrink-0 flex flex-col bg-sol-bg" style={{ height: dragHeight ?? split.height }}>
      <div className="flex items-center h-[24px] px-2 gap-1.5 flex-shrink-0 bg-sol-bg-alt/30 border-b border-sol-border/20 select-none">
        <span
          className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
            live ? "bg-sol-red animate-pulse" : status.kind === "connecting" ? "bg-sol-yellow animate-pulse" : "bg-sol-text-dim/40"
          }`}
        />
        <span className={`text-[9px] font-mono tracking-wider flex-shrink-0 ${live ? "text-sol-red" : "text-sol-text-dim"}`}>
          {live ? "LIVE" : status.kind === "connecting" ? "CONNECTING" : "OFF AIR"}
        </span>
        {tab && (
          <>
            <span className="text-[10px] font-mono text-sol-text-muted truncate">{tab.title || "untitled"}</span>
            {tab.url && (
              <span className="text-[10px] font-mono text-sol-text-dim/70 truncate" title={tab.url}>
                {tab.url}
              </span>
            )}
          </>
        )}
        <span className="flex-1" />
        {status.kind === "failed" && status.canRetry && (
          <button
            onClick={reconnect}
            title="Reconnect"
            className="p-0.5 rounded text-sol-text-dim/50 hover:text-sol-cyan transition-colors"
          >
            <RotateCw className="w-3 h-3" />
          </button>
        )}
        <button
          onClick={close}
          title="Close browser view"
          className="p-0.5 rounded text-sol-text-dim/50 hover:text-sol-text-muted transition-colors"
        >
          <X className="w-3 h-3" />
        </button>
      </div>

      <div className="relative flex-1 min-h-0 bg-sol-bg-inset">
        {frame && (
          <img
            src={frame}
            alt={tab?.title ? `Live view of ${tab.title}` : "Live view of the agent's browser tab"}
            className="absolute inset-0 w-full h-full object-contain"
            draggable={false}
          />
        )}
        {status.kind === "failed" ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-[11px] font-mono text-center px-6 bg-sol-bg/80">
            <span className="text-sol-text-dim">{status.message}</span>
            {status.canRetry && (
              <button
                onClick={reconnect}
                className="px-2 py-0.5 rounded border border-sol-border/40 text-sol-text-muted hover:text-sol-text hover:border-sol-cyan/50 transition-colors"
              >
                Reconnect
              </button>
            )}
          </div>
        ) : status.kind === "connecting" && !frame ? (
          <div className="absolute inset-0 flex items-center justify-center text-[11px] font-mono text-sol-text-dim">
            Opening a live view of the agent's browser…
          </div>
        ) : null}
      </div>

      <SplitResizeHandle onPointerDown={onHandlePointerDown} title="Drag to resize" />
    </div>
  );
}
